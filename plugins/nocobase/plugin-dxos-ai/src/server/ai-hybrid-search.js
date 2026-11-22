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

function computeEmbedding(text, dim = EMBEDDING_DIM) {
  const vec = new Array(dim).fill(0);
  const norm = normalizeSearchText(text);
  if (!norm) return vec;
  const tokens = norm.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const h1 = fnv1aHash(tok, 2166136261);
    const sign = (h1 & 1) === 0 ? 1 : -1;
    vec[h1 % dim] += sign * (tok.length >= 3 ? 2.0 : 1.0);
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
    for (let i = 0; i < dim; i += 1) vec[i] = Number((vec[i] / mag).toFixed(6));
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

function buildSnippet(text, queryOrMaxLen = 160, maybeMaxLen = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const hasQuery = typeof queryOrMaxLen === 'string';
  const maxLen = hasQuery ? maybeMaxLen : (Number(queryOrMaxLen) || 160);
  if (clean.length <= maxLen) return clean;
  if (hasQuery && queryOrMaxLen.trim()) {
    const tokens = tokenizeVietnamese(queryOrMaxLen);
    const norm = normalizeSearchText(clean);
    let hitIdx = -1;
    for (const tok of tokens) {
      const idx = norm.indexOf(tok);
      if (idx >= 0) {
        hitIdx = idx;
        break;
      }
    }
    if (hitIdx > 40) {
      const start = Math.max(0, hitIdx - 40);
      return `${start > 0 ? '…' : ''}${clean.slice(start, start + maxLen).trim()}${start + maxLen < clean.length ? '…' : ''}`;
    }
  }
  return `${clean.slice(0, maxLen).trim()}…`;
}

function buildParaChunkPoolEntries(chunks = [], { organizationId, visibleDocMap = new Map(), ownOnly = false, val } = {}) {
  const read = typeof val === 'function' ? val : (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);
  const entries = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk || read(chunk, 'organizationId') !== organizationId) continue;
    if (read(chunk, 'active') === false) continue;

    const docId = read(chunk, 'documentId');
    const parentDoc = docId != null ? (visibleDocMap.get(String(docId)) || null) : null;
    if (ownOnly && !parentDoc) continue;

    const chunkId = read(chunk, 'id');
    const code = String(read(chunk, 'code') || (parentDoc ? read(parentDoc, 'code') : '') || docId || chunkId || '');
    const docTitle = String(read(chunk, 'title') || (parentDoc ? read(parentDoc, 'title') : '') || code);
    const sectionTitle = String(read(chunk, 'sectionTitle') || '').trim();
    const chunkIndex = read(chunk, 'chunkIndex') != null ? Number(read(chunk, 'chunkIndex')) : 0;
    const pageNumber = read(chunk, 'pageNumber') != null ? Number(read(chunk, 'pageNumber')) : 1;
    const paraSpace = String(read(chunk, 'paraSpace') || (parentDoc ? read(parentDoc, 'paraSpace') : '') || 'resources');
    const content = String(read(chunk, 'content') || '').trim();
    if (!content) continue;

    const targetDocId = docId != null ? docId : chunkId;
    const sectionTag = sectionTitle ? `${sectionTitle} · đoạn #${chunkIndex + 1}` : `đoạn #${chunkIndex + 1}`;
    const item = {
      collection: 'latticeParaChunks',
      id: chunkId,
      documentId: docId ?? null,
      code,
      title: sectionTitle ? `${docTitle} — ${sectionTitle}` : docTitle,
      sectionTitle: sectionTitle || null,
      chunkIndex,
      pageNumber,
      status: (parentDoc ? read(parentDoc, 'status') : null) || paraSpace,
      paraSpace,
      paraCitation: `[latticeParaDocuments:${code}#${targetDocId} · ${paraSpace} · ${sectionTag}]`,
      citation: `[latticeParaDocuments:${code}#${targetDocId} · ${sectionTag}]`,
    };
    entries.push({
      item,
      titleText: `${code} ${docTitle} ${sectionTitle}`.trim(),
      hayText: `${docTitle} ${sectionTitle} ${code} ${content}`.trim(),
      rawSummary: content,
      embedding: read(chunk, 'embeddingJson'),
    });
  }
  return entries;
}

function rankHybridRecords(query, candidates = [], { limit = 8, k = 60 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const cap = Math.max(1, Math.min(30, Number(limit) || 8));
  const queryNorm = normalizeSearchText(query);
  if (!queryNorm) {
    return list.slice(0, cap).map((c) => c.item);
  }
  const queryTokens = tokenizeVietnamese(query);
  const queryVec = computeEmbedding(queryNorm);

  const scoredPool = [];
  for (const cand of list) {
    const hayNorm = normalizeSearchText(cand.hayText);
    const titleNorm = normalizeSearchText(cand.titleText);
    let lex = 0;
    if (hayNorm.includes(queryNorm)) lex += 6;
    if (titleNorm.includes(queryNorm)) lex += 4;
    let matched = 0;
    for (const tok of queryTokens) {
      if (hayNorm.includes(tok)) {
        matched += 1;
        lex += titleNorm.includes(tok) ? 2.5 : 1.5;
      }
    }
    if (queryTokens.length > 0 && matched === queryTokens.length) lex += 3;
    const vec = Array.isArray(cand.embedding) && cand.embedding.length === EMBEDDING_DIM
      ? cand.embedding
      : computeEmbedding(hayNorm);
    const sem = cosineSimilarity(queryVec, vec);
    if (lex > 0 || sem >= 0.24) {
      scoredPool.push({ cand, lex, sem });
    }
  }

  const byLex = [...scoredPool].sort((a, b) => b.lex - a.lex);
  const bySem = [...scoredPool].sort((a, b) => b.sem - a.sem);
  const lexRank = new Map(byLex.map((e, i) => [e, e.lex > 0 ? i + 1 : scoredPool.length + 50]));
  const semRank = new Map(bySem.map((e, i) => [e, i + 1]));

  const ranked = scoredPool.map((e) => {
    const rLex = lexRank.get(e);
    const rSem = semRank.get(e);
    const rrf = (e.lex > 0 ? 1 / (k + rLex) : 0) + (1 / (k + rSem));
    const score = Number((rrf * 100 + e.lex * 0.25 + Math.max(0, e.sem) * 2).toFixed(4));
    return {
      ...e.cand.item,
      score,
      snippet: buildSnippet(e.cand.rawSummary, query),
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, cap);
}

module.exports = {
  normalizeSearchText,
  rankHybridRecords,
  buildParaChunkPoolEntries,
};
