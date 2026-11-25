#!/usr/bin/env node
/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeLabOrigin } from './setup-native-multi-portal-demo.mjs';

const DEFAULT_ORG = 'native-ui-lab';
const DEMO_PASS = process.env.NATIVE_DEMO_PASSWORD ?? 'NativeLab-2026!';

export function parseBlankSlateAcceptanceArgs(argv) {
  let origin = null;
  let reportPath = null;
  let organizationId = DEFAULT_ORG;

  for (const arg of argv) {
    if (arg.startsWith('--origin=')) origin = arg.slice('--origin='.length);
    else if (arg.startsWith('--org=')) organizationId = arg.slice('--org='.length).trim() || DEFAULT_ORG;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (reportPath === null) reportPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!origin && !reportPath) {
    throw new Error(
      'Usage: node scripts/acceptance-blank-slate-app-builder.mjs <clean-install report.json> | --origin=http://127.0.0.1:13015 [--org=native-ui-lab]',
    );
  }
  if (origin !== null) {
    origin = assertSafeLabOrigin(origin);
  }
  return { origin, reportPath, organizationId };
}

export async function createBlankSlateAcceptanceCallers(origin) {
  const safeOrigin = assertSafeLabOrigin(origin);

  async function signIn(email, password) {
    const res = await fetch(new URL('/api/auth:signIn', safeOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    assert.ok(res.ok && json?.data?.token, `Sign-in failed for ${email}: HTTP ${res.status}`);
    return json.data.token;
  }

  const tokens = {
    root: await signIn(
      process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com',
      process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123',
    ),
    employee: await signIn(
      process.env.NATIVE_DEMO_EMPLOYEE_EMAIL || 'native.lab.employee@example.invalid',
      DEMO_PASS,
    ),
  };

  const callActor = async (actorRole, path, { method = 'GET', values, headers: extraHeaders = {} } = {}) => {
    const cleanPath = String(path || '').replace(/^\/+/, '');
    const urlPath = cleanPath.startsWith('api/') ? `/${cleanPath}` : `/api/${cleanPath}`;
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (actorRole !== 'anon') {
      const tok = tokens[actorRole];
      if (!tok) throw new Error(`Unknown actor role: ${actorRole}`);
      headers.authorization = `Bearer ${tok}`;
      if (actorRole === 'root') headers['X-Role'] = 'root';
    }
    const response = await fetch(new URL(urlPath, safeOrigin), {
      method,
      redirect: 'error',
      headers,
      ...(values !== undefined ? { body: JSON.stringify(values) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    return {
      ok: response.ok,
      status: response.status,
      rawText: text,
      data: payload.data !== undefined ? payload.data : payload,
    };
  };

  const rpcRequest = async (actorRole, endpoint, rpcBody) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (actorRole !== 'anon') {
      const tok = tokens[actorRole];
      if (!tok) throw new Error(`Unknown actor role: ${actorRole}`);
      headers.authorization = `Bearer ${tok}`;
      if (actorRole === 'root') headers['X-Role'] = 'root';
    }
    const res = await fetch(new URL(endpoint, safeOrigin), {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify(rpcBody),
      signal: AbortSignal.timeout(45000),
    });
    const raw = await res.text();
    let json = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      json = { raw };
    }
    return { status: res.status, json };
  };

  return { callActor, rpcRequest };
}

function unwrapList(resData) {
  if (Array.isArray(resData)) return resData;
  if (Array.isArray(resData?.items)) return resData.items;
  if (Array.isArray(resData?.rows)) return resData.rows;
  if (Array.isArray(resData?.apps)) return resData.apps;
  if (Array.isArray(resData?.data)) return resData.data;
  return [];
}

function parseMcpToolResult(rpcRes, label) {
  assert.equal(rpcRes.status, 200, `${label}: expected HTTP 200, got ${rpcRes.status}`);
  assert.equal(rpcRes.json?.error, undefined, `${label}: unexpected JSON-RPC error ${JSON.stringify(rpcRes.json?.error)}`);
  assert.equal(rpcRes.json?.result?.isError, false, `${label}: tool returned isError=true: ${JSON.stringify(rpcRes.json?.result)}`);
  const text = rpcRes.json?.result?.content?.[0]?.text || '{}';
  return JSON.parse(text);
}

async function destroyMatchingIds(callActor, collection, filter, pkField = 'id') {
  const qs = encodeURIComponent(JSON.stringify(filter));
  const res = await callActor('root', `${collection}:list?filter=${qs}&pageSize=200`).catch(() => null);
  for (const row of unwrapList(res?.data)) {
    const pk = row?.[pkField] ?? row?.id ?? row?.name;
    if (pk != null) {
      await callActor('root', `${collection}:destroy?filterByTk=${encodeURIComponent(pk)}`, { method: 'POST' }).catch(() => {});
    }
  }
}

export async function cleanupPortalRoleReferences(callActor, removedRoles = []) {
  const removedSet = new Set((Array.isArray(removedRoles) ? removedRoles : []).filter(Boolean));
  if (!removedSet.size) return;

  const portalsRes = await callActor('root', 'latticePortals:list').catch(() => null);
  if (portalsRes?.ok && Array.isArray(portalsRes.data)) {
    for (const p of portalsRes.data) {
      if (!p?.uid || p.builtin || p.uid === 'admin-layout-model' || p.uid === 'mobile-layout-model') continue;
      const curRoles = Array.isArray(p.roles) ? p.roles : [];
      const nextRoles = curRoles.filter((r) => !removedSet.has(r));
      if (nextRoles.length !== curRoles.length || p.uid === 'ldx-portal-services') {
        await callActor('root', 'latticePortals:save', {
          method: 'POST',
          values: { uid: p.uid, slug: p.slug, title: p.title, roles: nextRoles },
        }).catch(() => {});
      }
    }
  }

  const pluginFilter = encodeURIComponent(JSON.stringify({ packageName: '@latticedx/plugin-lattice-foundation' }));
  const pluginRes = await callActor('root', `applicationPlugins:list?filter=${pluginFilter}&pageSize=5`).catch(() => null);
  const pluginRow = unwrapList(pluginRes?.data)[0];
  const portalsMap = pluginRow?.options?.portals;
  if (pluginRow && portalsMap && typeof portalsMap === 'object') {
    let changed = false;
    const nextPortals = { ...portalsMap };
    for (const [uid, entry] of Object.entries(portalsMap)) {
      if (!entry || !Array.isArray(entry.roles)) continue;
      const filtered = entry.roles.filter((r) => !removedSet.has(r));
      if (filtered.length !== entry.roles.length) {
        nextPortals[uid] = { ...entry, roles: filtered };
        changed = true;
      }
    }
    if (changed) {
      const tk = pluginRow.name || pluginRow.packageName || pluginRow.id;
      if (tk != null) {
        await callActor('root', `applicationPlugins:update?filterByTk=${encodeURIComponent(tk)}`, {
          method: 'POST',
          values: { options: { ...pluginRow.options, portals: nextPortals } },
        }).catch(() => {});
      }
    }
  }
}

export async function runBlankSlateAppBuilderAcceptance(callActor, rpcRequest, { organizationId = DEFAULT_ORG } = {}) {
  const suffix = Date.now().toString(36).slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  const lower = suffix.toLowerCase();
  const appKey = `acc-multi-${lower}`;
  const parentCol = `latticeCustomAccVendors${suffix}`;
  const childCol = `latticeCustomAccOrders${suffix}`;
  const portalSlug = 'services';
  const pageTitle = `Acceptance Multi-Entity ${suffix}`;
  const roleName = `ldx_acc_ops_${lower}`;
  const dmnTableKey = `acc_multi_sla_${lower}_v1`;
  const flowRuleKey = `auto_acc_multi_${lower}_v2`;
  const otherOrgId = `acc-other-${lower}`;

  const cleanup = {
    appKey,
    parentCol,
    childCol,
    roleName,
    dmnTableKey,
    flowRuleKey,
    aiUsername: null,
    preBuildSnapshotUid: null,
    portals: [],
    chatterIds: [],
  };

  const checks = {
    rbacNegativeChecksOk: false,
    blankSlateArchitectAndHealthOk: false,
    cycleAndProtectedTargetsRefusedOk: false,
    multiEntityBuildAndTopoOrderOk: false,
    collectionsMetaAndOpenApiOk: false,
    dynamicKanbanWebgisChatterRlsOk: false,
    rebuildAndExportV3Ok: false,
    teardownKeepDataOk: false,
  };

  try {
    // 1. RBAC Negative Checks (401 unauthenticated & 403 non-admin employee)
    const unauthEndpoints = [
      ['GET', 'dxosAi:listBuiltApps'],
      ['POST', 'dxosAi:rebuildBuiltApp', { appKey: 'any' }],
      ['GET', 'dxosAi:exportBuiltAppBundle?appKey=any'],
      ['POST', 'dxosAi:teardownBuiltApp', { appKey: 'any' }],
      ['POST', 'dxosAi:quickConnectLlm', { provider: 'openai', apiKey: 'sk-blocked' }],
      ['GET', 'dxosAi:checkLlmHealth'],
      ['GET', 'dxosBlocks:collectionsMeta'],
    ];
    for (const [method, ep, values] of unauthEndpoints) {
      const res = await callActor('anon', ep, { method, ...(values ? { values } : {}) });
      assert.equal(res.status, 401, `Expected 401 for unauthenticated ${ep}, got ${res.status}`);
    }

    const empForbiddenEndpoints = [
      ['GET', 'dxosAi:listBuiltApps'],
      ['POST', 'dxosAi:rebuildBuiltApp', { appKey: 'any' }],
      ['GET', 'dxosAi:exportBuiltAppBundle?appKey=any'],
      ['POST', 'dxosAi:teardownBuiltApp', { appKey: 'any' }],
      ['POST', 'dxosAi:quickConnectLlm', { provider: 'openai', apiKey: 'sk-blocked' }],
    ];
    for (const [method, ep, values] of empForbiddenEndpoints) {
      const res = await callActor('employee', ep, { method, ...(values ? { values } : {}) });
      assert.equal(res.status, 403, `Expected 403 for employee ${ep}, got ${res.status}`);
    }

    const empMcpBlocked = await rpcRequest('employee', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'dxos_provision_role_workspace',
        arguments: { operation: 'list_built_apps' },
      },
    });
    assert.equal(empMcpBlocked.json?.error?.code, -32003, 'Employee MCP builder call must be denied (-32003)');
    checks.rbacNegativeChecksOk = true;

    // 2. Blank-slate dxos-architect presence & checkLlmHealth
    const profilesRes = await callActor('root', 'dxosAi:listProfiles');
    assert.ok(profilesRes.ok && profilesRes.status < 300, `dxosAi:listProfiles failed: ${profilesRes.status}`);
    const profiles = Array.isArray(profilesRes.data?.profiles) ? profilesRes.data.profiles : [];
    const architectProfile = profiles.find((p) => p?.username === 'dxos-architect');
    assert.ok(architectProfile && architectProfile.enabled !== false, 'dxos-architect must be auto-bootstrapped and enabled');
    assert.equal(architectProfile.isAdminBuilder, true, 'dxos-architect must have isAdminBuilder=true');

    const rootPortalAgents = await callActor('root', 'dxosAi:portalAgents?portalSlug=services');
    assert.ok(rootPortalAgents.ok);
    assert.ok(
      (rootPortalAgents.data?.employees || []).some((e) => e?.username === 'dxos-architect'),
      'Admin portalAgents must include dxos-architect',
    );
    const empPortalAgents = await callActor('employee', 'dxosAi:portalAgents?portalSlug=services');
    assert.ok(empPortalAgents.ok);
    assert.equal(
      (empPortalAgents.data?.employees || []).some((e) => e?.username === 'dxos-architect'),
      false,
      'Non-admin portalAgents must NEVER expose dxos-architect',
    );

    const healthRes = await callActor('root', 'dxosAi:checkLlmHealth');
    assert.equal(healthRes.status, 200, `dxosAi:checkLlmHealth failed: ${healthRes.status}`);
    assert.equal(typeof healthRes.data?.ok, 'boolean', 'checkLlmHealth must return boolean ok');
    checks.blankSlateArchitectAndHealthOk = true;

    // 3. Multi-Entity Cycle & Protected System Collection Refusal BEFORE DB mutation
    const cycleRes = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'dxos_provision_role_workspace',
        arguments: {
          operation: 'build_enterprise_app',
          portalSlug,
          pageTitle: `Cycle Reject ${suffix}`,
          collections: [
            {
              collectionName: `latticeCustomCycleA${suffix}`,
              fields: [{ name: 'bRef', type: 'belongsTo', target: `latticeCustomCycleB${suffix}` }],
            },
            {
              collectionName: `latticeCustomCycleB${suffix}`,
              fields: [{ name: 'aRef', type: 'belongsTo', target: `latticeCustomCycleA${suffix}` }],
            },
          ],
        },
      },
    });
    assert.ok(
      cycleRes.json?.error || cycleRes.json?.result?.isError === true,
      'Cyclic Multi-Entity Blueprint (A -> B -> A) must be rejected',
    );

    const protectedRes = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'dxos_provision_role_workspace',
        arguments: {
          operation: 'build_enterprise_app',
          portalSlug,
          pageTitle: `Protected Reject ${suffix}`,
          collectionName: 'users',
        },
      },
    });
    assert.ok(
      protectedRes.json?.error || protectedRes.json?.result?.isError === true,
      'SYSTEM_PROTECTED_COLLECTIONS target (users) must be rejected',
    );
    checks.cycleAndProtectedTargetsRefusedOk = true;

    // 4. Multi-Entity Full-Stack App Build (Parent + Child out-of-order to verify topological sort)
    const buildRpc = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'dxos_provision_role_workspace',
        arguments: {
          operation: 'build_enterprise_app',
          appKey,
          name: pageTitle,
          portalSlug,
          pageTitle,
          collections: [
            {
              collectionName: childCol,
              collectionTitle: `Đơn kiểm định ${suffix}`,
              fields: [
                { name: 'vendor', type: 'belongsTo', target: parentCol, title: 'Đối tác' },
                { name: 'status', type: 'enum', enumValues: ['draft', 'scheduled', 'completed'], title: 'Trạng thái' },
                { name: 'lat', type: 'float', title: 'Vĩ độ' },
                { name: 'lng', type: 'float', title: 'Kinh độ' },
                { name: 'scheduledAt', type: 'date', title: 'Lịch kiểm định' },
                { name: 'score', type: 'float', title: 'Điểm đánh giá' },
              ],
            },
            {
              collectionName: parentCol,
              collectionTitle: `Đối tác kiểm định ${suffix}`,
              fields: [
                { name: 'tier', type: 'enum', enumValues: ['gold', 'silver'], title: 'Hạng' },
              ],
            },
          ],
          roles: [
            {
              roleName,
              roleTitle: `Vận hành Kiểm định ${suffix}`,
              lockedFields: ['score'],
            },
          ],
          portals: [
            {
              portalSlug,
              pageTitle,
              roleName,
              roleTitle: `Vận hành Kiểm định ${suffix}`,
              collectionName: childCol,
              blocks: [
                { blockUse: 'DxosKanbanScheduleBlockModel', title: `Kanban ${suffix}` },
                { blockUse: 'DxosWebGisBlockModel', title: `WebGIS ${suffix}` },
                { blockUse: 'DxosRecordWorkbenchBlockModel', title: `Chứng từ ${suffix}` },
              ],
            },
          ],
          dmnTables: [
            {
              tableKey: dmnTableKey,
              name: `DMN SLA ${suffix}`,
              hitPolicy: 'FIRST',
              inputsJson: [{ name: 'score', type: 'number' }],
              outputsJson: [{ name: 'tier', type: 'string' }],
              rulesJson: [
                { when: { score: { op: 'gte', value: 80 } }, then: { tier: 'pass' } },
                { when: { score: '*' }, then: { tier: 'review' } },
              ],
              sampleInput: { score: 92 },
            },
          ],
          flowGraphs: [
            {
              ruleKey: flowRuleKey,
              name: `Flow Multi ${suffix}`,
              graphJson: {
                version: 2,
                nodes: [
                  { id: 'trig_1', type: 'trigger.record', label: 'On Order', config: { collection: childCol, operation: 'create' } },
                  { id: 'dmn_1', type: 'logic.dmn', label: 'Evaluate SLA', config: { tableKey: dmnTableKey } },
                ],
                edges: [{ id: 'e1', source: 'trig_1', sourceHandle: 'main', target: 'dmn_1', targetHandle: 'in' }],
              },
              sampleEvent: { type: `record.${childCol}.create`, data: { code: `ORD-${suffix}`, score: 92 } },
            },
          ],
        },
      },
    });
    const built = parseMcpToolResult(buildRpc, 'build_enterprise_app');
    cleanup.aiUsername = built.aiEmployee || null;
    cleanup.preBuildSnapshotUid = built.preBuildSnapshotUid || null;
    cleanup.portals = Array.isArray(built.portals) ? built.portals : [];

    assert.equal(built.built, true);
    assert.equal(built.ok, true, `Multi-entity build failed verification: ${JSON.stringify(built.verification)}`);
    assert.equal(built.appKey, appKey);
    assert.equal(built.appVersion, 1);
    assert.ok(Array.isArray(built.collections));
    const parentIdx = built.collections.indexOf(parentCol);
    const childIdx = built.collections.indexOf(childCol);
    assert.ok(parentIdx >= 0 && childIdx > parentIdx, `Topological sort failed: ${JSON.stringify(built.collections)}`);
    assert.equal(built.verification?.ok, true);
    checks.multiEntityBuildAndTopoOrderOk = true;

    // 5. collectionsMeta & OpenAPI 3.1.0 exposure
    const metaRes = await callActor('root', 'dxosBlocks:collectionsMeta');
    assert.ok(metaRes.ok && metaRes.status < 300, `collectionsMeta failed: ${metaRes.status}`);
    const metaCols = Array.isArray(metaRes.data?.collections) ? metaRes.data.collections : [];
    const childMeta = metaCols.find((c) => c?.name === childCol);
    const parentMeta = metaCols.find((c) => c?.name === parentCol);
    assert.ok(parentMeta && parentMeta.isCustom === true, `${parentCol} missing from collectionsMeta`);
    assert.ok(childMeta && childMeta.isCustom === true, `${childCol} missing from collectionsMeta`);
    const statusField = (childMeta.fields || []).find((f) => f?.name === 'status');
    assert.ok(statusField && Array.isArray(statusField.enumValues) && statusField.enumValues.length >= 3, 'status enumValues missing in collectionsMeta');

    const openapiRes = await callActor('anon', 'dxos:openapi');
    assert.ok(openapiRes.ok);
    assert.equal(openapiRes.data?.openapi, '3.1.0');
    assert.ok(openapiRes.data?.paths?.[`/api/${childCol}:list`]?.get, `OpenAPI missing GET /api/${childCol}:list`);
    assert.ok(openapiRes.data?.paths?.[`/api/${parentCol}:create`]?.post, `OpenAPI missing POST /api/${parentCol}:create`);
    checks.collectionsMetaAndOpenApiOk = true;

    // 6. Dynamic Kanban / WebGIS / Chatter & PG RLS Tenant Isolation on custom collections
    const parentRecRes = await callActor('root', `${parentCol}:create`, {
      method: 'POST',
      values: { organizationId, code: `VND-${suffix}`, name: `Vendor ${suffix}`, tier: 'gold', status: 'active' },
    });
    assert.ok(parentRecRes.ok && parentRecRes.data?.id, `Create parent record failed: ${JSON.stringify(parentRecRes.data)}`);

    const childRecRes = await callActor('root', `${childCol}:create`, {
      method: 'POST',
      values: {
        organizationId,
        code: `ORD-${suffix}`,
        name: `Order ${suffix}`,
        status: 'scheduled',
        vendorId: parentRecRes.data.id,
        lat: 10.0452,
        lng: 105.7469,
        scheduledAt: new Date().toISOString(),
        score: 95,
      },
    });
    assert.ok(childRecRes.ok && childRecRes.data?.id, `Create child record failed: ${JSON.stringify(childRecRes.data)}`);
    const childRecordId = childRecRes.data.id;

    // Cross-org record should NEVER leak to tenant employee
    const crossRecRes = await callActor('root', `${childCol}:create`, {
      method: 'POST',
      values: {
        organizationId: otherOrgId,
        code: `CROSS-${suffix}`,
        name: `Cross Org ${suffix}`,
        status: 'draft',
      },
    });
    assert.ok(crossRecRes.ok && crossRecRes.data?.id);
    const empList = await callActor('employee', `${childCol}:list?pageSize=50`);
    if (empList.ok) {
      const empRows = unwrapList(empList.data);
      assert.equal(empRows.some((r) => Number(r?.id) === Number(crossRecRes.data.id)), false, 'RLS breach: employee saw cross-org custom record');
    } else {
      assert.equal(empList.status, 403);
    }

    // Dynamic Kanban/WebGIS backing query check
    const rootList = await callActor('root', `${childCol}:list?pageSize=20`);
    assert.ok(rootList.ok);
    const listedChildren = unwrapList(rootList.data);
    const ownChild = listedChildren.find((r) => Number(r?.id) === Number(childRecordId));
    assert.ok(ownChild && ownChild.status === 'scheduled' && Number(ownChild.lat) === 10.0452, 'Dynamic Kanban/WebGIS fields missing from REST');

    // Chatter on custom collection
    const postChatter = await callActor('root', 'latticeChatter:post', {
      method: 'POST',
      values: {
        targetCollection: childCol,
        targetRecordId: childRecordId,
        body: `Acceptance chatter check ${suffix}`,
      },
    });
    assert.ok(postChatter.ok, `latticeChatter:post failed on ${childCol}: ${JSON.stringify(postChatter.data)}`);
    if (postChatter.data?.id != null) cleanup.chatterIds.push(postChatter.data.id);

    const listChatter = await callActor(
      'root',
      `latticeChatter:list?targetCollection=${encodeURIComponent(childCol)}&targetRecordId=${encodeURIComponent(childRecordId)}`,
    );
    assert.ok(listChatter.ok);
    assert.ok(unwrapList(listChatter.data).some((c) => String(c?.body || '').includes(suffix)), 'Chatter entry missing');
    checks.dynamicKanbanWebgisChatterRlsOk = true;

    // 7. listBuiltApps -> rebuildBuiltApp -> exportBuiltAppBundle (v3)
    const listAppsRes = await callActor('root', `dxosAi:listBuiltApps?organizationId=${encodeURIComponent(organizationId)}`);
    assert.ok(listAppsRes.ok);
    const listedApp = unwrapList(listAppsRes.data).find((a) => a?.appKey === appKey);
    assert.ok(listedApp && listedApp.version === 1 && listedApp.status === 'active', 'Built app missing in dxosAi:listBuiltApps');

    const rebuildRes = await callActor('root', 'dxosAi:rebuildBuiltApp', {
      method: 'POST',
      values: { organizationId, appKey },
    });
    assert.ok(rebuildRes.ok, `rebuildBuiltApp failed: ${JSON.stringify(rebuildRes.data)}`);
    assert.equal(rebuildRes.data?.rebuilt, true);
    assert.equal(rebuildRes.data?.ok, true);
    assert.equal(rebuildRes.data?.appVersion, 2);

    const exportRes = await callActor(
      'root',
      `dxosAi:exportBuiltAppBundle?organizationId=${encodeURIComponent(organizationId)}&appKey=${encodeURIComponent(appKey)}`,
    );
    assert.ok(exportRes.ok, `exportBuiltAppBundle failed: ${JSON.stringify(exportRes.data)}`);
    const bundle = exportRes.data;
    assert.equal(bundle?.metadata?.schemaVersion, 'latticedx.solution-bundle/v3');
    assert.equal(bundle?.metadata?.appKey, appKey);
    assert.equal(bundle?.metadata?.appVersion, 2);
    assert.ok((bundle?.customCollections || []).some((c) => c?.name === parentCol), 'Bundle v3 missing parentCol');
    assert.ok((bundle?.customCollections || []).some((c) => c?.name === childCol), 'Bundle v3 missing childCol');
    assert.ok((bundle?.governance?.decisionTables || []).some((t) => t?.tableKey === dmnTableKey), 'Bundle v3 missing DMN table');
    assert.ok((bundle?.governance?.automationRules || []).some((r) => r?.ruleKey === flowRuleKey), 'Bundle v3 missing Flow v2 rule');
    checks.rebuildAndExportV3Ok = true;

    // 8. Safe Teardown (keepData: true preserves collections & rows)
    const tdKeepRes = await callActor('root', 'dxosAi:teardownBuiltApp', {
      method: 'POST',
      values: { organizationId, appKey, keepData: true },
    });
    assert.ok(tdKeepRes.ok, `teardownBuiltApp keepData:true failed: ${JSON.stringify(tdKeepRes.data)}`);
    assert.equal(tdKeepRes.data?.torndown, true);
    assert.equal(tdKeepRes.data?.keepData, true);
    assert.ok((tdKeepRes.data?.preservedCollections || []).includes(childCol), 'keepData:true must preserve childCol');
    assert.ok((tdKeepRes.data?.preservedCollections || []).includes(parentCol), 'keepData:true must preserve parentCol');

    const afterTdList = await callActor('root', `${childCol}:list?pageSize=20`);
    assert.ok(afterTdList.ok && unwrapList(afterTdList.data).some((r) => Number(r?.id) === Number(childRecordId)), 'Data must remain readable after keepData:true teardown');
    checks.teardownKeepDataOk = true;

    return {
      status: 'PASS',
      result: 'PASS',
      organizationId,
      appKey,
      checks,
      builtCollections: built.collections,
      rebuildVersion: rebuildRes.data.appVersion,
      bundleSchemaVersion: bundle.metadata.schemaVersion,
    };
  } finally {
    // Full cleanup: drop temporary collections, registry, rules, DMN, AI profile, routes, snapshots
    await callActor('root', 'dxosAi:teardownBuiltApp', {
      method: 'POST',
      values: { organizationId, appKey, keepData: false },
    }).catch(() => {});

    for (const cId of cleanup.chatterIds) {
      await callActor('root', `latticeRecordChatter:destroy?filterByTk=${encodeURIComponent(cId)}`, { method: 'POST' }).catch(() => {});
    }
    await destroyMatchingIds(callActor, 'latticeBuiltApps', { organizationId, appKey });
    await callActor('root', 'dxosAutomations:deleteRule', {
      method: 'POST',
      values: { organizationId, ruleKey: flowRuleKey },
    }).catch(() => {});
    await destroyMatchingIds(callActor, 'latticeDecisionTables', { organizationId, tableKey: dmnTableKey });
    if (cleanup.aiUsername) {
      await callActor('root', 'dxosAi:deleteProfile', {
        method: 'POST',
        values: { username: cleanup.aiUsername },
      }).catch(() => {});
    }
    if (cleanup.preBuildSnapshotUid) {
      await destroyMatchingIds(callActor, 'latticeUiSnapshots', { snapshotUid: cleanup.preBuildSnapshotUid });
    }
    for (const p of cleanup.portals) {
      const uids = new Set([
        ...(Array.isArray(p?.blockUids) ? p.blockUids : []),
        ...(Array.isArray(p?.attachedBlocks) ? p.attachedBlocks.map((b) => b?.blockUid || b?.uid).filter(Boolean) : []),
      ]);
      for (const blkUid of uids) {
        await callActor('root', `flowModels:destroy?filterByTk=${encodeURIComponent(blkUid)}`, { method: 'POST' }).catch(() => {});
      }
      if (p?.gridUid) {
        await callActor('root', `flowModels:destroy?filterByTk=${encodeURIComponent(p.gridUid)}`, { method: 'POST' }).catch(() => {});
      }
      const pageId = p?.pageRoute?.id;
      const groupId = p?.pageRoute?.parentId;
      if (pageId != null) {
        await destroyMatchingIds(callActor, 'desktopRoutes', { parentId: pageId });
        await callActor('root', `desktopRoutes:destroy?filterByTk=${encodeURIComponent(pageId)}`, { method: 'POST' }).catch(() => {});
      }
      if (groupId != null) {
        await callActor('root', `desktopRoutes:destroy?filterByTk=${encodeURIComponent(groupId)}`, { method: 'POST' }).catch(() => {});
      }
    }
    await destroyMatchingIds(callActor, 'roles', { name: roleName }, 'name');
    await cleanupPortalRoleReferences(callActor, [roleName]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const opts = parseBlankSlateAcceptanceArgs(process.argv.slice(2));
    let origin = opts.origin;
    if (opts.reportPath) {
      const report = JSON.parse(await readFile(resolve(opts.reportPath), 'utf8'));
      origin = assertSafeLabOrigin(report.origin);
    }
    const { callActor, rpcRequest } = await createBlankSlateAcceptanceCallers(origin);
    const summary = await runBlankSlateAppBuilderAcceptance(callActor, rpcRequest, { organizationId: opts.organizationId });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.result !== 'PASS') process.exitCode = 1;
  })().catch((err) => {
    console.error(JSON.stringify({ status: 'FAIL', result: 'FAIL', error: err.message }));
    process.exitCode = 1;
  });
}
