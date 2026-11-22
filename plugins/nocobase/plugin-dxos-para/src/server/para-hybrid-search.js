/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const EMBEDDING_DIM = 256;
const STOP_WORDS = new Set(['va', 'cua', 'cho', 'trong', 'voi', 'cac', 'nhung', 'mot', 'tai', 've', 'la', 'co', 'khong', 'duoc', 'bi']);

const readField = (row, key, fallback) => {
  if (!row) return fallback;
  const v = typeof row.get === 'function' ? row.get(key) : row[key];
  return v === undefined ? fallback : v;
};

function stripVietnameseDiacritics(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizeSearchText(input) {
  return stripVietnameseDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9\s/_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeVietnamese(input) {
  return normalizeSearchText(input)
    .split(/[\s/_.-]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function fnv1aHash(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function computeDeterministicEmbedding(text, dim = EMBEDDING_DIM) {
  const vec = new Array(dim).fill(0);
  const norm = normalizeSearchText(text);
  if (!norm) return vec;
  const tokens = norm.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const h1 = fnv1aHash(tok, 2166136261);
    const sign = (h1 & 1) === 0 ? 1 : -1;
    const weight = tok.length >= 3 ? 2.0 : 1.0;
    vec[h1 % dim] += sign * weight;
    if (tok.length >= 3) {
      for (let i = 0; i <= tok.length - 3; i += 1) {
        const tri = tok.slice(i, i + 3);
        const h3 = fnv1aHash(tri, 374761393);
        vec[h3 % dim] += ((h3 & 1) === 0 ? 0.65 : -0.65);
      }
    }
  }
  let magSq = 0;
  for (let i = 0; i < dim; i += 1) magSq += vec[i] * vec[i];
  const mag = Math.sqrt(magSq);
  if (mag > 0) {
    for (let i = 0; i < dim; i += 1) {
      vec[i] = Number((vec[i] / mag).toFixed(6));
    }
  }
  return vec;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

function buildSnippet(text, query, maxLen = 180) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  const tokens = tokenizeVietnamese(query);
  const norm = normalizeSearchText(clean);
  let hitIdx = -1;
  for (const tok of tokens) {
    const idx = norm.indexOf(tok);
    if (idx >= 0) {
      hitIdx = idx;
      break;
    }
  }
  if (hitIdx <= 40) return `${clean.slice(0, maxLen).trim()}…`;
  const start = Math.max(0, hitIdx - 40);
  return `${start > 0 ? '…' : ''}${clean.slice(start, start + maxLen).trim()}${start + maxLen < clean.length ? '…' : ''}`;
}

function extractDocumentSearchText(doc) {
  return normalizeSearchText([
    readField(doc, 'code', ''),
    readField(doc, 'title', ''),
    readField(doc, 'summary', ''),
    readField(doc, 'tags', ''),
    readField(doc, 'contentMarkdown', ''),
  ].filter(Boolean).join(' '));
}

function lexicalOverlapScore(queryNorm, queryTokens, hayNorm, titleNorm) {
  if (!queryNorm) return 1;
  let score = 0;
  if (hayNorm.includes(queryNorm)) score += 6;
  if (titleNorm.includes(queryNorm)) score += 4;
  let matched = 0;
  for (const tok of queryTokens) {
    if (hayNorm.includes(tok)) {
      matched += 1;
      score += titleNorm.includes(tok) ? 2.5 : 1.5;
    }
  }
  if (queryTokens.length > 0 && matched === queryTokens.length) score += 3;
  return score;
}

function rankHybridDocuments(query, docs = [], { limit = 10, k = 60 } = {}) {
  const list = Array.isArray(docs) ? docs : [];
  const cap = Math.max(1, Math.min(30, Number(limit) || 10));
  const queryNorm = normalizeSearchText(query);
  const queryTokens = tokenizeVietnamese(query);
  const queryVec = computeDeterministicEmbedding(queryNorm);

  const enriched = list.map((doc) => {
    const id = readField(doc, 'id', null);
    const code = String(readField(doc, 'code', '') || id || '');
    const title = String(readField(doc, 'title', '') || readField(doc, 'name', '') || code);
    const summary = String(readField(doc, 'summary', '') || '');
    const contentMarkdown = String(readField(doc, 'contentMarkdown', '') || '');
    const paraSpace = String(readField(doc, 'paraSpace', 'resources') || 'resources');
    const organizationId = readField(doc, 'organizationId', null);
    const precomputedNorm = readField(doc, 'searchText', '');
    const hayNorm = precomputedNorm ? normalizeSearchText(precomputedNorm) : extractDocumentSearchText(doc);
    const titleNorm = normalizeSearchText(`${code} ${title}`);
    const lex = lexicalOverlapScore(queryNorm, queryTokens, hayNorm, titleNorm);
    const docVec = Array.isArray(readField(doc, 'embeddingJson', null)) && readField(doc, 'embeddingJson', []).length === EMBEDDING_DIM
      ? readField(doc, 'embeddingJson', [])
      : computeDeterministicEmbedding(hayNorm);
    const pgBoost = Number(readField(doc, '_pgTsRank', 0)) || 0;
    const sem = queryNorm ? cosineSimilarity(queryVec, docVec) : 0;
    const combinedRawText = [summary, contentMarkdown, title].filter(Boolean).join(' · ');
    return {
      doc,
      id,
      code,
      title,
      summary,
      paraSpace,
      organizationId,
      lex: lex + pgBoost * 5,
      sem,
      snippet: buildSnippet(combinedRawText, query),
      citation: `[latticeParaDocuments:${code}#${id} · ${paraSpace}]`,
    };
  });

  if (!queryNorm) {
    return enriched.slice(0, cap).map((e, idx) => ({
      id: e.id,
      code: e.code,
      title: e.title,
      summary: e.summary,
      paraSpace: e.paraSpace,
      organizationId: e.organizationId,
      score: Number((1 / (idx + 1)).toFixed(4)),
      lexicalScore: 0,
      semanticScore: 0,
      snippet: e.snippet,
      citation: e.citation,
    }));
  }

  const filtered = enriched.filter((e) => e.lex > 0 || e.sem >= 0.18);
  const byLex = [...filtered].sort((a, b) => b.lex - a.lex);
  const bySem = [...filtered].sort((a, b) => b.sem - a.sem);
  const lexRank = new Map(byLex.map((e, i) => [e, e.lex > 0 ? i + 1 : filtered.length + 50]));
  const semRank = new Map(bySem.map((e, i) => [e, i + 1]));

  const scored = filtered.map((e) => {
    const rLex = lexRank.get(e);
    const rSem = semRank.get(e);
    const rrf = (e.lex > 0 ? 1 / (k + rLex) : 0) + (1 / (k + rSem));
    const score = Number((rrf * 100 + e.lex * 0.25 + Math.max(0, e.sem) * 2).toFixed(4));
    return {
      id: e.id,
      code: e.code,
      title: e.title,
      summary: e.summary,
      paraSpace: e.paraSpace,
      organizationId: e.organizationId,
      score,
      lexicalScore: Number(e.lex.toFixed(4)),
      semanticScore: Number(e.sem.toFixed(4)),
      snippet: e.snippet,
      citation: e.citation,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, cap);
}

async function executeHybridSearch(db, { organizationId = null, query = '', paraSpace = null, limit = 10 } = {}) {
  const repo = db?.getRepository?.('latticeParaDocuments');
  if (!repo) return [];
  const filter = {
    active: true,
    ...(organizationId ? { organizationId } : {}),
    ...(paraSpace ? { paraSpace } : {}),
  };
  const rows = (await repo.find({ filter, limit: 200, sort: ['-id'] })) || [];
  if (db?.sequelize?.query && normalizeSearchText(query) && rows.length) {
    try {
      const qNorm = normalizeSearchText(query);
      const [tsRows] = await db.sequelize.query(
        'SELECT id, ts_rank_cd("searchVector", plainto_tsquery(\'simple\', :q)) AS rank FROM "latticeParaDocuments" WHERE active = true AND (:org::text IS NULL OR "organizationId" = :org) AND "searchVector" @@ plainto_tsquery(\'simple\', :q) LIMIT 100',
        { replacements: { q: qNorm, org: organizationId || null } },
      );
      if (Array.isArray(tsRows) && tsRows.length) {
        const boostMap = new Map(tsRows.map((r) => [String(r.id), Number(r.rank) || 0]));
        for (const r of rows) {
          const rid = String(readField(r, 'id', ''));
          if (boostMap.has(rid)) r._pgTsRank = boostMap.get(rid);
        }
      }
    } catch {
      // Fall back transparently to JS RRF when running on unit mocks or pre-migration DB
    }
  }
  return rankHybridDocuments(query, rows, { limit });
}

module.exports = {
  EMBEDDING_DIM,
  stripVietnameseDiacritics,
  normalizeSearchText,
  tokenizeVietnamese,
  computeDeterministicEmbedding,
  cosineSimilarity,
  buildSnippet,
  extractDocumentSearchText,
  rankHybridDocuments,
  executeHybridSearch,
};
