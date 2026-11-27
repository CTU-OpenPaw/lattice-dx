/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { runParaRlsOp, runParaSavepoint } = require('./para-scope');

const EMBEDDING_DIM = 256;
const DEFAULT_NEURAL_EMBEDDING_DIM = 1536;
const MAX_EMBEDDING_BATCH_SIZE = 16;
const NEURAL_TIMEOUT_MS = 4500;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const STOP_WORDS = new Set(['va', 'cua', 'cho', 'trong', 'voi', 'cac', 'nhung', 'mot', 'tai', 've', 'la', 'co', 'khong', 'duoc', 'bi']);
const BLOCKED_EMBEDDING_HOST_RE = /^(0\.0\.0\.0|\[?::\]?|\[?::ffff:(?:a9fe:|169\.254\.|64[4-7][0-9a-f]:|0:0).*|169\.254\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|fe[89ab][0-9a-f]:.*|fd00:ec2::254|metadata|metadata\.google\.internal|metadata\.azure\.com)$/i;
const PARA_SECRET_KV_RE = /(\b[a-zA-Z0-9_]*(?:token|secret|password|apikey|api_key|jwt|privateKey|client_secret|access_key|passphrase|credential|authorization|cookie)[ \t]*[:=][ \t]*)(?:"[^"]+"|'[^']+'|[^\s,;}"']+)/gi;

function redactParaBankAccounts(text) {
  return String(text ?? '').replace(
    /(\b(?:stk|số tài khoản|tài khoản ngân hàng|iban)\s*[:#=-]?\s*)([A-Za-z]{2}\d{2}(?:[A-Za-z0-9]{6,30}|(?:[ -][A-Z0-9]{1,8}){1,8})|\d(?:[ -]?\d){7,19})(?![0-9A-Za-z-])/gi,
    (full, prefix, rawAcct) => {
      if (/^[A-Za-z]{2}\d{2}[ -]/.test(rawAcct)) {
        const parts = rawAcct.split(/([ -])/);
        const kept = [parts[0]];
        let i = 1;
        while (i + 1 < parts.length) {
          const sep = parts[i];
          const tok = parts[i + 1];
          if (/\d/.test(tok) || /^[A-Z]{2,4}$/.test(tok)) {
            kept.push(sep, tok);
            i += 2;
          } else {
            break;
          }
        }
        const acctOnly = kept.join('');
        const compactLen = acctOnly.replace(/[ -]/g, '').length;
        if (compactLen < 10) return full;
        const trailing = rawAcct.slice(acctOnly.length);
        return `${prefix}[REDACTED_BANK]${trailing}`;
      }
      return `${prefix}[REDACTED_BANK]`;
    },
  );
}

function redactParaPii(rawText) {
  const input = String(rawText ?? '');
  if (!input) return '';
  let text = input
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]')
    .replace(/(Bearer[ \t]+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]')
    .replace(/\bldx_(?:pat|trk)_[A-Za-z0-9_-]{6,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_KEY]')
    .replace(PARA_SECRET_KV_RE, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(
      /(\b(?:cccd|cmnd|căn cước(?:\s+công dân)?|chứng minh(?:\s+nhân dân)?|số định danh(?:\s+cá nhân)?|id(?:\s*(?:no|number|card))?)\s*[:#=-]?\s*)(?:\d(?:[ .-]?\d){11}|\d(?:[ .-]?\d){8})(?![0-9A-Za-z-])/gi,
      '$1[REDACTED_CCCD]',
    );
  text = redactParaBankAccounts(text)
    .replace(/(\b(?:mst|mã số thuế)\s*[:#=-]?\s*)\d{10}(?:-\d{3})?\b/gi, '$1[REDACTED_MST]')
    .replace(/(?<![0-9A-Za-z.+-])\d{12}(?![0-9A-Za-z-]|\.\d)/g, '[REDACTED_CCCD]')
    .replace(/(?<![0-9A-Za-z.-])(?:(?:\+?84[\s.-]?\d(?:[\s.-]?\d){8,9})|(?:0\d(?:[\s.-]?\d){8,9}))(?![0-9A-Za-z-])/g, '[REDACTED_PHONE]');
  return text;
}

const readField = (row, key, fallback) => {
  if (!row) return fallback;
  const v = typeof row.get === 'function' ? row.get(key) : row[key];
  return v === undefined ? fallback : v;
};

function isDocStatusActive(row) {
  const st = readField(row, 'status', null);
  if (st == null || String(st).trim() === '') return true;
  return String(st).trim().toLowerCase() === 'active';
}

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

function resolveEmbeddingEndpoint(env = process.env) {
  const direct = String(env?.DXOS_EMBEDDING_URL || env?.DX_EMBEDDING_URL || '').trim();
  const base = String(env?.AGENT_BASE_URL || '').trim();
  let candidate = direct;
  if (!candidate && base) {
    const cleanBase = base.replace(/\/+$/, '');
    candidate = cleanBase.endsWith('/embeddings') ? cleanBase : `${cleanBase}/embeddings`;
  }
  if (!candidate) return null;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '');
  if (!bareHost || BLOCKED_EMBEDDING_HOST_RE.test(host) || BLOCKED_EMBEDDING_HOST_RE.test(bareHost)) {
    return null;
  }

  return {
    url: parsed.toString(),
    model: String(env?.DXOS_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL).trim() || DEFAULT_EMBEDDING_MODEL,
    apiKey: String(env?.DXOS_EMBEDDING_API_KEY || env?.AGENT_API_KEY || env?.NINE_ROUTER_API_KEY || '').trim(),
  };
}

function resolveEmbeddingDim(env = process.env) {
  const raw = String(env?.DX_EMBEDDING_DIM ?? env?.DXOS_EMBEDDING_DIM ?? '').trim();
  if (!raw) return DEFAULT_NEURAL_EMBEDDING_DIM;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 8 || parsed > 8192) {
    return DEFAULT_NEURAL_EMBEDDING_DIM;
  }
  return parsed;
}

function hasExplicitEmbeddingDim(env = process.env) {
  const raw = String(env?.DX_EMBEDDING_DIM ?? env?.DXOS_EMBEDDING_DIM ?? '').trim();
  if (!raw) return false;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 8 && parsed <= 8192;
}

function deterministicFallbackResult(text) {
  return {
    vector: computeDeterministicEmbedding(text),
    dim: EMBEDDING_DIM,
    model: 'fnv1a-256',
    engine: 'deterministic-fallback',
  };
}

function normalizeNeuralVector(rawVec) {
  if (!Array.isArray(rawVec) || rawVec.length < 8 || rawVec.length > 8192) {
    return null;
  }
  const vector = new Array(rawVec.length);
  let magSq = 0;
  for (let i = 0; i < rawVec.length; i += 1) {
    const n = Number(rawVec[i]);
    if (!Number.isFinite(n)) return null;
    vector[i] = n;
    magSq += n * n;
  }
  if (magSq <= 0) return null;
  return vector;
}

async function computeNeuralEmbeddingsBatch(texts = [], {
  env = process.env,
  fetchImpl = globalThis.fetch,
  batchSize = MAX_EMBEDDING_BATCH_SIZE,
} = {}) {
  const items = Array.isArray(texts) ? texts : [texts];
  if (!items.length) return [];

  const safeBatchSize = Math.max(1, Math.min(MAX_EMBEDDING_BATCH_SIZE, Number(batchSize) || MAX_EMBEDDING_BATCH_SIZE));
  const endpoint = resolveEmbeddingEndpoint(env);
  if (!endpoint || typeof fetchImpl !== 'function') {
    return items.map((t) => deterministicFallbackResult(String(t || '').trim()));
  }

  const targetDim = hasExplicitEmbeddingDim(env) ? resolveEmbeddingDim(env) : null;
  const results = new Array(items.length);

  for (let start = 0; start < items.length; start += safeBatchSize) {
    const end = Math.min(items.length, start + safeBatchSize);
    const activeIndices = [];
    const activeInputs = [];

    for (let idx = start; idx < end; idx += 1) {
      const cleanText = String(items[idx] || '').trim();
      if (!cleanText) {
        results[idx] = deterministicFallbackResult('');
      } else {
        activeIndices.push(idx);
        activeInputs.push(cleanText.slice(0, 8000));
      }
    }

    if (!activeInputs.length) continue;

    try {
      const headers = { 'content-type': 'application/json' };
      if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
      const bodyPayload = {
        model: endpoint.model,
        input: activeInputs,
        ...(targetDim ? { dimensions: targetDim } : {}),
      };
      const res = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        redirect: 'error',
        signal: AbortSignal.timeout(NEURAL_TIMEOUT_MS),
      });
      if (!res || !res.ok) {
        for (let k = 0; k < activeIndices.length; k += 1) {
          results[activeIndices[k]] = deterministicFallbackResult(activeInputs[k]);
        }
        continue;
      }

      const payload = await res.json();
      const rawByPos = new Array(activeInputs.length).fill(null);
      if (Array.isArray(payload?.data)) {
        payload.data.forEach((entry, seqIdx) => {
          const pos = Number.isInteger(entry?.index) && entry.index >= 0 && entry.index < activeInputs.length
            ? entry.index
            : seqIdx;
          if (pos >= 0 && pos < activeInputs.length) {
            rawByPos[pos] = entry?.embedding ?? entry?.vector ?? null;
          }
        });
      } else if (Array.isArray(payload?.embeddings)) {
        for (let pos = 0; pos < activeInputs.length; pos += 1) {
          rawByPos[pos] = payload.embeddings[pos] ?? null;
        }
      } else if (activeInputs.length === 1 && (payload?.embedding || payload?.vector)) {
        rawByPos[0] = payload.embedding || payload.vector;
      }

      const modelName = String(payload?.model || endpoint.model);
      for (let k = 0; k < activeIndices.length; k += 1) {
        const vector = normalizeNeuralVector(rawByPos[k]);
        if (vector) {
          results[activeIndices[k]] = {
            vector,
            dim: vector.length,
            model: modelName,
            engine: 'neural',
          };
        } else {
          results[activeIndices[k]] = deterministicFallbackResult(activeInputs[k]);
        }
      }
    } catch {
      for (let k = 0; k < activeIndices.length; k += 1) {
        results[activeIndices[k]] = deterministicFallbackResult(activeInputs[k]);
      }
    }
  }

  return results;
}

async function computeNeuralEmbedding(text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return deterministicFallbackResult('');

  const endpoint = resolveEmbeddingEndpoint(env);
  if (!endpoint || typeof fetchImpl !== 'function') {
    return deterministicFallbackResult(cleanText);
  }

  const targetDim = hasExplicitEmbeddingDim(env) ? resolveEmbeddingDim(env) : null;
  try {
    const headers = { 'content-type': 'application/json' };
    if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
    const bodyPayload = {
      model: endpoint.model,
      input: cleanText.slice(0, 8000),
      ...(targetDim ? { dimensions: targetDim } : {}),
    };
    const res = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      redirect: 'error',
      signal: AbortSignal.timeout(NEURAL_TIMEOUT_MS),
    });
    if (!res || !res.ok) return deterministicFallbackResult(cleanText);

    const payload = await res.json();
    const rawVec = payload?.data?.[0]?.embedding || payload?.embeddings?.[0] || payload?.embedding || payload?.vector;
    const vector = normalizeNeuralVector(rawVec);
    if (!vector) {
      return deterministicFallbackResult(cleanText);
    }

    return {
      vector,
      dim: vector.length,
      model: String(payload?.model || endpoint.model),
      engine: 'neural',
    };
  } catch {
    return deterministicFallbackResult(cleanText);
  }
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

function escapeSearchRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lexicalOverlapScore(queryNorm, queryTokens, hayNorm, titleNorm) {
  if (!queryNorm) return 1;
  const hayText = String(hayNorm || '');
  const titleText = String(titleNorm || '');
  const hayTokens = new Set(hayText.split(/[\s/_.-]+/).filter(Boolean));
  const titleTokens = new Set(titleText.split(/[\s/_.-]+/).filter(Boolean));
  let score = 0;
  if (queryTokens.length <= 1 && !/[\s/_.-]/.test(queryNorm)) {
    if (hayTokens.has(queryNorm)) score += 6;
    if (titleTokens.has(queryNorm)) score += 4;
  } else {
    const phraseRe = new RegExp(`(?:^|[\\s/_.-])${escapeSearchRegExp(queryNorm)}(?:$|[\\s/_.-])`);
    if (phraseRe.test(hayText)) score += 6;
    if (phraseRe.test(titleText)) score += 4;
  }
  let matched = 0;
  for (const tok of queryTokens) {
    if (hayTokens.has(tok)) {
      matched += 1;
      score += titleTokens.has(tok) ? 2.5 : 1.5;
    }
  }
  if (queryTokens.length > 0 && matched === queryTokens.length) score += 3;
  return score;
}

function scoreRrfEntries(entries, queryNorm, cap, k = 60) {
  if (!queryNorm) {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      const docKey = String(e.id);
      if (seen.has(docKey)) continue;
      seen.add(docKey);
      out.push({
        id: e.id,
        code: e.code,
        title: e.title,
        summary: redactParaPii(e.summary),
        paraSpace: e.paraSpace,
        organizationId: e.organizationId,
        ...(e.isChunk ? {
          chunkId: e.chunkId,
          documentId: e.id,
          sectionTitle: e.sectionTitle,
          pageNumber: e.pageNumber,
          chunkIndex: e.chunkIndex,
        } : {}),
        embeddingEngine: e.embeddingEngine,
        score: Number((1 / (out.length + 1)).toFixed(4)),
        lexicalScore: 0,
        semanticScore: 0,
        snippet: redactParaPii(e.snippet),
        citation: e.citation,
      });
      if (out.length >= cap) break;
    }
    return out;
  }

  const filtered = entries.filter((e) => e.lex > 0 || (e.embeddingEngine === 'neural' && e.sem >= 0.18));
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
      summary: redactParaPii(e.summary),
      paraSpace: e.paraSpace,
      organizationId: e.organizationId,
      ...(e.isChunk ? {
        chunkId: e.chunkId,
        documentId: e.id,
        sectionTitle: e.sectionTitle,
        pageNumber: e.pageNumber,
        chunkIndex: e.chunkIndex,
      } : {}),
      embeddingEngine: e.embeddingEngine,
      score,
      lexicalScore: Number(e.lex.toFixed(4)),
      semanticScore: Number(e.sem.toFixed(4)),
      snippet: redactParaPii(e.snippet),
      citation: e.citation,
      _isChunk: e.isChunk,
    };
  });

  scored.sort((a, b) => (b.score - a.score) || ((b._isChunk ? 1 : 0) - (a._isChunk ? 1 : 0)));
  const deduped = [];
  const seenDocs = new Set();
  for (const item of scored) {
    const docKey = String(item.id);
    if (seenDocs.has(docKey)) continue;
    seenDocs.add(docKey);
    const { _isChunk, ...cleanItem } = item;
    deduped.push(cleanItem);
    if (deduped.length >= cap) break;
  }
  return deduped;
}

function buildDocCandidate(doc, query, queryNorm, queryTokens, queryVec) {
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
  const storedVec = readField(doc, 'embeddingJson', null);
  const docVec = Array.isArray(storedVec) && storedVec.length === EMBEDDING_DIM
    ? storedVec
    : computeDeterministicEmbedding(hayNorm);
  const pgBoost = Number(readField(doc, '_pgTsRank', 0)) || 0;
  const sem = queryNorm ? cosineSimilarity(queryVec, docVec) : 0;
  const combinedRawText = redactParaPii([summary, contentMarkdown, title].filter(Boolean).join(' · '));
  return {
    isChunk: false,
    id,
    code,
    title: redactParaPii(title),
    summary: redactParaPii(summary),
    paraSpace,
    organizationId,
    embeddingEngine: 'deterministic-fallback',
    lex: lex + pgBoost * 5,
    sem,
    snippet: buildSnippet(combinedRawText, query),
    citation: `[latticeParaDocuments:${code}#${id} · ${paraSpace}]`,
  };
}

function buildChunkCandidate(chunk, docById, query, queryNorm, queryTokens, queryEmb, detQueryVec) {
  const chunkId = readField(chunk, 'id', null);
  const documentId = readField(chunk, 'documentId', null);
  const parentDoc = docById.get(String(documentId)) || null;
  const code = String(readField(chunk, 'code', '') || readField(parentDoc, 'code', '') || documentId || '');
  const title = String(readField(chunk, 'title', '') || readField(parentDoc, 'title', '') || code);
  const summary = String(readField(parentDoc, 'summary', '') || '');
  const paraSpace = String(readField(chunk, 'paraSpace', '') || readField(parentDoc, 'paraSpace', 'resources') || 'resources');
  const organizationId = readField(chunk, 'organizationId', null);
  const chunkIndex = Math.max(0, Number(readField(chunk, 'chunkIndex', 0)) || 0);
  const sectionTitle = String(readField(chunk, 'sectionTitle', '') || '');
  const pageNumber = Math.max(1, Number(readField(chunk, 'pageNumber', 1)) || 1);
  const content = String(readField(chunk, 'content', '') || '');
  const hayNorm = normalizeSearchText([code, title, sectionTitle, content].filter(Boolean).join(' '));
  const titleNorm = normalizeSearchText(`${code} ${title} ${sectionTitle}`);
  const lex = lexicalOverlapScore(queryNorm, queryTokens, hayNorm, titleNorm);
  const pgTsRank = Number(readField(chunk, '_pgTsRank', readField(chunk, 'pgTsRank', 0))) || 0;
  const pgVectorSimRaw = readField(chunk, '_pgVectorSim', readField(chunk, 'pgVectorSim', null));
  const hasPgVectorSim = pgVectorSimRaw != null && Number.isFinite(Number(pgVectorSimRaw));
  const storedVec = readField(chunk, 'embeddingJson', null);

  let sem = 0;
  let embeddingEngine = 'deterministic-fallback';
  if (queryNorm) {
    if (hasPgVectorSim && queryEmb.engine === 'neural') {
      sem = Number(pgVectorSimRaw);
      embeddingEngine = 'neural';
    } else if (queryEmb.engine === 'neural' && Array.isArray(storedVec) && storedVec.length === queryEmb.dim) {
      sem = cosineSimilarity(queryEmb.vector, storedVec);
      embeddingEngine = 'neural';
    } else {
      const detChunkVec = Array.isArray(storedVec) && storedVec.length === EMBEDDING_DIM
        ? storedVec
        : computeDeterministicEmbedding(hayNorm);
      sem = cosineSimilarity(detQueryVec, detChunkVec);
      embeddingEngine = 'deterministic-fallback';
    }
  }

  const redactedSummary = redactParaPii(summary);
  const redactedTitle = redactParaPii(title);
  const redactedSnippetSource = redactParaPii(content) || [redactedSummary, redactedTitle].filter(Boolean).join(' · ');
  return {
    isChunk: true,
    chunkId,
    id: documentId,
    code,
    title: redactedTitle,
    summary: redactedSummary,
    paraSpace,
    organizationId,
    sectionTitle: redactParaPii(sectionTitle),
    pageNumber,
    chunkIndex,
    embeddingEngine,
    lex: lex + pgTsRank * 5,
    sem,
    snippet: buildSnippet(redactedSnippetSource, query),
    citation: `[latticeParaDocuments:${code}#${documentId} · đoạn #${chunkIndex + 1}]`,
  };
}

function rankHybridDocuments(query, docs = [], { limit = 10, k = 60 } = {}) {
  const list = (Array.isArray(docs) ? docs : []).filter((doc) => (
    readField(doc, 'active', true) !== false && isDocStatusActive(doc)
  ));
  const cap = Math.max(1, Math.min(30, Number(limit) || 10));
  const queryNorm = normalizeSearchText(query);
  const queryTokens = tokenizeVietnamese(query);
  const queryVec = computeDeterministicEmbedding(queryNorm);
  const enriched = list.map((doc) => buildDocCandidate(doc, query, queryNorm, queryTokens, queryVec));
  return scoreRrfEntries(enriched, queryNorm, cap, k);
}

async function fetchChunkCandidates(db, { organizationId, paraSpace, queryNorm, queryRaw, queryEmb, transaction = undefined }) {
  const chunkRepo = db?.getRepository?.('latticeParaChunks');
  const txOpt = transaction ? { transaction } : {};
  const byKey = new Map();
  const keyFor = (row) => {
    const rid = readField(row, 'id', null);
    if (rid != null) return `id:${rid}`;
    return `doc:${readField(row, 'documentId', '')}:${readField(row, 'chunkIndex', 0)}`;
  };
  const mergeRow = (row) => {
    const rowOrg = readField(row, 'organizationId', null);
    const rowSpace = readField(row, 'paraSpace', null);
    if (organizationId && rowOrg !== organizationId) return;
    if (paraSpace && rowSpace !== paraSpace) return;
    if (readField(row, 'active', true) === false) return;
    const key = keyFor(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...(typeof row?.toJSON === 'function' ? row.toJSON() : row) });
      return;
    }
    const tsRank = Number(readField(row, '_pgTsRank', readField(row, 'pgTsRank', 0))) || 0;
    const vecSim = readField(row, '_pgVectorSim', readField(row, 'pgVectorSim', null));
    if (tsRank > 0) existing._pgTsRank = Math.max(existing._pgTsRank || 0, tsRank);
    if (vecSim != null && Number.isFinite(Number(vecSim))) existing._pgVectorSim = Number(vecSim);
  };

  if (db?.sequelize?.query && queryNorm) {
    if (
      queryEmb.engine === 'neural'
      && queryEmb.dim >= 8
      && queryEmb.dim <= 8192
      && queryEmb.vector.every(Number.isFinite)
    ) {
      try {
        const vecLiteral = `[${queryEmb.vector.map((n) => Number(n)).join(',')}]`;
        const [vecRows] = await runParaSavepoint(db, (spTx) => db.sequelize.query(
          `SELECT id, "documentId", "organizationId", code, title, "paraSpace",
                  "chunkIndex", "sectionTitle", "pageNumber", content, "tokenCount",
                  "embeddingModel", "embeddingEngine", "embeddingDim", "embeddingJson",
                  1 - (embedding <=> CAST(:vec AS vector)) AS "pgVectorSim"
           FROM "latticeParaChunks"
           WHERE active = true
             AND embedding IS NOT NULL
             AND "embeddingDim" = :dim
             AND (:org::text IS NULL OR "organizationId" = :org)
             AND (:paraSpace::text IS NULL OR "paraSpace" = :paraSpace)
             AND NOT EXISTS (
               SELECT 1 FROM "latticeParaDocuments" d
               WHERE d.id = "latticeParaChunks"."documentId"
                 AND (d.active = false OR (d.status IS NOT NULL AND d.status <> 'active'))
             )
           ORDER BY embedding <=> CAST(:vec AS vector) ASC
           LIMIT 200`,
          {
            replacements: { vec: vecLiteral, dim: queryEmb.dim, org: organizationId || null, paraSpace: paraSpace || null },
            ...((spTx || transaction) ? { transaction: spTx || transaction } : {}),
          },
        ));
        if (Array.isArray(vecRows)) {
          for (const r of vecRows) mergeRow(r);
        }
      } catch {
        // Plain Postgres without pgvector or unit mock: ignore cleanly
      }
    }

    try {
      const qRaw = String(queryRaw || queryNorm || '').trim().toLowerCase();
      const [tsRows] = await runParaSavepoint(db, (spTx) => db.sequelize.query(
        `SELECT id, "documentId", "organizationId", code, title, "paraSpace",
                "chunkIndex", "sectionTitle", "pageNumber", content, "tokenCount",
                "embeddingModel", "embeddingEngine", "embeddingDim", "embeddingJson",
                (ts_rank_cd("searchVector", plainto_tsquery('simple', :qNorm)) + ts_rank_cd("searchVector", plainto_tsquery('simple', :qRaw))) AS "pgTsRank"
         FROM "latticeParaChunks"
         WHERE active = true
           AND (:org::text IS NULL OR "organizationId" = :org)
           AND (:paraSpace::text IS NULL OR "paraSpace" = :paraSpace)
           AND NOT EXISTS (
             SELECT 1 FROM "latticeParaDocuments" d
             WHERE d.id = "latticeParaChunks"."documentId"
               AND (d.active = false OR (d.status IS NOT NULL AND d.status <> 'active'))
           )
           AND ("searchVector" @@ plainto_tsquery('simple', :qNorm) OR "searchVector" @@ plainto_tsquery('simple', :qRaw))
         ORDER BY "pgTsRank" DESC
         LIMIT 200`,
        {
          replacements: { qNorm: queryNorm, qRaw, org: organizationId || null, paraSpace: paraSpace || null },
          ...((spTx || transaction) ? { transaction: spTx || transaction } : {}),
        },
      ));
      if (Array.isArray(tsRows)) {
        for (const r of tsRows) mergeRow(r);
      }
    } catch {
      // Fallback transparently when running on mocks or pre-migration DB
    }
  }

  if (chunkRepo && typeof chunkRepo.find === 'function') {
    const chunkFilter = {
      active: true,
      ...(organizationId ? { organizationId } : {}),
      ...(paraSpace ? { paraSpace } : {}),
    };
    const ormRows = (await chunkRepo.find({ filter: chunkFilter, limit: 500, sort: ['documentId', 'chunkIndex'], ...txOpt })) || [];
    for (const r of ormRows) mergeRow(r);
  }

  return [...byKey.values()];
}

async function executeHybridSearch(db, {
  organizationId = null,
  query = '',
  paraSpace = null,
  limit = 10,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const docRepo = db?.getRepository?.('latticeParaDocuments');
  const chunkRepo = db?.getRepository?.('latticeParaChunks');
  if (!docRepo && !chunkRepo) return [];

  const cap = Math.max(1, Math.min(30, Number(limit) || 10));
  const queryRaw = String(query || '').trim().toLowerCase();
  const queryNorm = normalizeSearchText(query);
  const queryTokens = tokenizeVietnamese(query);
  // Outbound neural embedding request runs strictly outside any DB transaction.
  const queryEmb = queryNorm
    ? await computeNeuralEmbedding(query, { env, fetchImpl })
    : deterministicFallbackResult('');
  const detQueryVec = queryEmb.engine === 'deterministic-fallback' && queryEmb.dim === EMBEDDING_DIM
    ? queryEmb.vector
    : computeDeterministicEmbedding(queryNorm);

  const { chunkRows, docRows, inactiveDocIds } = await runParaRlsOp(db, organizationId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const fetchedChunks = await fetchChunkCandidates(db, {
      organizationId,
      paraSpace,
      queryNorm,
      queryRaw,
      queryEmb,
      transaction,
    });
    const docFilter = {
      ...(organizationId ? { organizationId } : {}),
    };
    const rawDocRows = docRepo && typeof docRepo.find === 'function'
      ? ((await docRepo.find({ filter: docFilter, limit: 1000, sort: ['-id'], ...txOpt })) || [])
      : [];
    const inactiveIds = new Set();
    const filteredDocs = [];
    for (const d of rawDocRows) {
      const did = readField(d, 'id', null);
      if (readField(d, 'active', true) === false || !isDocStatusActive(d)) {
        if (did != null) inactiveIds.add(String(did));
        continue;
      }
      if (organizationId && readField(d, 'organizationId', null) !== organizationId) continue;
      if (paraSpace && readField(d, 'paraSpace', null) !== paraSpace) {
        if (did != null) inactiveIds.add(String(did));
        continue;
      }
      filteredDocs.push(d);
    }

    if (db?.sequelize?.query && queryNorm && filteredDocs.length) {
      try {
        const [tsRows] = await runParaSavepoint(db, (spTx) => db.sequelize.query(
          'SELECT id, ts_rank_cd("searchVector", plainto_tsquery(\'simple\', :q)) AS rank FROM "latticeParaDocuments" WHERE active = true AND (status IS NULL OR status = \'active\') AND (:org::text IS NULL OR "organizationId" = :org) AND "searchVector" @@ plainto_tsquery(\'simple\', :q) LIMIT 100',
          {
            replacements: { q: queryNorm, org: organizationId || null },
            ...((spTx || transaction) ? { transaction: spTx || transaction } : {}),
          },
        ));
        if (Array.isArray(tsRows) && tsRows.length) {
          const boostMap = new Map(tsRows.map((r) => [String(r.id), Number(r.rank) || 0]));
          for (const r of filteredDocs) {
            const rid = String(readField(r, 'id', ''));
            if (boostMap.has(rid)) r._pgTsRank = boostMap.get(rid);
          }
        }
      } catch {
        // Fall back transparently to JS RRF when running on unit mocks or pre-migration DB
      }
    }

    return { chunkRows: fetchedChunks, docRows: filteredDocs, inactiveDocIds: inactiveIds };
  });

  const docById = new Map();
  for (const d of docRows) {
    const did = readField(d, 'id', null);
    if (did != null) docById.set(String(did), d);
  }

  const chunkedDocIds = new Set();
  const candidates = [];
  for (const chunk of chunkRows) {
    const did = readField(chunk, 'documentId', null);
    if (did != null && inactiveDocIds.has(String(did))) continue;
    const parentDoc = did != null ? docById.get(String(did)) || null : null;
    if (parentDoc && !isDocStatusActive(parentDoc)) continue;
    if (did != null) chunkedDocIds.add(String(did));
    candidates.push(buildChunkCandidate(chunk, docById, query, queryNorm, queryTokens, queryEmb, detQueryVec));
  }

  for (const doc of docRows) {
    const did = readField(doc, 'id', null);
    if (did != null && chunkedDocIds.has(String(did))) continue;
    candidates.push(buildDocCandidate(doc, query, queryNorm, queryTokens, detQueryVec));
  }

  return scoreRrfEntries(candidates, queryNorm, cap);
}

module.exports = {
  EMBEDDING_DIM,
  DEFAULT_NEURAL_EMBEDDING_DIM,
  MAX_EMBEDDING_BATCH_SIZE,
  NEURAL_TIMEOUT_MS,
  stripVietnameseDiacritics,
  normalizeSearchText,
  tokenizeVietnamese,
  computeDeterministicEmbedding,
  resolveEmbeddingDim,
  resolveEmbeddingEndpoint,
  computeNeuralEmbedding,
  computeNeuralEmbeddingsBatch,
  cosineSimilarity,
  redactParaPii,
  buildSnippet,
  extractDocumentSearchText,
  rankHybridDocuments,
  executeHybridSearch,
};
