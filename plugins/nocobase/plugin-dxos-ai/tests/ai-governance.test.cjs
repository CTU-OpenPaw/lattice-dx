/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

test('Vietnamese PII redactor strips CCCD, phone, email, STK bank, MST and JWT without breaking business codes or URNs', () => {
  const {
    redactPiiText,
    redactPiiDeep,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));

  const input = [
    'Nhân viên CCCD: 079095012345,',
    'SĐT +84 912-345-678 và 0987654321,',
    'Email nguyen.van.a@enterprise.vn,',
    'STK: 19034567890123, MST: 0312345678-001,',
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload123.sig123.',
    'Giữ nguyên ORD-2026-001, SRV-E2E-123, [latticeOrders:ORD-1#12], urn:ngsi-ld:Asset:native-ui-lab:native:12, 2026-11-22T14:00:00Z.',
  ].join(' ');

  const { text, count } = redactPiiText(input);
  assert.ok(count >= 6, `Expected >=6 PII hits redacted, got ${count}`);
  assert.equal(text.includes('079095012345'), false);
  assert.equal(text.includes('912-345-678'), false);
  assert.equal(text.includes('0987654321'), false);
  assert.equal(text.includes('nguyen.van.a@enterprise.vn'), false);
  assert.equal(text.includes('19034567890123'), false);
  assert.equal(text.includes('0312345678-001'), false);
  assert.equal(text.includes('payload123'), false);

  assert.match(text, /\[REDACTED_CCCD\]/);
  assert.match(text, /\[REDACTED_PHONE\]/);
  assert.match(text, /\[REDACTED_EMAIL\]/);
  assert.match(text, /\[REDACTED_BANK\]/);
  assert.match(text, /\[REDACTED_MST\]/);

  // Business codes, timestamps, and URNs remain intact
  assert.equal(text.includes('ORD-2026-001'), true);
  assert.equal(text.includes('SRV-E2E-123'), true);
  assert.equal(text.includes('[latticeOrders:ORD-1#12]'), true);
  assert.equal(text.includes('urn:ngsi-ld:Asset:native-ui-lab:native:12'), true);
  assert.equal(text.includes('2026-11-22T14:00:00Z'), true);

  const deep = redactPiiDeep({
    note: 'Liên hệ 0912345678 hoặc a@b.vn',
    token: 'sk-secretvalue',
    nested: ['CCCD 079123456789'],
  });
  assert.equal(deep.value.token, '[REDACTED]');
  assert.equal(deep.value.note.includes('0912345678'), false);
  assert.equal(deep.value.nested[0].includes('079123456789'), false);
  assert.ok(deep.count >= 3);
});

test('AI quota engine tracks per-org and per-user daily limits, isolates tenants, and rejects 429 on breach', () => {
  const {
    estimateTokens,
    estimateCostUsd,
    checkAndConsumeAiQuota,
    recordQuotaUsage,
    getQuotaSummary,
    resetQuotaBuckets,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));

  resetQuotaBuckets();
  const env = {
    DXOS_AI_DAILY_ORG_CALL_LIMIT: '3',
    DXOS_AI_DAILY_USER_CALL_LIMIT: '2',
    DXOS_AI_DAILY_ORG_TOKEN_LIMIT: '50000',
    DXOS_AI_DAILY_ORG_USD_LIMIT: '10',
  };

  assert.ok(estimateTokens('Kiểm tra tồn kho lạnh hôm nay') >= 5);
  assert.ok(estimateCostUsd(500, 300, 'ag/gemini-3.8-flash') > 0);

  const actorA1 = { userId: 10, organizationId: 'org-a' };
  const actorA2 = { userId: 11, organizationId: 'org-a' };
  const actorB1 = { userId: 20, organizationId: 'org-b' };

  checkAndConsumeAiQuota(actorA1, { estimatedPromptTokens: 20, env });
  recordQuotaUsage(actorA1, { promptTokens: 20, completionTokens: 40, costUsd: 0.001, piiRedactedCount: 1 });
  checkAndConsumeAiQuota(actorA1, { estimatedPromptTokens: 20, env });
  recordQuotaUsage(actorA1, { promptTokens: 20, completionTokens: 40, costUsd: 0.001, piiRedactedCount: 0 });

  // User 10 in org-a hits DXOS_AI_DAILY_USER_CALL_LIMIT=2 -> 429
  assert.throws(
    () => checkAndConsumeAiQuota(actorA1, { estimatedPromptTokens: 20, env }),
    (err) => err.status === 429 && err.code === 'AI_QUOTA_EXCEEDED',
  );

  // User 11 in org-a can still make 1 call before hitting DXOS_AI_DAILY_ORG_CALL_LIMIT=3
  checkAndConsumeAiQuota(actorA2, { estimatedPromptTokens: 20, env });
  recordQuotaUsage(actorA2, { promptTokens: 20, completionTokens: 30, costUsd: 0.001, piiRedactedCount: 0 });

  // Another user in org-a now exceeds org call limit=3 -> 429
  assert.throws(
    () => checkAndConsumeAiQuota({ userId: 12, organizationId: 'org-a' }, { estimatedPromptTokens: 20, env }),
    (err) => err.status === 429 && err.code === 'AI_QUOTA_EXCEEDED',
  );

  // org-b remains completely unaffected!
  assert.doesNotThrow(() => checkAndConsumeAiQuota(actorB1, { estimatedPromptTokens: 20, env }));
  const sumA = getQuotaSummary('org-a', env);
  assert.equal(sumA.usage.calls, 3);
  assert.equal(sumA.usage.tokens, 170);
  assert.equal(sumA.usage.piiRedacted, 1);
  resetQuotaBuckets();
});

test('createAuditedTool enforces quota and logs redacted PII & token/cost telemetry; quotaSummary action is admin-only', async () => {
  const { createAuditedTool } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { resetQuotaBuckets } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));

  resetQuotaBuckets();
  const auditLogs = [];
  const db = {
    getRepository(name) {
      if (name === 'roles') return { find: async () => [] };
      if (name === 'rolesUsers') return { find: async () => [{ userId: 5, roleName: 'ldx_employee' }] };
      if (name === 'latticeEmployees') return { find: async () => [{ id: 5, userId: 5, organizationId: 'org-q', active: true }] };
      if (name === 'latticeAiAuditLogs') {
        return {
          create: async ({ values }) => { auditLogs.push(values); return values; },
          find: async () => auditLogs,
        };
      }
      return null;
    },
  };

  const tool = createAuditedTool({
    name: 'dxos_pii_probe_tool',
    description: 'Probe tool',
    schema: { properties: { note: { type: 'string' } } },
    run: async (_ctx, _db, _actor, args) => ({ echoed: args.note, contact: '0912345678' }),
  });

  const ctx = { db, state: { currentUser: { id: 5, username: 'emp5' }, currentRole: 'ldx_employee' } };
  await tool.invoke(ctx, { note: 'Khách hàng CCCD 079095012345 email a@b.vn' });

  assert.equal(auditLogs.length, 1);
  assert.ok(auditLogs[0].promptTokens > 0);
  assert.ok(auditLogs[0].completionTokens > 0);
  assert.ok(auditLogs[0].estimatedCostUsd > 0);
  assert.ok(auditLogs[0].piiRedactedCount >= 3);
  assert.equal(JSON.stringify(auditLogs[0].argsSummary).includes('079095012345'), false);
  assert.equal(String(auditLogs[0].resultSummary).includes('0912345678'), false);

  const actions = createDxosAiActions(db);
  await assert.rejects(
    () => actions.quotaSummary({ db, state: { currentUser: { id: 5 }, currentRoles: ['ldx_employee'] }, action: { params: {} } }),
    (err) => err.status === 403,
  );
  const rootCtx = { db, state: { currentUser: { id: 1 }, currentRoles: ['root'] }, action: { params: { organizationId: 'org-q' } } };
  await actions.quotaSummary(rootCtx);
  assert.equal(rootCtx.body.organizationId, 'org-q');
  assert.ok(rootCtx.body.usage.calls >= 1);
  resetQuotaBuckets();
});

test('migration 20261122000600 adds audit quota columns reversibly', () => {
  const src = readFileSync(path.join(PLUGIN_ROOT, 'src/server/migrations/20261122000600-ai-audit-quota-columns.js'), 'utf8');
  assert.match(src, /\bup\s*\(/);
  assert.match(src, /\bdown\s*\(/);
  assert.match(src, /promptTokens/);
  assert.match(src, /piiRedactedCount/);
});

test('latticeAiQuotaUsage collection & migration 20261123000100 define persistent daily quota schema reversibly', async () => {
  const { aiQuotaUsage } = require(path.join(PLUGIN_ROOT, 'src/server/ai-schemas.js'));
  assert.equal(aiQuotaUsage.name, 'latticeAiQuotaUsage');
  const fieldNames = aiQuotaUsage.fields.map((f) => f.name);
  for (const reqField of ['organizationId', 'dayKey', 'userId', 'calls', 'promptTokens', 'completionTokens', 'costUsd', 'piiRedacted']) {
    assert.equal(fieldNames.includes(reqField), true, `Missing field ${reqField}`);
  }
  assert.equal(
    aiQuotaUsage.indexes.some((idx) => idx.name === 'uidx_lattice_ai_quota_org_day_user' && idx.unique === true),
    true,
  );

  const colSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/collections/ai-quota-usage.js'), 'utf8');
  assert.match(colSrc, /aiQuotaUsage/);

  const migSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/migrations/20261123000100-ai-quota-buckets.js'), 'utf8');
  assert.match(migSrc, /CREATE TABLE IF NOT EXISTS "latticeAiQuotaUsage"/);
  assert.match(migSrc, /"userId"\s+VARCHAR\(255\)/i);
  assert.match(migSrc, /uidx_lattice_ai_quota_org_day_user/);
  assert.match(migSrc, /idx_lattice_ai_quota_org_day/);
  assert.match(migSrc, /\bdown\s*\(/);
  assert.match(migSrc, /DROP TABLE IF EXISTS "latticeAiQuotaUsage"/);

  // Execute migration up() and down() against stubbed @nocobase/server & sequelize
  const Module = require('node:module');
  const origLoad = Module._load;
  const executedSql = [];
  class MockMigration {
    constructor(context) { this.context = context; }
  }
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/server') return { Migration: MockMigration };
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    const MigClass = require(path.join(PLUGIN_ROOT, 'src/server/migrations/20261123000100-ai-quota-buckets.js'));
    const mig = new MigClass({
      db: {
        sequelize: {
          transaction: async (fn) => fn({}),
          query: async (sql) => { executedSql.push(sql); return [[], 0]; },
        },
      },
    });
    await mig.up();
    await mig.down();
    assert.equal(executedSql.some((s) => /CREATE TABLE IF NOT EXISTS "latticeAiQuotaUsage"/.test(s)), true);
    assert.equal(executedSql.some((s) => /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_ai_quota_org_day_user/.test(s)), true);
    assert.equal(executedSql.some((s) => /DROP TABLE IF EXISTS "latticeAiQuotaUsage"/.test(s)), true);
  } finally {
    Module._load = origLoad;
  }
});

test('estimateCostUsd honors MODEL_PRICING_USD_PER_1M and explicit env overrides', () => {
  const { MODEL_PRICING_USD_PER_1M, estimateCostUsd } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));
  assert.ok(MODEL_PRICING_USD_PER_1M && typeof MODEL_PRICING_USD_PER_1M === 'object');

  const geminiCost = estimateCostUsd(1_000_000, 1_000_000, 'gemini-2.5-flash', {});
  const flash38Cost = estimateCostUsd(1_000_000, 1_000_000, 'ag/gemini-3.8-flash', {});
  const bareFlash38Cost = estimateCostUsd(1_000_000, 1_000_000, 'gemini-3.8-flash', {});
  const prefixedFlash38Cost = estimateCostUsd(1_000_000, 1_000_000, 'local-9router:ag/gemini-3.8-flash', {});
  const gpt4oCost = estimateCostUsd(1_000_000, 1_000_000, 'gpt-4o', {});
  const claudeCost = estimateCostUsd(1_000_000, 1_000_000, 'claude-sonnet', {});
  const ollamaCost = estimateCostUsd(1_000_000, 1_000_000, 'ollama:llama3:8b', {});

  assert.ok(geminiCost > 0 && flash38Cost > 0);
  assert.equal(bareFlash38Cost, flash38Cost);
  assert.equal(prefixedFlash38Cost, flash38Cost);
  assert.ok(gpt4oCost > geminiCost);
  assert.ok(claudeCost > gpt4oCost);
  assert.equal(ollamaCost, 0);

  // Explicit env overrides win over known model pricing (including explicit '0')
  const overrideCost = estimateCostUsd(1_000_000, 1_000_000, 'gpt-4o', {
    DXOS_AI_USD_PER_1M_INPUT: '5',
    DXOS_AI_USD_PER_1M_OUTPUT: '15',
  });
  assert.equal(overrideCost, 20);
  const zeroOverride = estimateCostUsd(1_000_000, 1_000_000, 'gpt-4o', {
    DXOS_AI_USD_PER_1M_INPUT: '0',
    DXOS_AI_USD_PER_1M_OUTPUT: '0',
  });
  assert.equal(zeroOverride, 0);
});

test('persistent quota hydrates after restart via latticeAiQuotaUsage & audit fallback and enforces DB-backed limits', async () => {
  const {
    hydrateQuotaBucketFromDb,
    recordQuotaUsagePersistent,
    getQuotaSummaryPersistent,
    checkAndConsumeAiQuota,
    resetQuotaBuckets,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));
  const { createAuditedTool } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));

  resetQuotaBuckets();
  const todayKey = new Date().toISOString().slice(0, 10);
  const quotaRows = [];
  const sqlCalls = [];

  // 1. SQL ON CONFLICT upsert + hydration after resetQuotaBuckets()
  const sqlDb = {
    sequelize: {
      query: async (sql, { replacements } = {}) => {
        sqlCalls.push({ sql, replacements });
        if (/INSERT INTO "latticeAiQuotaUsage"/i.test(sql)) {
          const idx = quotaRows.findIndex(
            (r) => r.organizationId === replacements.organizationId && r.dayKey === replacements.dayKey && r.userId === replacements.userId,
          );
          if (idx >= 0) {
            quotaRows[idx].calls += 1;
            quotaRows[idx].promptTokens += Number(replacements.promptTokens || 0);
            quotaRows[idx].completionTokens += Number(replacements.completionTokens || 0);
            quotaRows[idx].costUsd = Number((quotaRows[idx].costUsd + Number(replacements.costUsd || 0)).toFixed(6));
            quotaRows[idx].piiRedacted += Number(replacements.piiRedacted || 0);
          } else {
            quotaRows.push({
              organizationId: replacements.organizationId,
              dayKey: replacements.dayKey,
              userId: replacements.userId,
              calls: 1,
              promptTokens: Number(replacements.promptTokens || 0),
              completionTokens: Number(replacements.completionTokens || 0),
              costUsd: Number(replacements.costUsd || 0),
              piiRedacted: Number(replacements.piiRedacted || 0),
            });
          }
          return [[], 1];
        }
        return [[], 0];
      },
    },
    getRepository(name) {
      if (name === 'latticeAiQuotaUsage') {
        return {
          find: async ({ filter = {} } = {}) => quotaRows.filter(
            (r) => r.organizationId === filter.organizationId && r.dayKey === filter.dayKey,
          ),
        };
      }
      if (name === 'roles') return { find: async () => [] };
      if (name === 'rolesUsers') return { find: async () => [{ userId: 7, roleName: 'ldx_employee' }] };
      if (name === 'latticeEmployees') return { find: async () => [{ id: 70, userId: 7, organizationId: 'org-persist', active: true }] };
      if (name === 'latticeAiAuditLogs') return { create: async ({ values }) => values, find: async () => [] };
      return null;
    },
  };

  await recordQuotaUsagePersistent(sqlDb, { userId: 7, organizationId: 'org-persist' }, {
    promptTokens: 120,
    completionTokens: 80,
    costUsd: 0.0025,
    piiRedactedCount: 2,
  });
  assert.equal(sqlCalls.some((c) => /ON CONFLICT\s*\("organizationId",\s*"dayKey",\s*"userId"\)\s*DO UPDATE/i.test(c.sql)), true);
  assert.equal(quotaRows.length, 1);

  // Simulate container restart by clearing memory
  resetQuotaBuckets();
  await hydrateQuotaBucketFromDb(sqlDb, 'org-persist');
  const hydrated = await getQuotaSummaryPersistent(sqlDb, 'org-persist', { DXOS_AI_DAILY_USER_CALL_LIMIT: '1' });
  assert.equal(hydrated.day, todayKey);
  assert.equal(hydrated.usage.calls, 1);
  assert.equal(hydrated.usage.tokens, 200);
  assert.equal(hydrated.usage.piiRedacted, 2);
  assert.equal(hydrated.usage.activeUsers, 1);

  assert.throws(
    () => checkAndConsumeAiQuota({ userId: 7, organizationId: 'org-persist' }, { env: { DXOS_AI_DAILY_USER_CALL_LIMIT: '1' } }),
    (err) => err.status === 429 && err.code === 'AI_QUOTA_EXCEEDED',
  );

  // 2. createAuditedTool hydrates before quota check and persists after execution via repo fallback (no sequelize.query)
  resetQuotaBuckets();
  const repoQuotaRows = [
    { organizationId: 'org-repo', dayKey: todayKey, userId: '8', calls: 1, promptTokens: 50, completionTokens: 50, costUsd: 0.001, piiRedacted: 1 },
  ];
  const repoDb = {
    getRepository(name) {
      if (name === 'latticeAiQuotaUsage') {
        return {
          find: async ({ filter = {} } = {}) => repoQuotaRows.filter((r) => r.organizationId === filter.organizationId && r.dayKey === filter.dayKey),
          findOne: async ({ filter = {} } = {}) => {
            const hit = repoQuotaRows.find((r) => r.organizationId === filter.organizationId && r.dayKey === filter.dayKey && r.userId === filter.userId);
            return hit ? { ...hit, get: (k) => hit[k], update: async (v) => Object.assign(hit, v) } : null;
          },
          create: async ({ values }) => { repoQuotaRows.push(values); return values; },
        };
      }
      if (name === 'roles') return { find: async () => [] };
      if (name === 'rolesUsers') return { find: async () => [{ userId: 8, roleName: 'ldx_employee' }] };
      if (name === 'latticeEmployees') return { find: async () => [{ id: 80, userId: 8, organizationId: 'org-repo', active: true }] };
      if (name === 'latticeAiAuditLogs') return { create: async ({ values }) => values, find: async () => [] };
      return null;
    },
  };
  const probeTool = createAuditedTool({
    name: 'dxos_persist_probe',
    description: 'Persist probe',
    schema: { properties: {} },
    run: async () => ({ ok: true }),
  });
  await probeTool.invoke({ db: repoDb, state: { currentUser: { id: 8, username: 'emp8' }, currentRole: 'ldx_employee' } }, {});
  assert.equal(repoQuotaRows[0].calls, 2);

  // 3. Audit log same-day fallback when latticeAiQuotaUsage is empty (ignores yesterday's and denied/error logs)
  resetQuotaBuckets();
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString();
  const todayIso = new Date().toISOString();
  const auditOnlyDb = {
    getRepository(name) {
      if (name === 'latticeAiQuotaUsage') return { find: async () => [] };
      if (name === 'latticeAiAuditLogs') {
        return {
          find: async () => [
            { organizationId: 'org-fallback', actorUserId: 9, status: 'allowed', promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.002, piiRedactedCount: 1, createdAt: todayIso },
            { organizationId: 'org-fallback', actorUserId: 9, status: 'denied', promptTokens: 500, completionTokens: 0, estimatedCostUsd: 0.5, piiRedactedCount: 4, createdAt: todayIso },
            { organizationId: 'org-fallback', actorUserId: 9, status: 'error', promptTokens: 400, completionTokens: 0, estimatedCostUsd: 0.4, piiRedactedCount: 3, createdAt: todayIso },
            { organizationId: 'org-fallback', actorUserId: 9, status: 'allowed', promptTokens: 999, completionTokens: 999, estimatedCostUsd: 5.0, piiRedactedCount: 9, createdAt: yesterdayIso },
          ],
        };
      }
      return null;
    },
  };
  const fallbackSummary = await getQuotaSummaryPersistent(auditOnlyDb, 'org-fallback');
  assert.equal(fallbackSummary.usage.calls, 1);
  assert.equal(fallbackSummary.usage.tokens, 150);
  assert.equal(fallbackSummary.usage.piiRedacted, 1);
  assert.equal(fallbackSummary.usage.costUsd, 0.002);

  // 4. Mid-day migration: prior same-day audit calls (user 9 + user 10) + 1 new quota write + restart preserves all calls without double-counting
  resetQuotaBuckets();
  const midDayQuotaRows = [];
  const midDayAuditRows = [
    { organizationId: 'org-midday', actorUserId: 9, status: 'allowed', promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.001, piiRedactedCount: 1, createdAt: todayIso },
    { organizationId: 'org-midday', actorUserId: 10, status: 'degraded', promptTokens: 80, completionTokens: 40, estimatedCostUsd: 0.001, piiRedactedCount: 0, createdAt: todayIso },
    { organizationId: 'org-midday', actorUserId: 9, status: 'denied', promptTokens: 900, completionTokens: 0, estimatedCostUsd: 0.9, piiRedactedCount: 5, createdAt: todayIso },
  ];
  const midDayDb = {
    sequelize: {
      query: async (sql, { replacements } = {}) => {
        if (/FROM "latticeAiAuditLogs"/i.test(sql)) {
          const perUser = new Map();
          for (const r of midDayAuditRows) {
            if (r.organizationId !== replacements.organizationId) continue;
            if (r.status !== 'allowed' && r.status !== 'degraded') continue;
            const u = String(r.actorUserId);
            const cur = perUser.get(u) || { userId: u, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, piiRedacted: 0 };
            cur.calls += 1;
            cur.promptTokens += r.promptTokens;
            cur.completionTokens += r.completionTokens;
            cur.costUsd = Number((cur.costUsd + r.estimatedCostUsd).toFixed(6));
            cur.piiRedacted += r.piiRedactedCount;
            perUser.set(u, cur);
          }
          return [[...perUser.values()], perUser.size];
        }
        if (/INSERT INTO "latticeAiQuotaUsage"/i.test(sql)) {
          const idx = midDayQuotaRows.findIndex(
            (r) => r.organizationId === replacements.organizationId && r.dayKey === replacements.dayKey && r.userId === replacements.userId,
          );
          if (/ON CONFLICT[\s\S]*DO NOTHING/i.test(sql)) {
            if (idx < 0) {
              midDayQuotaRows.push({
                organizationId: replacements.organizationId,
                dayKey: replacements.dayKey,
                userId: replacements.userId,
                calls: Number(replacements.calls || 0),
                promptTokens: Number(replacements.promptTokens || 0),
                completionTokens: Number(replacements.completionTokens || 0),
                costUsd: Number(replacements.costUsd || 0),
                piiRedacted: Number(replacements.piiRedacted || 0),
              });
            }
            return [[], 1];
          }
          if (idx >= 0) {
            midDayQuotaRows[idx].calls += 1;
            midDayQuotaRows[idx].promptTokens += Number(replacements.promptTokens || 0);
            midDayQuotaRows[idx].completionTokens += Number(replacements.completionTokens || 0);
            midDayQuotaRows[idx].costUsd = Number((midDayQuotaRows[idx].costUsd + Number(replacements.costUsd || 0)).toFixed(6));
            midDayQuotaRows[idx].piiRedacted += Number(replacements.piiRedacted || 0);
          } else {
            midDayQuotaRows.push({
              organizationId: replacements.organizationId,
              dayKey: replacements.dayKey,
              userId: replacements.userId,
              calls: 1,
              promptTokens: Number(replacements.promptTokens || 0),
              completionTokens: Number(replacements.completionTokens || 0),
              costUsd: Number(replacements.costUsd || 0),
              piiRedacted: Number(replacements.piiRedacted || 0),
            });
          }
          return [[], 1];
        }
        return [[], 0];
      },
    },
    getRepository(name) {
      if (name === 'latticeAiQuotaUsage') {
        return {
          find: async ({ filter = {} } = {}) => midDayQuotaRows.filter((r) => r.organizationId === filter.organizationId && r.dayKey === filter.dayKey),
        };
      }
      if (name === 'latticeAiAuditLogs') return { find: async () => midDayAuditRows };
      return null;
    },
  };

  // New call by user 9 after migration writes both quota table (calls: 1) and audit log (user 9 now has 2 allowed calls)
  await recordQuotaUsagePersistent(midDayDb, { userId: 9, organizationId: 'org-midday' }, {
    promptTokens: 60.9,
    completionTokens: 40.7,
    costUsd: 0.002,
    piiRedactedCount: 1.8,
  });
  midDayAuditRows.push({
    organizationId: 'org-midday', actorUserId: 9, status: 'allowed', promptTokens: 60, completionTokens: 40, estimatedCostUsd: 0.002, piiRedactedCount: 1, createdAt: todayIso,
  });
  assert.equal(midDayQuotaRows[0].promptTokens, 60);
  assert.equal(midDayQuotaRows[0].completionTokens, 40);
  assert.equal(midDayQuotaRows[0].piiRedacted, 1);

  // Restart -> clears memory, hydrates from DB + audit fallback
  resetQuotaBuckets();
  const midDaySummary = await getQuotaSummaryPersistent(midDayDb, 'org-midday');
  assert.equal(midDaySummary.usage.calls, 3);
  assert.equal(midDaySummary.usage.activeUsers, 2);
  assert.equal(midDaySummary.usage.tokens, 370);
  resetQuotaBuckets();
});

test('Wave 4B P1 #3: redactPiiText & redactPiiForLlm scrub JSON-quoted secrets and object keys before JSON.stringify', () => {
  const gov = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));
  const { redactPiiText, redactPiiForLlm } = gov;
  assert.equal(typeof redactPiiForLlm, 'function');

  // 1. JSON-stringified secrets with quoted keys must be redacted cleanly while preserving promptTokens
  const rawJson = JSON.stringify({
    apiKey: 'raw-unprefixed-api-key-999',
    secret: 'super-secret-value-456',
    client_secret: 'cs-secret-789',
    password: 'my-db-password',
    token: 'tok-abc-123',
    promptTokens: 120,
    safeNote: 'Kho lanh A1 binh thuong',
  });
  const textRes = redactPiiText(rawJson);
  assert.equal(textRes.text.includes('raw-unprefixed-api-key-999'), false);
  assert.equal(textRes.text.includes('super-secret-value-456'), false);
  assert.equal(textRes.text.includes('cs-secret-789'), false);
  assert.equal(textRes.text.includes('my-db-password'), false);
  assert.equal(textRes.text.includes('tok-abc-123'), false);
  assert.ok(textRes.count >= 5);
  const reparsed = JSON.parse(textRes.text);
  assert.equal(reparsed.apiKey, '[REDACTED]');
  assert.equal(reparsed.secret, '[REDACTED]');
  assert.equal(reparsed.promptTokens, 120);
  assert.equal(reparsed.safeNote, 'Kho lanh A1 binh thuong');

  // Escaped JSON embedded inside a log/prompt string
  const nestedEscaped = JSON.stringify({ payload: JSON.stringify({ apiKey: 'nested-secret-xyz' }) });
  const nestedRes = redactPiiText(nestedEscaped);
  assert.equal(nestedRes.text.includes('nested-secret-xyz'), false);

  // 2. redactPiiForLlm scrubs SENSITIVE_KEY_RE object keys BEFORE JSON.stringify and does not truncate > 600 chars
  const longPad = 'B'.repeat(700);
  const llmObj = redactPiiForLlm({
    apiKey: 'unprefixed-secret-key-1',
    nested: { secret: 'nested-val-2', password: 'pw-3', note: `${longPad} contact alice@example.com` },
    jsonText: '{"apiKey":"inline-secret-4","secret":"inline-secret-5"}',
    safe: 'ok',
  });
  assert.equal(llmObj.redacted.apiKey, '[REDACTED]');
  assert.equal(llmObj.redacted.nested.secret, '[REDACTED]');
  assert.equal(llmObj.redacted.nested.password, '[REDACTED]');
  assert.ok(llmObj.redacted.nested.note.length > 700);
  assert.equal(llmObj.redacted.nested.note.includes('alice@example.com'), false);
  assert.equal(llmObj.redacted.jsonText.includes('inline-secret-4'), false);
  assert.equal(llmObj.redacted.jsonText.includes('inline-secret-5'), false);
  assert.equal(llmObj.redacted.safe, 'ok');
  assert.ok(llmObj.redactedCount >= 6);
});

test('Task 11: recordAiAuditLog, quota accounting, and createAuditedTool track real provider usage & tokenSource while preserving 17 canonical tools', async () => {
  const {
    recordQuotaUsage,
    recordQuotaUsagePersistent,
    getQuotaSummary,
    resetQuotaBuckets,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));
  const {
    aiAuditLogs,
    recordAiAuditLog,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-schemas.js'));
  const {
    ADMIN_BUILDER_TOOL_NAMES,
    OPERATIONAL_TOOL_NAMES,
    createAuditedTool,
    createDxosTools,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));

  // 1. Canonical 17-tool matrix preserved intact
  const allTools = createDxosTools();
  assert.equal(ADMIN_BUILDER_TOOL_NAMES.length, 11);
  assert.equal(OPERATIONAL_TOOL_NAMES.length, 6);
  assert.equal(allTools.length, 17);

  // 2. aiAuditLogs schema & recordAiAuditLog support usage + totalTokens + tokenSource ('provider' vs 'estimated')
  const fieldNames = aiAuditLogs.fields.map((f) => f.name);
  assert.equal(fieldNames.includes('totalTokens'), true);
  assert.equal(fieldNames.includes('tokenSource'), true);

  const createdLogs = [];
  const mockDb = {
    getRepository(name) {
      if (name === 'roles') return { find: async () => [] };
      if (name === 'rolesUsers') return { find: async () => [{ userId: 5, roleName: 'ldx_employee' }] };
      if (name === 'latticeEmployees') return { find: async () => [{ id: 5, userId: 5, organizationId: 'org-tel', active: true }] };
      if (name === 'latticeAiAuditLogs') return { create: async ({ values }) => { createdLogs.push(values); return values; }, find: async () => createdLogs };
      return null;
    },
  };

  await recordAiAuditLog(mockDb, {
    actorUserId: 5,
    actorUsername: 'emp5',
    organizationId: 'org-tel',
    channel: 'ai-tool',
    toolName: 'dxos_search_enterprise_context',
    status: 'allowed',
    usage: { promptTokens: 320, completionTokens: 80, totalTokens: 400 },
  });
  assert.equal(createdLogs[0].promptTokens, 320);
  assert.equal(createdLogs[0].completionTokens, 80);
  assert.equal(createdLogs[0].totalTokens, 400);
  assert.equal(createdLogs[0].tokenSource, 'provider');

  await recordAiAuditLog(mockDb, {
    actorUserId: 5,
    actorUsername: 'emp5',
    organizationId: 'org-tel',
    channel: 'ai-tool',
    toolName: 'dxos_search_enterprise_context',
    status: 'allowed',
    promptTokens: 45,
    completionTokens: 15,
  });
  assert.equal(createdLogs[1].totalTokens, 60);
  assert.equal(createdLogs[1].tokenSource, 'estimated');

  // 3. Quota accounting accepts usage: { promptTokens, completionTokens, totalTokens } and tracks provider vs estimated
  resetQuotaBuckets();
  const actor = { userId: 5, organizationId: 'org-tel' };
  const provMetric = recordQuotaUsage(actor, {
    usage: { promptTokens: 300, completionTokens: 100, totalTokens: 400 },
    costUsd: 0.004,
  });
  assert.equal(provMetric.tokenSource, 'provider');
  assert.equal(provMetric.providerTokens, 400);
  assert.equal(provMetric.providerCalls, 1);

  const estMetric = await recordQuotaUsagePersistent(mockDb, actor, {
    promptTokens: 50,
    completionTokens: 25,
    costUsd: 0.001,
  });
  assert.equal(estMetric.tokenSource, 'estimated');
  assert.equal(estMetric.estimatedTokens, 75);
  assert.equal(estMetric.estimatedCalls, 1);

  const summary = getQuotaSummary('org-tel');
  assert.equal(summary.usage.totalTokens, 475);
  assert.equal(summary.usage.providerTokens, 400);
  assert.equal(summary.usage.estimatedTokens, 75);
  assert.equal(summary.usage.providerCalls, 1);
  assert.equal(summary.usage.estimatedCalls, 1);

  // 4. createAuditedTool records tokenSource='provider' when tool returns usage vs 'estimated' when fallback
  const providerTool = createAuditedTool({
    name: 'dxos_provider_usage_probe',
    description: 'Provider usage probe',
    schema: { properties: { q: { type: 'string' } } },
    run: async () => ({
      ok: true,
      usage: { promptTokens: 150, completionTokens: 50, totalTokens: 200 },
    }),
  });
  await providerTool.invoke({ db: mockDb, state: { currentUser: { id: 5, username: 'emp5' }, currentRole: 'ldx_employee' } }, { q: 'hi' });
  const lastProvLog = createdLogs.at(-1);
  assert.equal(lastProvLog.promptTokens, 150);
  assert.equal(lastProvLog.completionTokens, 50);
  assert.equal(lastProvLog.totalTokens, 200);
  assert.equal(lastProvLog.tokenSource, 'provider');

  const estimatedTool = createAuditedTool({
    name: 'dxos_estimated_usage_probe',
    description: 'Estimated usage probe',
    schema: { properties: { q: { type: 'string' } } },
    run: async () => ({ ok: true }),
  });
  await estimatedTool.invoke({ db: mockDb, state: { currentUser: { id: 5, username: 'emp5' }, currentRole: 'ldx_employee' } }, { q: 'hi' });
  const lastEstLog = createdLogs.at(-1);
  assert.equal(lastEstLog.tokenSource, 'estimated');
  assert.equal(lastEstLog.totalTokens, lastEstLog.promptTokens + lastEstLog.completionTokens);
  resetQuotaBuckets();
});
