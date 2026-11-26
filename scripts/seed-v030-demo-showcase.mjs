#!/usr/bin/env node
/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ORIGIN = 'http://localhost:13014';
const DEFAULT_ORG = 'native-ui-lab';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

const COLD_CHAIN_SERIES_C = [
  2.4, 2.5, 2.6, 2.8, 3.0, 3.2,
  3.5, 3.9, 4.4, 5.2, 6.8, 8.6,
  9.2, 8.1, 6.0, 4.3, 3.4, 2.9,
];

export function assertLoopbackOrigin(rawOrigin) {
  if (typeof rawOrigin !== 'string' || !rawOrigin.trim()) {
    throw new Error('Missing NOCOBASE_URL / --origin');
  }
  let parsed;
  try {
    parsed = new URL(rawOrigin.trim());
  } catch {
    throw new Error(`Invalid origin URL: "${rawOrigin}"`);
  }
  if (parsed.protocol !== 'http:') {
    throw new Error(`Unsafe protocol "${parsed.protocol}": only http:// loopback origins are allowed`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Origin URL must not embed credentials');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Unsafe non-loopback host "${parsed.hostname}": only localhost or 127.0.0.1 is allowed`);
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in origin "${rawOrigin}"`);
  }
  return parsed.origin;
}

export function parseSeedArgs(argv, env = process.env) {
  let origin = env.NOCOBASE_URL || DEFAULT_ORIGIN;
  let organizationId = env.NOCOBASE_ORG_ID || DEFAULT_ORG;
  let adminEmail = env.NOCOBASE_ADMIN_EMAIL || 'admin@nocobase.com';
  let adminPassword = env.NOCOBASE_ADMIN_PASSWORD || env.DX_LAB_ADMIN_PASSWORD || '';
  let token = env.NOCOBASE_TOKEN || '';
  let seedSamples = ['1', 'true'].includes(String(env.DX_SEED_SAMPLES || '').trim().toLowerCase());

  for (const arg of argv) {
    if (arg.startsWith('--origin=')) {
      origin = arg.slice('--origin='.length);
    } else if (arg.startsWith('--org=')) {
      organizationId = arg.slice('--org='.length).trim();
    } else if (arg.startsWith('--admin-email=')) {
      adminEmail = arg.slice('--admin-email='.length).trim();
    } else if (arg.startsWith('--admin-password=')) {
      adminPassword = arg.slice('--admin-password='.length);
    } else if (arg.startsWith('--token=')) {
      token = arg.slice('--token='.length);
    } else if (arg === '--seed-samples') {
      seedSamples = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(organizationId)) {
    throw new Error(`Invalid --org "${organizationId}"`);
  }

  return {
    help: false,
    origin: assertLoopbackOrigin(origin),
    organizationId,
    adminEmail,
    adminPassword,
    token: String(token || '').trim(),
    seedSamples,
  };
}

function unwrapList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.rows)) return res.rows;
  if (Array.isArray(res?.items)) return res.items;
  if (Array.isArray(res?.data)) return res.data;
  return [];
}

export async function createSeederClient(
  { origin, token = '', adminEmail = 'admin@nocobase.com', adminPassword = '' },
  fetchImpl = fetch,
) {
  const safeOrigin = assertLoopbackOrigin(origin);
  let activeToken = String(token || '').trim();

  async function request(path, { method = 'GET', values, raw = false, headers: extraHeaders = {} } = {}) {
    const res = await fetchImpl(new URL(path.startsWith('/') ? path : `/api/${path}`, safeOrigin), {
      method,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        ...(activeToken ? { authorization: `Bearer ${activeToken}`, 'X-Role': 'root' } : {}),
        ...extraHeaders,
      },
      ...(values !== undefined ? { body: JSON.stringify(values) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { errors: [{ message: text.slice(0, 300) || 'Non-JSON response' }] };
    }
    if (!res.ok) {
      const err = payload?.errors?.[0] || payload?.error;
      const msg = [err?.code, err?.message].filter(Boolean).join(': ') || `HTTP ${res.status}`;
      throw new Error(`${path.split('?')[0]} HTTP ${res.status}: ${msg}`);
    }
    if (raw) return payload;
    return payload.data !== undefined ? payload.data : payload;
  }

  if (!activeToken) {
    if (!adminPassword) {
      throw new Error(
        'Authentication required: provide NOCOBASE_TOKEN, NOCOBASE_ADMIN_PASSWORD, DX_LAB_ADMIN_PASSWORD, or --admin-password=...',
      );
    }
    const auth = await request('auth:signIn', {
      method: 'POST',
      values: { email: adminEmail, password: adminPassword },
    });
    if (!auth?.token) {
      throw new Error('auth:signIn did not return a bearer token');
    }
    activeToken = auth.token;
  }

  return request;
}

async function findByCode(api, collection, organizationId, code) {
  const filter = encodeURIComponent(JSON.stringify({ organizationId, code }));
  const rows = unwrapList(await api(`${collection}:list?filter=${filter}&pageSize=5`));
  return rows[0] || null;
}

async function ensureDemoContext(api, organizationId) {
  const deptFilter = encodeURIComponent(JSON.stringify({ organizationId }));
  const depts = unwrapList(await api(`latticeDepartments:list?filter=${deptFilter}&pageSize=10`));
  const emps = unwrapList(await api(`latticeEmployees:list?filter=${deptFilter}&pageSize=50`));
  const activeEmps = emps.filter((e) => e?.active !== false);
  const mentionTarget = activeEmps.find((e) => e?.userId && e?.email) || activeEmps.find((e) => e?.userId) || activeEmps[0] || null;
  let mentionHandle = 'operator';
  if (mentionTarget?.email && String(mentionTarget.email).includes('@')) {
    mentionHandle = String(mentionTarget.email).split('@')[0].trim();
  } else if (mentionTarget?.code) {
    mentionHandle = String(mentionTarget.code).trim();
  }
  return {
    departmentId: depts[0]?.id ?? null,
    requesterId: activeEmps[0]?.id ?? null,
    requesterUserId: activeEmps[0]?.userId ?? 1,
    mentionHandle,
  };
}

async function seedVouchers(api, organizationId, ctx) {
  const baseFields = {
    organizationId,
    active: true,
    ...(ctx.departmentId ? { departmentId: ctx.departmentId } : {}),
    ...(ctx.requesterId ? { requesterId: ctx.requesterId } : {}),
  };

  let req1 = await findByCode(api, 'latticeRequests', organizationId, 'REQ-2026-001');
  const created = [];
  if (!req1) {
    req1 = await api('latticeRequests:create', {
      method: 'POST',
      values: {
        ...baseFields,
        code: 'REQ-2026-001',
        name: 'Yêu cầu cấp phát cảm biến nhiệt độ PT100 dự phòng',
        category: 'equipment',
        description: 'Bổ sung 04 cảm biến PT100 chuẩn công nghiệp cho hệ thống Kho lạnh trung tâm.',
        status: 'draft',
      },
    });
    created.push('REQ-2026-001');
  }

  let req2 = await findByCode(api, 'latticeRequests', organizationId, 'REQ-2026-002');
  if (!req2) {
    req2 = await api('latticeRequests:create', {
      method: 'POST',
      values: {
        ...baseFields,
        code: 'REQ-2026-002',
        name: 'Yêu cầu bảo trì định kỳ máy nén lạnh Chiller-01',
        category: 'maintenance',
        description: 'Kiểm tra áp suất gas, vệ sinh dàn ngưng và hiệu chuẩn ngưỡng cảnh báo +8°C.',
        status: 'draft',
      },
    });
    created.push('REQ-2026-002');
  }
  if (String(req2.status || 'draft').toLowerCase() === 'draft') {
    req2 = await api('latticeVoucher:submit', {
      method: 'POST',
      values: { collection: 'latticeRequests', id: req2.id, expectedVersion: req2.version },
    });
  }

  let req3 = await findByCode(api, 'latticeRequests', organizationId, 'REQ-2026-003');
  if (!req3) {
    req3 = await api('latticeRequests:create', {
      method: 'POST',
      values: {
        ...baseFields,
        code: 'REQ-2026-003',
        name: 'Yêu cầu nâng cấp hệ thống làm lạnh Kho lạnh 01',
        category: 'procurement',
        description: 'Đề xuất ban đầu trước khi điều chỉnh thông số kỹ thuật.',
        status: 'draft',
      },
    });
    created.push('REQ-2026-003');
  }
  if (String(req3.status || 'draft').toLowerCase() === 'draft') {
    req3 = await api('latticeVoucher:submit', {
      method: 'POST',
      values: { collection: 'latticeRequests', id: req3.id, expectedVersion: req3.version },
    });
  }
  if (['submitted', 'approved', 'in_progress'].includes(String(req3.status || '').toLowerCase())) {
    req3 = await api('latticeVoucher:cancel', {
      method: 'POST',
      values: {
        collection: 'latticeRequests',
        id: req3.id,
        expectedVersion: req3.version,
        cancelReason: 'Điều chỉnh công suất máy nén và thông số kỹ thuật theo thẩm định v0.3.0',
      },
    });
  }

  let req3Amd1 = await findByCode(api, 'latticeRequests', organizationId, 'REQ-2026-003-AMD1');
  if (!req3Amd1 && String(req3.status || '').toLowerCase() === 'cancelled') {
    const amended = await api('latticeVoucher:amend', {
      method: 'POST',
      values: {
        collection: 'latticeRequests',
        id: req3.id,
        patch: {
          name: 'Yêu cầu nâng cấp hệ thống làm lạnh Kho lạnh 01 (Bản điều chỉnh 1)',
          description: 'Cập nhật công suất máy nén biến tần và cảm biến PT100 đạt chuẩn OLP PMNM 2026.',
        },
      },
    });
    req3Amd1 = amended?.amended || amended;
    created.push('REQ-2026-003-AMD1');
  }

  return {
    created,
    requests: {
      draftId: req1?.id ?? null,
      submittedId: req2?.id ?? null,
      cancelledId: req3?.id ?? null,
      amendedId: req3Amd1?.id ?? null,
    },
  };
}

async function seedChatterComments(api, requests, mentionHandle) {
  const targets = [
    {
      targetRecordId: requests.draftId,
      body: `[v0.3.0] Đã chuẩn bị hồ sơ kỹ thuật PT100, nhờ @${mentionHandle} rà soát cấu hình trước khi trình duyệt.`,
    },
    {
      targetRecordId: requests.submittedId,
      body: `[v0.3.0] Đề nghị @${mentionHandle} ưu tiên kiểm tra bảo trì COLD-CHILLER-01 trong ca trực hôm nay.`,
    },
    {
      targetRecordId: requests.cancelledId,
      body: '[v0.3.0] Đã khóa chứng từ gốc và lưu vết lý do hủy để lập bản điều chỉnh phả hệ.',
    },
    {
      targetRecordId: requests.amendedId,
      body: `[v0.3.0] Bản điều chỉnh REQ-2026-003-AMD1 đã kế thừa dữ liệu và sẵn sàng để @${mentionHandle} xem xét.`,
    },
  ];

  let posted = 0;
  let skipped = 0;
  for (const item of targets) {
    if (!item.targetRecordId) continue;
    const existing = await api(
      `latticeChatter:list?targetCollection=latticeRequests&targetRecordId=${item.targetRecordId}&limit=50`,
    );
    const items = unwrapList(existing);
    const alreadyPresent = items.some((row) => row?.entryType === 'comment' && String(row?.body || '').trim() === item.body);
    if (alreadyPresent) {
      skipped += 1;
      continue;
    }
    await api('latticeChatter:post', {
      method: 'POST',
      values: {
        targetCollection: 'latticeRequests',
        targetRecordId: item.targetRecordId,
        body: item.body,
      },
    });
    posted += 1;
  }
  return { posted, skipped };
}

async function seedSlaPolicies(api, organizationId) {
  const policies = [
    {
      organizationId,
      targetCollection: 'latticeRequests',
      priority: 'high',
      warnAfterMinutes: 30,
      breachAfterMinutes: 60,
      escalateToRole: 'ldx_manager',
      notifyChannels: ['in_app'],
      active: true,
    },
    {
      organizationId,
      targetCollection: 'latticeIncidentCases',
      priority: 'critical',
      warnAfterMinutes: 15,
      breachAfterMinutes: 45,
      escalateToRole: 'ldx_admin',
      notifyChannels: ['in_app'],
      active: true,
    },
  ];
  for (const values of policies) {
    await api('latticeSla:savePolicy', { method: 'POST', values });
  }
  const evaluation = await api('latticeSla:evaluateNow', {
    method: 'POST',
    values: { organizationId },
  });
  return { savedPolicies: policies.length, evaluation };
}

async function seedColdChainTelemetry(api, organizationId, ctx) {
  let asset = await findByCode(api, 'latticeAssets', organizationId, 'COLD-CHILLER-01');
  if (!asset) {
    asset = await api('latticeAssets:create', {
      method: 'POST',
      values: {
        code: 'COLD-CHILLER-01',
        name: 'Hệ thống Kho lạnh Trung tâm 01',
        organizationId,
        kind: 'cold-chiller',
        status: 'active',
        active: true,
        ...(ctx.departmentId ? { departmentId: ctx.departmentId } : {}),
      },
    });
  }
  const assetEntityId = `urn:ngsi-ld:Asset:${organizationId}:native:${asset.id}`;
  const existing = await api(
    `dxosBlocks:telemetrySeries?organizationId=${encodeURIComponent(organizationId)}&assetEntityId=${encodeURIComponent(assetEntityId)}&attribute=temperature&windowHours=24&limit=100`,
  ).catch(() => ({ points: [] }));
  const existingPoints = Array.isArray(existing?.points) ? existing.points : [];

  const nowMs = Date.now();
  const intervalMs = Math.floor((23 * 60 * 60 * 1000) / (COLD_CHAIN_SERIES_C.length - 1));
  const existingTimestamps = existingPoints
    .map((p) => Date.parse(String(p?.timestamp || p?.observedAt || '')))
    .filter((ts) => Number.isFinite(ts));

  let ingested = 0;
  let skipped = 0;
  for (let i = 0; i < COLD_CHAIN_SERIES_C.length; i += 1) {
    const slotMs = nowMs - (COLD_CHAIN_SERIES_C.length - 1 - i) * intervalMs;
    const hasNearby = existingTimestamps.some((ts) => Math.abs(ts - slotMs) <= 25 * 60 * 1000);
    if (hasNearby || existingPoints.length >= COLD_CHAIN_SERIES_C.length) {
      skipped += 1;
      continue;
    }
    const numericValue = COLD_CHAIN_SERIES_C[i];
    await api('dxosBlocks:telemetryIngest', {
      method: 'POST',
      values: {
        organizationId,
        assetId: asset.id,
        assetEntityId,
        metricName: 'temperature',
        numericValue,
        unit: 'Cel',
        quality: numericValue > 8.0 ? 'suspect' : 'good',
        sourceProtocol: 'mqtt-node-red',
        observedAt: new Date(slotMs).toISOString(),
      },
    });
    ingested += 1;
  }

  return { assetId: asset.id, assetEntityId, ingested, skipped, targetPoints: COLD_CHAIN_SERIES_C.length };
}

async function seedHitlApproval(api, organizationId, requests, ctx) {
  const listed = await api(`dxosAi:listApprovals?status=all&limit=20&organizationId=${encodeURIComponent(organizationId)}`);
  const items = unwrapList(listed);
  if (items.length > 0) {
    return { seeded: false, existingCount: items.length, approvalId: items[0]?.id ?? null };
  }

  const targetId = requests.draftId || requests.amendedId;
  let mcpResult = null;
  if (targetId) {
    try {
      const rpc = await api('/api/dxos-mcp', {
        method: 'POST',
        raw: true,
        values: {
          jsonrpc: '2.0',
          id: 'seed-hitl-1',
          method: 'tools/call',
          params: {
            name: 'dxos_execute_record_action',
            arguments: {
              collection: 'latticeRequests',
              operation: 'update',
              recordId: Number(targetId),
              values: {
                description: 'AI đề xuất bổ sung hạng mục hiệu chuẩn PT100 (chờ phê duyệt HITL).',
              },
              requireApproval: true,
            },
          },
        },
      });
      const parsedText = rpc?.result?.content?.[0]?.text;
      if (parsedText) {
        mcpResult = JSON.parse(parsedText);
      }
    } catch {
      mcpResult = null;
    }
  }

  if (mcpResult?.status === 'pending_approval' && mcpResult?.approvalId) {
    return { seeded: true, via: 'dxos_execute_record_action', approvalId: mcpResult.approvalId };
  }

  const created = await api('latticeAiApprovalQueue:create', {
    method: 'POST',
    values: {
      organizationId,
      requesterUserId: Number(ctx.requesterUserId || 1),
      requesterUsername: 'kho-lanh-ops',
      aiEmployee: 'kho-lanh-ops',
      toolName: 'dxos_execute_record_action',
      targetCollection: 'latticeRequests',
      ...(targetId ? { targetRecordId: Number(targetId) } : {}),
      operation: 'update',
      proposedArgs: {
        collection: 'latticeRequests',
        operation: 'update',
        ...(targetId ? { recordId: Number(targetId) } : {}),
        values: { description: 'AI đề xuất bổ sung hạng mục hiệu chuẩn PT100 (chờ phê duyệt HITL).' },
      },
      diffPreview: {
        collection: 'latticeRequests',
        operation: 'update',
        changes: [{ field: 'description', after: 'AI đề xuất bổ sung hạng mục hiệu chuẩn PT100 (chờ phê duyệt HITL).' }],
      },
      riskLevel: 'medium',
      status: 'pending',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  return { seeded: true, via: 'latticeAiApprovalQueue:create', approvalId: created?.id ?? null };
}

export async function seedStudioShowcaseSamples(api, organizationId) {
  try {
    return await api('dxosStudio:seedShowcaseData', {
      method: 'POST',
      values: { organizationId },
    });
  } catch (err) {
    if (/HTTP (404|501):/.test(err?.message || '')) {
      return { seeded: false, skippedReason: err.message };
    }
    throw err;
  }
}

export async function runV030DemoShowcaseSeed(options, fetchImpl = fetch) {
  const api = await createSeederClient(options, fetchImpl);
  const { organizationId } = options;

  const ctx = await ensureDemoContext(api, organizationId);
  const vouchers = await seedVouchers(api, organizationId, ctx);
  const chatter = await seedChatterComments(api, vouchers.requests, ctx.mentionHandle);
  const sla = await seedSlaPolicies(api, organizationId);
  const telemetry = await seedColdChainTelemetry(api, organizationId, ctx);
  const studioShowcase = options?.seedSamples === true
    ? await seedStudioShowcaseSamples(api, organizationId)
    : undefined;
  const paraReindex = await api('latticePara:reindex', {
    method: 'POST',
    values: { organizationId },
  });
  const hitl = await seedHitlApproval(api, organizationId, vouchers.requests, ctx);
  const portals = await api('dxosStudio:composePortals', {
    method: 'POST',
    values: {},
  });

  return {
    result: 'PASS',
    origin: options.origin,
    organizationId,
    vouchers,
    chatter,
    sla,
    telemetry,
    ...(studioShowcase !== undefined ? { studioShowcase } : {}),
    paraReindex,
    hitl,
    portals,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseSeedArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(
        'Usage: node scripts/seed-v030-demo-showcase.mjs [--origin=http://localhost:13014] [--org=native-ui-lab] [--admin-email=admin@nocobase.com] [--admin-password=...] [--token=...] [--seed-samples]',
      );
      process.exit(0);
    }
    const summary = await runV030DemoShowcaseSeed(parsed);
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ result: 'FAIL', error: err.message }));
    process.exitCode = 1;
  }
}
