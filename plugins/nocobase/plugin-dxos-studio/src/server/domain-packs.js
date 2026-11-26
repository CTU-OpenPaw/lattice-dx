/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { RULE_KEY_RE } = require('./automation-engine');
const { getFlowBlueprint } = require('./flow/blueprints');
const { buildTriggerIndex, graphV2SummaryToV1Compat } = require('./flow/schema');
const {
  fail,
  readParams,
  runWithOptionalRls,
  runWithSystemRlsBypass,
  toPlain,
} = require('./wms-dmn-shared');
const { createBuilderApplyBlueprint, upsertRepoRow } = require('./domain-portal-composer');
const { createOrUpdateDomainCollection } = require('./domain-schema-rls');

function replaceStepNodeRefs(value, nodeIndexById) {
  if (typeof value === 'string') {
    let out = value;
    for (const [nodeId, idx] of nodeIndexById.entries()) {
      out = out.split(`{{steps.${nodeId}.`).join(`{{steps.${idx}.`);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => replaceStepNodeRefs(item, nodeIndexById));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceStepNodeRefs(v, nodeIndexById);
    return out;
  }
  return value;
}

function projectBlueprintToV1Actions(flowBlueprint) {
  if (!flowBlueprint?.graphJson?.nodes?.length) return [];
  const compat = graphV2SummaryToV1Compat(flowBlueprint);
  const actions = Array.isArray(compat.actionsJson) ? compat.actionsJson : [];
  const { nodes = [], edges = [] } = flowBlueprint.graphJson;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const v1MappedTypes = new Set(['data.create', 'data.update', 'notify.send', 'integration.http', 'iot.twin_command', 'ai.agent']);
  const actionNodes = nodes
    .filter((n) => v1MappedTypes.has(n.type))
    .sort((a, b) => Number(a.config?.stepIndex ?? 9999) - Number(b.config?.stepIndex ?? 9999));
  const nodeIndexById = new Map(actionNodes.map((n, idx) => [n.id, idx]));

  const findBranchGuard = (startId) => {
    const visited = new Set();
    const queue = [startId];
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of edges.filter((e) => e.target === id)) {
        const src = nodeMap.get(edge.source);
        if (!src) continue;
        if (src.type === 'control.if' && edge.sourceHandle === 'true' && src.config?.condition) {
          const c = src.config.condition;
          const when = typeof c.field === 'string' && (c.op === 'eq' || c.op === '$eq') && c.value !== undefined
            ? { [c.field]: c.value }
            : structuredClone(c);
          return { when, branchLabel: edge.label || src.config?.branchLabel || null };
        }
        if (src.type === 'control.parallel') queue.push(src.id);
      }
    }
    return null;
  };

  return actions.map((act, idx) => {
    const node = actionNodes[idx];
    const guard = node ? findBranchGuard(node.id) : null;
    const enriched = guard && !act.when ? { ...act, when: guard.when, branchLabel: guard.branchLabel ?? act.branchLabel ?? null } : act;
    return replaceStepNodeRefs(enriched, nodeIndexById);
  });
}

const BUSINESS_PACK_CATALOG = Object.freeze([
  {
    packKey: 'cmms-maintenance',
    name: 'Bảo trì Thiết bị CMMS Chuỗi lạnh',
    description: 'Phiếu công việc bảo trì thiết bị, định tuyến ưu tiên DMN, tự động hóa cảnh báo chuỗi lạnh và cổng làm việc /p/cmms.',
    version: '0.4.1',
    components: {
      collection: 'latticeCustomWorkOrders',
      dmnTableKey: 'cmms_priority_routing_v1',
      automationRuleKey: 'auto_cmms_on_coldchain_fault',
      portalSlug: 'cmms',
    },
  },
  {
    packKey: 'coldchain-partner-settlement',
    name: 'Đối soát Bồi thường Đối tác Chuỗi lạnh & n8n 2 chiều',
    description: 'Hồ sơ yêu cầu bồi thường đối tác (latticeCustomPartnerClaims), chính sách DMN, luồng điều phối n8n LatticeFlow v2 và cổng /p/partner-claims.',
    version: '0.4.1',
    components: {
      collection: 'latticeCustomPartnerClaims',
      dmnTableKey: 'coldchain_settlement_policy_v1',
      automationRuleKey: 'auto_coldchain_partner_settlement',
      portalSlug: 'partner-claims',
    },
  },
]);

function buildPartnerSettlementGraphV2() {
  return {
    version: 2,
    nodes: [
      {
        id: 'trig_settlement',
        type: 'trigger.event',
        label: 'Kích hoạt Đối soát / Giữ lô MKT',
        position: { x: 60, y: 220 },
        config: {
          eventType: 'coldchain.settlement_requested,lot.held_mkt',
          filterJson: null,
        },
      },
      {
        id: 'dmn_settlement',
        type: 'logic.dmn',
        label: 'Đánh giá Chính sách Bồi thường (DMN)',
        position: { x: 340, y: 220 },
        config: {
          tableKey: 'coldchain_settlement_policy_v1',
          facts: {},
        },
      },
      {
        id: 'if_claim_required',
        type: 'control.if',
        label: 'Cần lập Hồ sơ Bồi thường?',
        position: { x: 620, y: 220 },
        config: {
          condition: {
            field: 'dmn.approveClaim',
            op: 'eq',
            value: true,
          },
        },
      },
      {
        id: 'compute_settlement_amount',
        type: 'logic.transform',
        label: 'Chuẩn hóa & Tính Giá trị Bồi thường (VND)',
        position: { x: 900, y: 140 },
        config: {
          baseFromInput: false,
          operations: [
            { op: 'coerceNumber', source: 'data.amount', target: 'safeAmount', fallback: 0 },
            { op: 'coerceNumber', source: 'dmn.settlementRatePct', target: 'safeRate', fallback: 0 },
            { op: 'coerceNumber', source: 'data.riskScore', target: 'riskScore', fallback: null },
            { op: 'coerceNumber', source: 'data.assetId', target: 'assetId', fallback: null },
            { op: 'coerceNumber', source: 'data.sourceRecordId', target: 'sourceRecordId', fallback: null },
            { op: 'math', operator: 'mul', left: 'safeAmount', right: 'safeRate', target: 'rawSettlement' },
            { op: 'math', operator: 'div', left: 'rawSettlement', right: 100, precision: 0, target: 'computedSettlementVnd' },
          ],
        },
      },
      {
        id: 'create_partner_claim',
        type: 'data.create',
        label: 'Tạo Hồ sơ Bồi thường Đối tác',
        position: { x: 1180, y: 140 },
        config: {
          collection: 'latticeCustomPartnerClaims',
          values: {
            claimCode: 'CLM-{{event.id}}',
            partnerCode: '{{data.partnerCode}}',
            partnerEmail: '{{data.partnerEmail}}',
            lotCode: '{{data.lotCode}}',
            assetId: '{{steps.compute_settlement_amount.assetId}}',
            sourceCollection: '{{data.sourceCollection}}',
            sourceRecordId: '{{steps.compute_settlement_amount.sourceRecordId}}',
            severity: '{{data.severity}}',
            riskScore: '{{steps.compute_settlement_amount.riskScore}}',
            settlementTier: '{{dmn.settlementTier}}',
            settlementRatePct: '{{dmn.settlementRatePct}}',
            claimAmountVnd: '{{steps.compute_settlement_amount.safeAmount}}',
            settlementAmountVnd: '{{steps.compute_settlement_amount.computedSettlementVnd}}',
            status: 'open',
            settlementStatus: 'pending',
          },
        },
      },
      {
        id: 'call_n8n_enterprise',
        type: 'integration.http',
        label: 'Gọi Luồng Điều phối n8n (26 nút)',
        position: { x: 1460, y: 140 },
        timeoutMs: 15000,
        config: {
          connectorKey: 'n8n-enterprise-orchestrator',
          method: 'POST',
          path: '/webhook/latticedx/v1/enterprise-compliance-orchestrator',
          timeoutMs: 15000,
          body: {
            eventType: '{{event.type}}',
            organizationId: '{{organizationId}}',
            targetCollection: 'latticeCustomPartnerClaims',
            targetRecordId: '{{steps.create_partner_claim.id}}',
            code: '{{steps.create_partner_claim.record.claimCode}}',
            amount: '{{steps.compute_settlement_amount.safeAmount}}',
            severity: '{{data.severity}}',
            temperatureC: '{{data.temperatureC}}',
            slaOverdueMinutes: '{{data.slaOverdueMinutes}}',
            partnerCode: '{{data.partnerCode}}',
            partnerEmail: '{{data.partnerEmail}}',
            lotCode: '{{data.lotCode}}',
            assetId: '{{steps.compute_settlement_amount.assetId}}',
            items: '{{data.items}}',
          },
        },
      },
      {
        id: 'notify_settlement_manager',
        type: 'notify.send',
        label: 'Thông báo Quản lý Đối soát',
        position: { x: 1740, y: 80 },
        config: {
          roleNames: ['{{dmn.assignedRole}}'],
          category: 'settlement',
          severity: 'high',
          title: 'Hồ sơ Bồi thường {{steps.create_partner_claim.record.claimCode}} ({{dmn.settlementTier}})',
          body: 'DMN {{dmn.settlementRatePct}}% ({{steps.compute_settlement_amount.computedSettlementVnd}} VND) · Phiên n8n #{{steps.call_n8n_enterprise.output.response.n8nExecutionId}}',
          targetCollection: 'latticeCustomPartnerClaims',
          targetRecordId: '{{steps.create_partner_claim.id}}',
          targetPath: '/p/partner-claims',
        },
      },
      {
        id: 'notify_n8n_error',
        type: 'notify.send',
        label: 'Cảnh báo Lỗi Gọi n8n Đối soát',
        position: { x: 1740, y: 280 },
        config: {
          roleNames: ['ldx_operator'],
          category: 'alarm',
          severity: 'high',
          title: 'Lỗi điều phối n8n Đối soát',
          body: 'Không thể gửi hồ sơ {{steps.create_partner_claim.record.claimCode}} tới n8n-enterprise-orchestrator.',
          targetCollection: 'latticeCustomPartnerClaims',
          targetRecordId: '{{steps.create_partner_claim.id}}',
          targetPath: '/p/partner-claims',
        },
      },
    ],
    edges: [
      { id: 'e_trig_dmn', source: 'trig_settlement', sourceHandle: 'main', target: 'dmn_settlement', targetHandle: 'in' },
      { id: 'e_dmn_if', source: 'dmn_settlement', sourceHandle: 'main', target: 'if_claim_required', targetHandle: 'in' },
      { id: 'e_if_calc', source: 'if_claim_required', sourceHandle: 'true', target: 'compute_settlement_amount', targetHandle: 'in', label: 'approveClaim' },
      { id: 'e_calc_create', source: 'compute_settlement_amount', sourceHandle: 'main', target: 'create_partner_claim', targetHandle: 'in' },
      { id: 'e_create_n8n', source: 'create_partner_claim', sourceHandle: 'main', target: 'call_n8n_enterprise', targetHandle: 'in' },
      { id: 'e_n8n_ok', source: 'call_n8n_enterprise', sourceHandle: 'main', target: 'notify_settlement_manager', targetHandle: 'in' },
      { id: 'e_n8n_err', source: 'call_n8n_enterprise', sourceHandle: 'error', target: 'notify_n8n_error', targetHandle: 'in', label: 'error' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: {
      errorPolicy: 'stop',
      cooldownSec: 0,
      maxDepth: 8,
      timeoutMs: 30000,
    },
  };
}

async function listBusinessPacksAction(db, ctx, next, { foundation, requireBuilderAdmin }) {
  const params = readParams(ctx);
  const { organizationId } = await requireBuilderAdmin(ctx, params, { requireOrg: false, rootOnly: false, patScopes: ['read', 'write'] });

  const colsRepo = db.getRepository?.('collections');
  const dmnRepo = db.getRepository?.('latticeDecisionTables');
  const rulesRepo = db.getRepository?.('latticeAutomationRules');

  const collectionMatches = new Map();
  for (const pack of BUSINESS_PACK_CATALOG) {
    const hasCollection =
      (colsRepo ? Boolean(await colsRepo.findOne({ filter: { name: pack.components.collection } })) : false) ||
      Boolean(db.getCollection?.(pack.components.collection));
    collectionMatches.set(pack.packKey, hasCollection);
  }

  const runPackRls = (fn) => (
    organizationId
      ? runWithOptionalRls(db, organizationId, fn, foundation)
      : runWithSystemRlsBypass(db, fn, foundation)
  );
  const items = await runPackRls(async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const out = [];
    for (const pack of BUSINESS_PACK_CATALOG) {
      const hasCollection = collectionMatches.get(pack.packKey) === true;
      const hasDmn = dmnRepo
        ? Boolean(await dmnRepo.findOne({ filter: { organizationId, tableKey: pack.components.dmnTableKey }, ...txOpt }))
        : false;
      const hasRule = rulesRepo
        ? Boolean(await rulesRepo.findOne({ filter: { organizationId, ruleKey: pack.components.automationRuleKey }, ...txOpt }))
        : false;

      out.push({
        ...pack,
        installed: Boolean(hasCollection && hasDmn && hasRule),
      });
    }
    return out;
  });
  ctx.body = { items };
  return next();
}

async function installBusinessPackAction(db, ctx, next, { foundation, requireBuilderAdmin }) {
  const params = readParams(ctx);
  const { organizationId, actor } = await requireBuilderAdmin(ctx, params, { requireOrg: true, rootOnly: true, patScopes: ['write'] });
  const packKey = String(params.packKey || '').trim();
  if (packKey !== 'cmms-maintenance' && packKey !== 'coldchain-partner-settlement') {
    throw fail('UNKNOWN_BUSINESS_PACK', 400, `Unsupported business pack "${packKey || '(empty)'}"`);
  }

  if (packKey === 'coldchain-partner-settlement') {
    const domain = await createOrUpdateDomainCollection(db, {
      collectionName: 'latticeCustomPartnerClaims',
      title: 'Hồ sơ Bồi thường Đối tác',
      description: 'Hồ sơ đối soát và bồi thường sự cố chuỗi lạnh cho đối tác với callback 2 chiều từ n8n.',
      fields: [
        { name: 'claimCode', type: 'string', title: 'Mã hồ sơ', required: true, indexed: true },
        { name: 'partnerCode', type: 'string', title: 'Mã đối tác', required: true, indexed: true },
        {
          name: 'status',
          type: 'string',
          title: 'Trạng thái hồ sơ',
          required: true,
          enumValues: ['open', 'acknowledged', 'approved', 'settled', 'rejected', 'disputed', 'resolved'],
        },
        {
          name: 'settlementStatus',
          type: 'string',
          title: 'Trạng thái thanh toán',
          required: true,
          enumValues: ['pending', 'in_review', 'approved', 'settled', 'rejected', 'disputed'],
        },
        {
          name: 'settlementTier',
          type: 'string',
          title: 'Hạng mức bồi thường',
          enumValues: ['standard', 'escalated', 'critical'],
        },
        { name: 'settlementAmountVnd', type: 'float', title: 'Số tiền bồi thường (VND)' },
        { name: 'settlementRatePct', type: 'float', title: 'Tỷ lệ bồi thường (%)' },
        { name: 'claimAmountVnd', type: 'float', title: 'Giá trị yêu cầu (VND)' },
        { name: 'riskScore', type: 'integer', title: 'Điểm rủi ro' },
        {
          name: 'severity',
          type: 'string',
          title: 'Mức độ nghiêm trọng',
          enumValues: ['low', 'normal', 'medium', 'high', 'urgent', 'critical'],
        },
        { name: 'partnerEmail', type: 'string', title: 'Email đối tác' },
        { name: 'lotCode', type: 'string', title: 'Mã lô hàng', indexed: true },
        { name: 'assetId', type: 'integer', title: 'ID Tài sản' },
        { name: 'sourceCollection', type: 'string', title: 'Bảng nguồn' },
        { name: 'sourceRecordId', type: 'integer', title: 'ID Bản ghi nguồn' },
        { name: 'externalAppSource', type: 'string', title: 'Nguồn ứng dụng ngoài' },
        { name: 'partnerReference', type: 'string', title: 'Mã tham chiếu đối tác' },
        { name: 'partnerDecisionAt', type: 'datetime', title: 'Thời điểm đối tác duyệt' },
        { name: 'resolutionNote', type: 'text', title: 'Ghi chú xử lý' },
        { name: 'n8nExecutionId', type: 'string', title: 'ID Phiên n8n' },
        { name: 'merkleRoot', type: 'string', title: 'PKI Merkle Root' },
        { name: 'orionEntityId', type: 'string', title: 'Entity ID Orion-LD' },
      ],
      roles: ['ldx_admin', 'ldx_manager', 'ldx_dispatcher', 'ldx_warehouse', 'ldx_operator', 'ldx_employee'],
      portalSlug: 'partner-claims',
      portalTitle: 'Đối soát Đối tác',
    }, {
      ctx,
      applyBlueprint: createBuilderApplyBlueprint(ctx),
    });

    const dmnRepo = db.getRepository?.('latticeDecisionTables');
    const dmnValues = {
      organizationId,
      tableKey: 'coldchain_settlement_policy_v1',
      name: 'Chính sách Đối soát Bồi thường Sự cố Chuỗi lạnh',
      description: 'Đánh giá mức độ sự cố, nhiệt độ vượt ngưỡng, điểm rủi ro và giá trị yêu cầu để xác định hạng mức, tỷ lệ bồi thường, phê duyệt và vai trò phụ trách.',
      hitPolicy: 'FIRST',
      version: 1,
      active: true,
      inputsJson: [
        { name: 'severity', type: 'string' },
        { name: 'riskScore', type: 'number' },
        { name: 'temperatureC', type: 'number' },
        { name: 'amount', type: 'number' },
        { name: 'slaOverdueMinutes', type: 'number' },
      ],
      outputsJson: [
        { name: 'settlementTier', type: 'string' },
        { name: 'settlementRatePct', type: 'number' },
        { name: 'approveClaim', type: 'boolean' },
        { name: 'assignedRole', type: 'string' },
      ],
      rulesJson: [
        {
          id: 'r1',
          when: { severity: 'critical', temperatureC: { op: 'gt', value: -12 } },
          then: { settlementTier: 'critical', settlementRatePct: 85, approveClaim: true, assignedRole: 'ldx_manager' },
        },
        {
          id: 'r2',
          when: { riskScore: { op: 'gte', value: 75 } },
          then: { settlementTier: 'critical', settlementRatePct: 85, approveClaim: true, assignedRole: 'ldx_manager' },
        },
        {
          id: 'r3',
          when: { temperatureC: { op: 'gt', value: -12 }, amount: { op: 'gte', value: 15000000 } },
          then: { settlementTier: 'escalated', settlementRatePct: 40, approveClaim: true, assignedRole: 'ldx_manager' },
        },
        {
          id: 'r4',
          when: { riskScore: { op: 'gte', value: 40 } },
          then: { settlementTier: 'escalated', settlementRatePct: 40, approveClaim: false, assignedRole: 'ldx_operator' },
        },
        {
          id: 'r5',
          when: {},
          then: { settlementTier: 'standard', settlementRatePct: 0, approveClaim: false, assignedRole: 'ldx_operator' },
        },
      ],
    };
    const rulesRepo = db.getRepository?.('latticeAutomationRules');
    const ruleKey = 'auto_coldchain_partner_settlement';
    if (!RULE_KEY_RE.test(ruleKey)) throw fail('INVALID_PACK_RULE', 500, 'Invalid pack rule key');
    const graphJson = buildPartnerSettlementGraphV2();
    const ruleValues = {
      organizationId,
      ruleKey,
      name: 'Đối soát Bồi thường Đối tác Chuỗi lạnh & n8n 2 chiều (LatticeFlow v2)',
      description:
        'Đánh giá bảng DMN coldchain_settlement_policy_v1, tạo hồ sơ bồi thường trong latticeCustomPartnerClaims và điều phối luồng n8n 26 nút hỗ trợ callback 2 chiều.',
      triggerEventType: 'coldchain.settlement_requested,lot.held_mkt',
      filterJson: null,
      dmnTableKey: 'coldchain_settlement_policy_v1',
      actionsJson: projectBlueprintToV1Actions({ graphJson }),
      graphJson: structuredClone(graphJson),
      draftGraphJson: structuredClone(graphJson),
      triggerIndexJson: buildTriggerIndex(graphJson, { triggerEventType: 'coldchain.settlement_requested,lot.held_mkt' }),
      schemaVersion: 2,
      maxDepth: 8,
      cooldownSec: 0,
      active: true,
      createdBy: actor?.username ? String(actor.username) : null,
    };
    const { dmnRow, ruleRow } = await runWithOptionalRls(db, organizationId, async (transaction) => {
      const savedDmn = dmnRepo
        ? await upsertRepoRow(dmnRepo, { organizationId, tableKey: 'coldchain_settlement_policy_v1' }, dmnValues, transaction)
        : dmnValues;
      const savedRule = rulesRepo
        ? await upsertRepoRow(rulesRepo, { organizationId, ruleKey }, ruleValues, transaction)
        : ruleValues;
      return { dmnRow: savedDmn, ruleRow: savedRule };
    }, foundation);

    const seedSamples = params.seedSamples === true || params.seedSamples === 'true';
    const seededSamples = seedSamples
      ? await seedBusinessPackSamples(db, { organizationId, packKey, foundation })
      : null;

    ctx.body = {
      installed: true,
      packKey,
      organizationId,
      domain,
      dmnTable: toPlain(dmnRow),
      automationRule: toPlain(ruleRow),
      ...(seededSamples ? { seededSamples } : {}),
    };
    return next();
  }

  const domain = await createOrUpdateDomainCollection(db, {
    collectionName: 'latticeCustomWorkOrders',
    title: 'Lệnh Công việc Bảo trì (CMMS)',
    description: 'Lệnh công việc bảo trì thiết bị và xử lý sự cố chuỗi lạnh tự động.',
    fields: [
      { name: 'workOrderCode', type: 'string', title: 'Mã lệnh công việc', required: true, indexed: true },
      { name: 'title', type: 'string', title: 'Tiêu đề', required: true },
      { name: 'assetId', type: 'integer', title: 'ID Tài sản' },
      { name: 'deviceKey', type: 'string', title: 'Mã thiết bị', indexed: true },
      {
        name: 'priority',
        type: 'string',
        title: 'Độ ưu tiên',
        required: true,
        enumValues: ['low', 'medium', 'high', 'critical'],
      },
      {
        name: 'status',
        type: 'string',
        title: 'Trạng thái',
        required: true,
        enumValues: ['open', 'in_progress', 'completed', 'cancelled'],
      },
      { name: 'faultSummary', type: 'text', title: 'Tóm tắt sự cố' },
      { name: 'assignedRole', type: 'string', title: 'Vai trò phụ trách' },
      { name: 'dueAt', type: 'datetime', title: 'Hạn hoàn thành' },
    ],
    roles: ['ldx_admin', 'ldx_manager', 'ldx_dispatcher', 'ldx_warehouse', 'ldx_operator', 'ldx_employee'],
    portalSlug: 'cmms',
    portalTitle: 'Bảo trì CMMS',
  }, {
    ctx,
    applyBlueprint: createBuilderApplyBlueprint(ctx),
  });

  const dmnRepo = db.getRepository?.('latticeDecisionTables');
  const dmnValues = {
    organizationId,
    tableKey: 'cmms_priority_routing_v1',
    name: 'Định tuyến Ưu tiên Sự cố CMMS Chuỗi lạnh',
    description: 'Ánh xạ mức độ cảnh báo chuỗi lạnh và loại sự kiện sang độ ưu tiên CMMS, vai trò phụ trách và SLA.',
    hitPolicy: 'FIRST',
    version: 1,
    active: true,
    inputsJson: [
      { name: 'severity', type: 'string' },
      { name: 'eventType', type: 'string' },
    ],
    outputsJson: [
      { name: 'workOrderPriority', type: 'string' },
      { name: 'assignedRole', type: 'string' },
      { name: 'slaHours', type: 'number' },
    ],
    rulesJson: [
      {
        id: 'r1',
        when: { severity: 'critical', eventType: 'alarm.triggered' },
        then: { workOrderPriority: 'critical', assignedRole: 'ldx_manager', slaHours: 2 },
      },
      {
        id: 'r2',
        when: { severity: 'high', eventType: 'alarm.triggered' },
        then: { workOrderPriority: 'high', assignedRole: 'ldx_operator', slaHours: 4 },
      },
      {
        id: 'r3',
        when: { eventType: 'lot.held_mkt' },
        then: { workOrderPriority: 'critical', assignedRole: 'ldx_manager', slaHours: 1 },
      },
      {
        id: 'r4',
        when: {},
        then: { workOrderPriority: 'medium', assignedRole: 'ldx_operator', slaHours: 24 },
      },
    ],
  };
  const rulesRepo = db.getRepository?.('latticeAutomationRules');
  const ruleKey = 'auto_cmms_on_coldchain_fault';
  if (!RULE_KEY_RE.test(ruleKey)) throw fail('INVALID_PACK_RULE', 500, 'Invalid pack rule key');
  const flowBlueprint = getFlowBlueprint(ruleKey);
  const compatActions = projectBlueprintToV1Actions(flowBlueprint);
  const ruleValues = {
    organizationId,
    ruleKey,
    name: 'Tự động tạo Lệnh CMMS khi Cảnh báo Chuỗi lạnh',
    description: 'Đánh giá bảng DMN cmms_priority_routing_v1, tạo lệnh công việc CMMS và thông báo vai trò phụ trách.',
    triggerEventType: flowBlueprint?.triggerEventType || 'alarm.triggered,device.offline',
    filterJson: null,
    dmnTableKey: flowBlueprint?.dmnTableKey || 'cmms_priority_routing_v1',
    actionsJson: compatActions,
    draftGraphJson: flowBlueprint?.graphJson ? structuredClone(flowBlueprint.graphJson) : null,
    triggerIndexJson: flowBlueprint?.graphJson ? buildTriggerIndex(flowBlueprint.graphJson, flowBlueprint) : [],
    schemaVersion: 1,
    maxDepth: flowBlueprint?.maxDepth ?? 8,
    cooldownSec: flowBlueprint?.cooldownSec ?? 60,
    active: true,
    createdBy: actor?.username ? String(actor.username) : null,
  };
  const { dmnRow, ruleRow } = await runWithOptionalRls(db, organizationId, async (transaction) => {
    const savedDmn = dmnRepo
      ? await upsertRepoRow(dmnRepo, { organizationId, tableKey: 'cmms_priority_routing_v1' }, dmnValues, transaction)
      : dmnValues;
    const savedRule = rulesRepo
      ? await upsertRepoRow(rulesRepo, { organizationId, ruleKey }, ruleValues, transaction)
      : ruleValues;
    return { dmnRow: savedDmn, ruleRow: savedRule };
  }, foundation);

  const seedSamples = params.seedSamples === true || params.seedSamples === 'true';
  const seededSamples = seedSamples
    ? await seedBusinessPackSamples(db, { organizationId, packKey, foundation })
    : null;

  ctx.body = {
    installed: true,
    packKey,
    organizationId,
    domain,
    dmnTable: toPlain(dmnRow),
    automationRule: toPlain(ruleRow),
    ...(seededSamples ? { seededSamples } : {}),
  };
  return next();
}

async function seedBusinessPackSamples(db, { organizationId, packKey = 'all', foundation } = {}) {
  const orgId = String(organizationId || '').trim();
  if (!orgId) return { workOrdersSeeded: 0, partnerClaimsSeeded: 0 };
  const result = { workOrdersSeeded: 0, partnerClaimsSeeded: 0 };
  const seedCmms = packKey === 'all' || packKey === 'cmms-maintenance';
  const seedClaims = packKey === 'all' || packKey === 'coldchain-partner-settlement';
  await runWithOptionalRls(db, orgId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    if (seedCmms) {
      const woRepo = db.getRepository?.('latticeCustomWorkOrders');
      if (woRepo && typeof woRepo.findOne === 'function' && typeof woRepo.create === 'function') {
        const samples = [
          {
            organizationId: orgId,
            workOrderCode: `WO-${orgId}-001`,
            title: 'Kiểm tra máy nén kho lạnh -20°C (Vùng Bắc)',
            deviceKey: 'cold-chamber-hn-01',
            priority: 'critical',
            status: 'open',
            faultSummary: 'Nhiệt độ cảm biến vượt ngưỡng -15°C trong 12 phút; cần kiểm tra van tiết lưu và nguồn dự phòng.',
            assignedRole: 'ldx_manager',
          },
          {
            organizationId: orgId,
            workOrderCode: `WO-${orgId}-002`,
            title: 'Hiệu chuẩn đầu dò IoT xe tải lạnh CT-02',
            deviceKey: 'cold-truck-ct-02',
            priority: 'medium',
            status: 'in_progress',
            faultSummary: 'Lịch bảo trì định kỳ hàng tháng theo tiêu chuẩn GDP/GSP.',
            assignedRole: 'ldx_operator',
          },
        ];
        for (const item of samples) {
          const exists = await woRepo.findOne({ filter: { organizationId: orgId, workOrderCode: item.workOrderCode }, ...txOpt });
          if (!exists) {
            await woRepo.create({ values: item, ...txOpt });
            result.workOrdersSeeded += 1;
          }
        }
      }
    }
    if (seedClaims) {
      const claimRepo = db.getRepository?.('latticeCustomPartnerClaims');
      if (claimRepo && typeof claimRepo.findOne === 'function' && typeof claimRepo.create === 'function') {
        const samples = [
          {
            organizationId: orgId,
            claimCode: `CLM-${orgId}-001`,
            partnerCode: 'vnpost-cold',
            partnerEmail: 'claims@vnpost-cold.example.com',
            lotCode: 'LOT-VX-2026-01',
            severity: 'critical',
            riskScore: 86,
            settlementTier: 'critical',
            settlementRatePct: 85,
            claimAmountVnd: 120000000,
            settlementAmountVnd: 102000000,
            status: 'open',
            settlementStatus: 'in_review',
            resolutionNote: 'Đang chờ đối tác xác nhận biên bản nhiệt độ chuỗi lạnh qua webhook n8n.',
          },
          {
            organizationId: orgId,
            claimCode: `CLM-${orgId}-002`,
            partnerCode: 'ghn-coldchain',
            partnerEmail: 'ops@ghn-cold.example.com',
            lotCode: 'LOT-BIO-2026-02',
            severity: 'high',
            riskScore: 52,
            settlementTier: 'escalated',
            settlementRatePct: 40,
            claimAmountVnd: 45000000,
            settlementAmountVnd: 18000000,
            status: 'approved',
            settlementStatus: 'approved',
            resolutionNote: 'Đã chốt tỷ lệ đối soát 40% theo chính sách DMN coldchain_settlement_policy_v1.',
          },
        ];
        for (const item of samples) {
          const exists = await claimRepo.findOne({ filter: { organizationId: orgId, claimCode: item.claimCode }, ...txOpt });
          if (!exists) {
            await claimRepo.create({ values: item, ...txOpt });
            result.partnerClaimsSeeded += 1;
          }
        }
      }
    }
  }, foundation);
  return result;
}

module.exports = {
  BUSINESS_PACK_CATALOG,
  buildPartnerSettlementGraphV2,
  installBusinessPackAction,
  listBusinessPacksAction,
  projectBlueprintToV1Actions,
  replaceStepNodeRefs,
  seedBusinessPackSamples,
};
