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
