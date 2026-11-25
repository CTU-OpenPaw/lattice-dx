/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlankSlateAcceptanceArgs,
  runBlankSlateAppBuilderAcceptance,
} from '../acceptance-blank-slate-app-builder.mjs';

test('parseBlankSlateAcceptanceArgs enforces safe lab origins and parses --origin / --org', () => {
  assert.throws(() => parseBlankSlateAcceptanceArgs([]), /Usage:/);
  assert.throws(() => parseBlankSlateAcceptanceArgs(['--origin=http://localhost:13000']), /Unsafe/i);
  const parsed = parseBlankSlateAcceptanceArgs(['--origin=http://127.0.0.1:13015', '--org=acme-lab']);
  assert.equal(parsed.origin, 'http://127.0.0.1:13015');
  assert.equal(parsed.organizationId, 'acme-lab');
});

test('runBlankSlateAppBuilderAcceptance verifies RBAC, dxos-architect, checkLlmHealth, cycle refusal, multi-entity build, collectionsMeta, rebuild, export v3, teardown keepData: true, and cleanup', async () => {
  const state = {
    nextId: 100,
    builtApps: [],
    collections: [],
    records: new Map(),
    chatter: [],
    dmnTables: [],
    flowRules: [],
    portals: [],
    roles: [],
    aiProfiles: [
      { username: 'dxos-architect', nickname: 'Kiến trúc sư Hệ thống - Block AI', enabled: true, isAdminBuilder: true },
      { username: 'dxos-workspace', nickname: 'Trợ lý Không gian việc', enabled: true, isAdminBuilder: false },
    ],
    destroyed: [],
    mcpCalls: [],
  };

  const callActor = async (role, path, { method = 'GET', values } = {}) => {
    const [clean, qStr = ''] = String(path || '').split('?');
    const query = new URLSearchParams(qStr);

    if (role === 'anon' && clean !== 'dxos:openapi') {
      return { ok: false, status: 401, data: { errors: [{ code: 'NATIVE_LOGIN_REQUIRED' }] } };
    }

    if (clean === 'dxosAi:listProfiles') {
      if (role !== 'root') return { ok: false, status: 403, data: {} };
      return { ok: true, status: 200, data: { profiles: state.aiProfiles } };
    }
    if (clean === 'dxosAi:portalAgents') {
      const employees = role === 'root' ? state.aiProfiles : state.aiProfiles.filter((p) => !p.isAdminBuilder);
      return { ok: true, status: 200, data: { isAdmin: role === 'root', employees } };
    }
    if (clean === 'dxosAi:checkLlmHealth') {
      return { ok: true, status: 200, data: { ok: true, status: 200, code: 'OK', llmService: 'local-9router' } };
    }
    if (clean === 'dxosAi:quickConnectLlm') {
      if (role !== 'root') return { ok: false, status: 403, data: { errors: [{ code: 'DXOS_ADMIN_REQUIRED' }] } };
      return { ok: true, status: 200, data: { service: { name: 'quick-openai', enabled: true } } };
    }
    if (clean === 'dxosAi:listBuiltApps') {
      if (role !== 'root') return { ok: false, status: 403, data: {} };
      return { ok: true, status: 200, data: { apps: state.builtApps, total: state.builtApps.length } };
    }
    if (clean === 'dxosAi:rebuildBuiltApp') {
      if (role !== 'root') return { ok: false, status: 403, data: {} };
      const app = state.builtApps.find((a) => a.appKey === values?.appKey);
      if (!app) return { ok: false, status: 404, data: {} };
      app.version += 1;
      app.status = 'active';
      return { ok: true, status: 200, data: { rebuilt: true, ok: true, appKey: app.appKey, appVersion: app.version } };
    }
    if (clean === 'dxosAi:exportBuiltAppBundle') {
      if (role !== 'root') return { ok: false, status: 403, data: {} };
      const appKey = query.get('appKey') || values?.appKey;
      const app = state.builtApps.find((a) => a.appKey === appKey);
      if (!app) return { ok: false, status: 404, data: {} };
      return {
        ok: true,
        status: 200,
        data: {
          metadata: { schemaVersion: 'latticedx.solution-bundle/v3', appKey: app.appKey, appVersion: app.version, contentSha256: 'sha256-mock' },
          customCollections: app.artifactRefsJson.collections.map((name) => ({ name })),
          governance: {
            decisionTables: app.artifactRefsJson.dmnTableKeys.map((tableKey) => ({ tableKey })),
            automationRules: app.artifactRefsJson.flowRuleKeys.map((ruleKey) => ({ ruleKey })),
          },
        },
      };
    }
    if (clean === 'dxosAi:teardownBuiltApp') {
      if (role !== 'root') return { ok: false, status: 403, data: {} };
      const app = state.builtApps.find((a) => a.appKey === values?.appKey);
      if (!app) return { ok: false, status: 404, data: {} };
      const keepData = values?.keepData !== false;
      app.status = 'torndown';
      if (!keepData) {
        for (const c of app.artifactRefsJson.collections) {
          state.collections = state.collections.filter((col) => col.name !== c);
          state.records.delete(c);
        }
      }
      return {
        ok: true,
        status: 200,
        data: {
          torndown: true,
          appKey: app.appKey,
          keepData,
          preservedCollections: keepData ? [...app.artifactRefsJson.collections] : [],
          droppedCollections: keepData ? [] : [...app.artifactRefsJson.collections],
        },
      };
    }
    if (clean === 'dxosBlocks:collectionsMeta') {
      return { ok: true, status: 200, data: { collections: state.collections } };
    }
    if (clean === 'dxos:openapi') {
      const paths = {};
      for (const c of state.collections) {
        paths[`/api/${c.name}:list`] = { get: {} };
        paths[`/api/${c.name}:create`] = { post: {} };
      }
      return { ok: true, status: 200, data: { openapi: '3.1.0', paths } };
    }
    if (clean === 'latticeChatter:list') {
      return { ok: true, status: 200, data: { items: state.chatter } };
    }
    if (clean === 'latticeChatter:post') {
      const item = { id: ++state.nextId, ...(values || {}) };
      state.chatter.push(item);
      return { ok: true, status: 200, data: item };
    }
    if (clean.endsWith(':create')) {
      const col = clean.split(':')[0];
      if (col.startsWith('latticeCustom')) {
        if (role === 'employee' && values?.organizationId && values.organizationId !== 'native-ui-lab') {
          return { ok: false, status: 403, data: {} };
        }
        const rows = state.records.get(col) || [];
        const row = { id: ++state.nextId, ...(values || {}) };
        rows.push(row);
        state.records.set(col, rows);
        return { ok: true, status: 200, data: row };
      }
    }
    if (clean.endsWith(':list')) {
      const col = clean.split(':')[0];
      if (col.startsWith('latticeCustom')) {
        const rows = state.records.get(col) || [];
        return { ok: true, status: 200, data: role === 'employee' ? rows.filter((r) => r.organizationId === 'native-ui-lab') : rows };
      }
    }
    if (clean.endsWith(':destroy')) {
      state.destroyed.push(path);
      return { ok: true, status: 200, data: { deleted: true } };
    }
    if (clean === 'dxosAutomations:deleteRule' || clean === 'dxosAi:deleteProfile') {
      state.destroyed.push(clean);
      return { ok: true, status: 200, data: { deleted: true } };
    }
    return { ok: false, status: 404, data: {} };
  };

  const rpcRequest = async (role, _endpoint, rpcBody) => {
    if (role === 'anon') return { status: 401, json: { error: { code: -32001 } } };
    if (rpcBody.method === 'tools/call') {
      const { name, arguments: args } = rpcBody.params || {};
      state.mcpCalls.push({ role, name, args });
      if (role !== 'root') {
        return { status: 200, json: { error: { code: -32003, message: 'Admin required' } } };
      }
      if (name === 'dxos_provision_role_workspace' && args?.operation === 'build_enterprise_app') {
        if (args.collectionName === 'users') {
          return { status: 200, json: { result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'SYSTEM_COLLECTION_FORBIDDEN', error: 'Forbidden' }) }] } } };
        }
        const cols = Array.isArray(args.collections) ? args.collections : [];
        if (cols.some((c) => c.collectionName?.includes('CycleA'))) {
          return { status: 200, json: { result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'BLUEPRINT_CYCLE_DETECTED', error: 'Cycle' }) }] } } };
        }
        const orderedCols = [...cols].reverse();
        for (const c of orderedCols) {
          state.collections.push({
            name: c.collectionName,
            title: c.collectionTitle || c.collectionName,
            isCustom: true,
            fields: [
              { name: 'id', type: 'bigInt' },
              { name: 'organizationId', type: 'string' },
              { name: 'code', type: 'string' },
              { name: 'name', type: 'string' },
              { name: 'status', type: 'string', enumValues: [{ value: 'draft', label: 'draft' }, { value: 'scheduled', label: 'scheduled' }, { value: 'completed', label: 'completed' }] },
              ...(c.fields || []),
            ],
          });
          state.records.set(c.collectionName, []);
        }
        const appRecord = {
          id: ++state.nextId,
          organizationId: 'native-ui-lab',
          appKey: args.appKey,
          name: args.name || args.pageTitle,
          version: 1,
          status: 'active',
          artifactRefsJson: {
            collections: orderedCols.map((c) => c.collectionName),
            roles: (args.roles || []).map((r) => r.roleName),
            portals: (args.portals || []).map((p) => ({ portalSlug: p.portalSlug, pageTitle: p.pageTitle, blockUids: ['blk-1'] })),
            dmnTableKeys: (args.dmnTables || []).map((d) => d.tableKey),
            flowRuleKeys: (args.flowGraphs || []).map((f) => f.ruleKey),
            n8nWorkflowIds: [],
          },
          lastVerificationJson: { ok: true, passedCount: 6, totalCount: 6 },
        };
        state.builtApps.push(appRecord);
        return {
          status: 200,
          json: {
            result: {
              isError: false,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  built: true,
                  ok: true,
                  appKey: args.appKey,
                  appVersion: 1,
                  collections: appRecord.artifactRefsJson.collections,
                  verification: appRecord.lastVerificationJson,
                }),
              }],
            },
          },
        };
      }
    }
    return { status: 200, json: { error: { code: -32601 } } };
  };

  const summary = await runBlankSlateAppBuilderAcceptance(callActor, rpcRequest, { organizationId: 'native-ui-lab' });
  assert.equal(summary.result, 'PASS');
  assert.equal(summary.checks.rbacNegativeChecksOk, true);
  assert.equal(summary.checks.blankSlateArchitectAndHealthOk, true);
  assert.equal(summary.checks.cycleAndProtectedTargetsRefusedOk, true);
  assert.equal(summary.checks.multiEntityBuildAndTopoOrderOk, true);
  assert.equal(summary.checks.collectionsMetaAndOpenApiOk, true);
  assert.equal(summary.checks.dynamicKanbanWebgisChatterRlsOk, true);
  assert.equal(summary.checks.rebuildAndExportV3Ok, true);
  assert.equal(summary.checks.teardownKeepDataOk, true);
  assert.equal(state.collections.length, 0, 'Cleanup in finally must drop temporary collections');
});
