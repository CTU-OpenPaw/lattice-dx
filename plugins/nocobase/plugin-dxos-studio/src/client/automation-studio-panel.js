/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const FILTER_OPERATORS = [
  { value: '$eq', label: '= bằng' },
  { value: '$ne', label: '≠ khác' },
  { value: '$gt', label: '> lớn hơn' },
  { value: '$gte', label: '>= lớn hoặc bằng' },
  { value: '$lt', label: '< nhỏ hơn' },
  { value: '$lte', label: '<= nhỏ hoặc bằng' },
  { value: '$in', label: 'in thuộc tập' },
  { value: '$nin', label: 'nin ngoài tập' },
  { value: '$contains', label: 'contains chứa' },
  { value: '$exists', label: 'exists tồn tại' },
];

const ACTION_META = {
  create_record: { icon: '＋', label: 'Tạo bản ghi', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
  update_record: { icon: '✎', label: 'Cập nhật bản ghi', color: '#0284c7', bg: '#f0f9ff', border: '#bae6fd' },
  notify_role: { icon: '🔔', label: 'Thông báo vai trò', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
  call_connector: { icon: '🔌', label: 'Gọi Connector', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
  twin_set_desired: { icon: '❄', label: 'Đặt lệnh Digital Twin', color: '#0d9488', bg: '#f0fdfa', border: '#99f6e4' },
  trigger_ai_triage: { icon: '🤖', label: 'AI Triage', color: '#db2777', bg: '#fdf2f8', border: '#fbcfe8' },
};

const VARIABLE_CHIPS = [
  '{{data.deviceKey}}',
  '{{data.assetId}}',
  '{{data.lotCode}}',
  '{{data.temperature}}',
  '{{data.severity}}',
  '{{dmn.workOrderPriority}}',
  '{{dmn.assignedRole}}',
  '{{dmn.approvalTier}}',
  '{{steps.0.id}}',
  '{{id}}',
];

const SUGGESTED_FILTER_FIELDS = [
  'temperature',
  'maxTempC',
  'mktCelsius',
  'severity',
  'deviceKey',
  'lotCode',
  'assetId',
  'priority',
  'dmn.workOrderPriority',
  'dmn.approvalTier',
  'event.type',
];

const AI_QUICK_PROMPTS = [
  'Cảnh báo kho lạnh > 8°C: định tuyến DMN, tạo phiếu CMMS, hạ nhiệt Twin nếu critical',
  'Cách ly lô vượt MKT: mở hồ sơ sự cố, AI triage và đẩy n8n nếu quality_hold_director',
  'Leo thang SLA warning/breached và thêm cooldown 120s chống bão cảnh báo',
];

const DEFAULT_AUTOMATION_BLUEPRINTS = [
  {
    ruleKey: 'auto_cmms_on_coldchain_fault',
    name: 'Ứng cứu khẩn Chuỗi lạnh IT/OT (5 bước rẽ nhánh)',
    badge: '5 bước · Rẽ nhánh critical',
    description: 'Nhận alarm.triggered / device.offline, định tuyến DMN cmms_priority_routing_v1, tạo phiếu CMMS, báo vai trò và rẽ nhánh HITL Twin + AI Triage + n8n.',
    triggerEventType: 'alarm.triggered,device.offline',
    filterJson: { severity: { $in: ['high', 'critical'] } },
    dmnTableKey: 'cmms_priority_routing_v1',
    cooldownSec: 60,
    maxDepth: 8,
    active: true,
    sampleEvent: {
      type: 'alarm.triggered',
      data: {
        deviceKey: 'COLD-CHILLER-CT-01',
        assetId: 1,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1',
        severity: 'critical',
        temperature: 11.4,
        message: 'Nhiệt độ buồng lạnh vượt ngưỡng 8°C',
      },
    },
    actionsJson: [
      {
        type: 'create_record',
        label: 'Tạo phiếu bảo trì CMMS',
        collection: 'latticeCustomWorkOrders',
        values: {
          workOrderCode: 'WO-{{id}}',
          title: 'Sự cố chuỗi lạnh: {{data.deviceKey}}',
          assetId: '{{data.assetId}}',
          deviceKey: '{{data.deviceKey}}',
          priority: '{{dmn.workOrderPriority}}',
          status: 'open',
          faultSummary: '{{data.message}}',
          assignedRole: '{{dmn.assignedRole}}',
        },
      },
      {
        type: 'notify_role',
        label: 'Thông báo vai trò phụ trách',
        role: '{{dmn.assignedRole}}',
        severity: 'warning',
        category: 'cmms',
        title: 'CMMS ({{dmn.workOrderPriority}}): {{data.deviceKey}}',
        body: 'Đã mở phiếu bảo trì cho {{data.deviceKey}} (WO #{{steps.0.id}})',
        targetCollection: 'latticeCustomWorkOrders',
        targetPath: '/p/cmms',
      },
      {
        type: 'twin_set_desired',
        label: 'Hạ nhiệt khẩn Digital Twin (HITL)',
        when: { field: 'dmn.workOrderPriority', op: '$eq', value: 'critical' },
        branchLabel: 'Khi ưu tiên = critical',
        assetId: '{{data.assetId}}',
        assetEntityId: '{{data.assetEntityId}}',
        desiredPatch: { targetTempC: 2.0, fanMode: 'high', doorLock: 'locked' },
      },
      {
        type: 'trigger_ai_triage',
        label: 'AI Triage gắn phiếu #{{steps.0.id}}',
        when: { field: 'dmn.workOrderPriority', op: '$eq', value: 'critical' },
        branchLabel: 'Khi ưu tiên = critical',
        targetCollection: 'latticeCustomWorkOrders',
        targetRecordId: '{{steps.0.id}}',
        severity: 'critical',
        recommendation: 'Kiểm tra máy nén và niêm phong buồng lạnh {{data.deviceKey}} (WO #{{steps.0.id}})',
      },
      {
        type: 'call_connector',
        label: 'Đẩy cảnh báo sang n8n (HMAC)',
        when: { field: 'dmn.workOrderPriority', op: '$eq', value: 'critical' },
        branchLabel: 'Khi ưu tiên = critical',
        connectorKey: 'n8n-coldchain-orchestrator',
        method: 'POST',
        path: '',
        body: {
          workOrderId: '{{steps.0.id}}',
          deviceKey: '{{data.deviceKey}}',
          priority: '{{dmn.workOrderPriority}}',
          temperature: '{{data.temperature}}',
        },
      },
    ],
  },
  {
    ruleKey: 'auto_mkt_quarantine_response',
    name: 'Cách ly Lô Vắc-xin vượt MKT & Đối tác (4 bước)',
    badge: '4 bước · Rẽ nhánh QA Hold',
    description: 'Khi lot.held_mkt kích hoạt DMN cold_chain_approval_v1, mở sự cố, chạy AI Triage, rẽ nhánh gọi n8n nếu quality_hold_director và báo Quản lý.',
    triggerEventType: 'lot.held_mkt',
    filterJson: { maxTempC: { $gt: 8 } },
    dmnTableKey: 'cold_chain_approval_v1',
    cooldownSec: 30,
    maxDepth: 8,
    active: true,
    sampleEvent: {
      type: 'lot.held_mkt',
      data: {
        lotCode: 'LOT-V100-MKT-HOLD',
        sku: 'SKU-VAX-MKT-28',
        mktCelsius: 10.2,
        maxTempC: 11.1,
        thresholdCelsius: 8.0,
        assetEntityId: 'lot:LOT-V100-MKT-HOLD',
        totalAmountM: 650,
        severity: 'critical',
      },
    },
    actionsJson: [
      {
        type: 'create_record',
        label: 'Mở hồ sơ sự cố chất lượng',
        collection: 'latticeIncidentCases',
        values: {
          code: 'MKT-{{id}}',
          name: 'Cách ly lô vượt MKT: {{data.lotCode}}',
          runId: 'mkt-{{id}}',
          assetEntityId: 'lot:{{data.lotCode}}',
          handlerId: 'ldx_manager',
          severity: 'critical',
          status: 'open',
          proposal: 'Lô {{data.lotCode}} có MKT={{data.mktCelsius}}°C vượt ngưỡng 8°C (duyệt: {{dmn.approvalTier}}).',
        },
      },
      {
        type: 'trigger_ai_triage',
        label: 'AI Triage đánh giá lô vắc-xin',
        targetCollection: 'latticeIncidentCases',
        targetRecordId: '{{steps.0.id}}',
        severity: 'high',
        recommendation: 'Cách ly kiểm định lô {{data.lotCode}} ({{data.sku}}) do vượt ngưỡng MKT {{data.mktCelsius}}°C',
      },
      {
        type: 'call_connector',
        label: 'Đồng bộ QA Hold sang n8n',
        when: { field: 'dmn.approvalTier', op: '$eq', value: 'quality_hold_director' },
        branchLabel: 'Khi tier = quality_hold_director',
        connectorKey: 'n8n-coldchain-orchestrator',
        method: 'POST',
        path: '',
        body: {
          incidentId: '{{steps.0.id}}',
          lotCode: '{{data.lotCode}}',
          approvalTier: '{{dmn.approvalTier}}',
        },
      },
      {
        type: 'notify_role',
        label: 'Thông báo Quản lý chất lượng',
        role: 'ldx_manager',
        severity: 'critical',
        category: 'quality',
        title: 'Cách ly MKT {{data.lotCode}} ({{dmn.approvalTier}})',
        body: 'Hồ sơ #{{steps.0.id}} yêu cầu xử lý trong {{dmn.slaMinutes}} phút',
        targetCollection: 'latticeIncidentCases',
        targetPath: '/p/wms',
      },
    ],
  },
  {
    ruleKey: 'auto_sla_breach_escalation',
    name: 'Leo thang SLA Đơn hàng & Phiếu dịch vụ (3 bước)',
    badge: '3 bước · 2 nhánh SLA',
    description: 'Phân nhánh theo sla.warning (nhắc điều phối viên) và sla.breached (tạo phiếu dịch vụ khẩn + leo thang ldx_manager).',
    triggerEventType: 'sla.warning,sla.breached',
    filterJson: null,
    dmnTableKey: '',
    cooldownSec: 120,
    maxDepth: 8,
    active: true,
    sampleEvent: {
      type: 'sla.breached',
      data: {
        targetCollection: 'latticeServiceTickets',
        recordId: 101,
        code: 'TKT-SLA-01',
        priority: 'high',
        overdueMinutes: 250,
        remainingMinutes: 0,
      },
    },
    actionsJson: [
      {
        type: 'notify_role',
        label: 'Nhắc điều phối viên sắp chạm SLA',
        when: { field: 'event.type', op: '$eq', value: 'sla.warning' },
        branchLabel: 'Khi sự kiện = sla.warning',
        role: 'ldx_dispatcher',
        severity: 'warning',
        category: 'sla',
        title: 'Sắp chạm ngưỡng SLA: {{data.code}}',
        body: 'Còn {{data.remainingMinutes}} phút trước hạn SLA trên {{data.targetCollection}} #{{data.recordId}}',
        targetPath: '/p/services',
      },
      {
        type: 'create_record',
        label: 'Tạo phiếu xử lý vi phạm SLA',
        when: { field: 'event.type', op: '$eq', value: 'sla.breached' },
        branchLabel: 'Khi sự kiện = sla.breached',
        collection: 'latticeServiceTickets',
        values: {
          code: 'SLA-{{id}}',
          name: 'Vi phạm SLA: {{data.code}}',
          serviceType: 'facilities',
          priority: 'high',
          description: 'Quá hạn {{data.overdueMinutes}} phút trên {{data.targetCollection}} #{{data.recordId}}.',
        },
      },
      {
        type: 'notify_role',
        label: 'Leo thang khẩn tới Quản lý',
        when: { field: 'event.type', op: '$eq', value: 'sla.breached' },
        branchLabel: 'Khi sự kiện = sla.breached',
        role: 'ldx_manager',
        severity: 'critical',
        category: 'sla',
        title: 'VI PHẠM SLA: {{data.code}}',
        body: 'Đã mở phiếu leo thang #{{steps.1.id}} cho {{data.targetCollection}}',
        targetCollection: 'latticeServiceTickets',
        targetPath: '/p/services',
      },
    ],
  },
];

const DEFAULT_AUTOMATION_CATALOG = {
  eventTypes: [
    {
      eventType: 'telemetry.alarm',
      label: 'Cảnh báo Telemetry Cảm biến',
      category: 'iot',
      sampleEvent: { type: 'telemetry.alarm', data: { temperature: 12.5, assetId: 1, deviceKey: 'cold-chiller-01', severity: 'critical' } },
    },
    {
      eventType: 'alarm.triggered',
      label: 'Kích hoạt Cảnh báo Thiết bị',
      category: 'iot',
      sampleEvent: { type: 'alarm.triggered', data: { deviceKey: 'COLD-CHILLER-CT-01', assetId: 1, assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1', severity: 'critical', temperature: 11.4, message: 'Vượt ngưỡng nhiệt độ 8°C' } },
    },
    {
      eventType: 'device.offline',
      label: 'Thiết bị IoT Mất kết nối (LWT)',
      category: 'iot',
      sampleEvent: { type: 'device.offline', data: { deviceKey: 'cold-truck-ct-01', assetId: 2, severity: 'high', reason: 'LWT timeout', message: 'Mất tín hiệu MQTT' } },
    },
    {
      eventType: 'lot.held_mkt',
      label: 'Tạm giữ Lô vượt MKT',
      category: 'wms',
      sampleEvent: { type: 'lot.held_mkt', data: { lotCode: 'LOT-V100-MKT-HOLD', sku: 'SKU-VAX-MKT-28', mktCelsius: 10.2, maxTempC: 11.1, totalAmountM: 650, severity: 'critical' } },
    },
    {
      eventType: 'voucher.submitted',
      label: 'Chứng từ trình duyệt',
      category: 'governance',
      sampleEvent: { type: 'voucher.submitted', data: { collection: 'latticeOrders', recordId: 10, code: 'ORD-V100-001', totalAmountM: 650, maxTempC: 6.5 } },
    },
    {
      eventType: 'voucher.cancelled',
      label: 'Chứng từ bị hủy',
      category: 'governance',
      sampleEvent: { type: 'voucher.cancelled', data: { collection: 'latticeRequests', recordId: 12, code: 'REQ-100', cancelReason: 'Thay đổi kế hoạch' } },
    },
    {
      eventType: 'sla.warning',
      label: 'Cảnh báo Sắp chạm SLA',
      category: 'sla',
      sampleEvent: { type: 'sla.warning', data: { targetCollection: 'latticeServiceTickets', recordId: 15, code: 'TKT-001', remainingMinutes: 15 } },
    },
    {
      eventType: 'sla.breached',
      label: 'Vi phạm Ngưỡng SLA',
      category: 'sla',
      sampleEvent: { type: 'sla.breached', data: { targetCollection: 'latticeServiceTickets', recordId: 15, code: 'TKT-001', priority: 'high', overdueMinutes: 30 } },
    },
    {
      eventType: 'epod.signed',
      label: 'Chứng từ Giao hàng ePOD đã ký',
      category: 'wms',
      sampleEvent: { type: 'epod.signed', data: { epodUid: 'EPOD-001', orderId: 10, orderCode: 'ORD-V100-001', deliveredQty: 30 } },
    },
    {
      eventType: 'orion.notification',
      label: 'Thông báo NGSI-LD Orion-LD',
      category: 'iot',
      sampleEvent: { type: 'orion.notification', data: { entityId: 'urn:ngsi-ld:Asset:org-a:native:1', entityType: 'Asset', temperature: 9.8 } },
    },
    {
      eventType: 'manual.trigger',
      label: 'Kích hoạt Thủ công',
      category: 'system',
      sampleEvent: { type: 'manual.trigger', data: { note: 'Manual check', severity: 'medium', assetId: 1 } },
    },
  ],
  dmnTables: [
    {
      tableKey: 'cmms_priority_routing_v1',
      name: 'CMMS Cold-Chain Fault Priority Routing',
      outputs: ['workOrderPriority', 'assignedRole', 'slaHours'],
    },
    {
      tableKey: 'cold_chain_approval_v1',
      name: 'Ma trận Phê duyệt Chuỗi lạnh & Vượt ngưỡng MKT',
      outputs: ['approvalTier', 'slaMinutes'],
    },
  ],
  collections: [
    {
      name: 'latticeCustomWorkOrders',
      title: 'Lệnh Bảo trì CMMS',
      fields: ['workOrderCode', 'title', 'assetId', 'deviceKey', 'priority', 'status', 'faultSummary', 'assignedRole', 'dueAt'],
    },
    {
      name: 'latticeServiceTickets',
      title: 'Phiếu Dịch vụ Nội bộ',
      fields: ['code', 'name', 'serviceType', 'priority', 'description', 'resolutionNote'],
    },
    {
      name: 'latticeIncidentCases',
      title: 'Hồ sơ Sự cố',
      fields: ['code', 'name', 'runId', 'assetEntityId', 'handlerId', 'severity', 'status', 'proposal', 'resolutionNote'],
    },
    {
      name: 'latticeRequests',
      title: 'Yêu cầu Mua sắm / Nội bộ',
      fields: ['code', 'title', 'description', 'priority', 'category'],
    },
    {
      name: 'latticeOrders',
      title: 'Đơn hàng / Vận đơn',
      fields: ['code', 'name', 'customer', 'origin', 'destination', 'category'],
    },
    {
      name: 'latticeAssets',
      title: 'Tài sản & Thiết bị IoT',
      fields: ['code', 'name', 'kind', 'status', 'locationId'],
    },
    {
      name: 'latticeParaDocuments',
      title: 'Tài liệu P.A.R.A.',
      fields: ['code', 'title', 'paraCategory', 'summary'],
    },
    {
      name: 'latticeAgentProposals',
      title: 'Đề xuất AI Triage',
      fields: ['receiptKey', 'targetCollection', 'targetRecordId', 'recommendation', 'state'],
    },
  ],
  roles: ['ldx_admin', 'ldx_manager', 'ldx_operator', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_employee', 'ldx_viewer'],
  blueprints: DEFAULT_AUTOMATION_BLUEPRINTS,
};

function cloneSafe(val) {
  try {
    return JSON.parse(JSON.stringify(val));
  } catch {
    return val;
  }
}

function coerceConditionValue(raw, op) {
  const str = String(raw ?? '').trim();
  if (op === '$exists') {
    return str !== 'false' && str !== '0';
  }
  if (op === '$in' || op === '$nin') {
    if (str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Fallback to CSV split below
      }
    }
    return str
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => coerceScalarValue(item));
  }
  return coerceScalarValue(str);
}

function coerceScalarValue(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  return raw;
}

function formatConditionValueForInput(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseFilterJsonToState(filterJson) {
  if (filterJson === null || filterJson === undefined) {
    return { rows: [], complexJson: null };
  }
  if (Array.isArray(filterJson)) {
    const rows = [];
    for (const item of filterJson) {
      const sub = parseFilterJsonToState(item);
      if (sub.complexJson) return { rows: [], complexJson: filterJson };
      rows.push(...sub.rows);
    }
    return { rows, complexJson: null };
  }
  if (typeof filterJson !== 'object') {
    return { rows: [], complexJson: filterJson };
  }
  const keys = Object.keys(filterJson);
  if (!keys.length) return { rows: [], complexJson: null };

  if (typeof filterJson.field === 'string') {
    if (filterJson.op) {
      return {
        rows: [{
          field: filterJson.field,
          op: String(filterJson.op),
          value: formatConditionValueForInput(filterJson.value),
        }],
        complexJson: null,
      };
    }
    const opKeys = keys.filter((k) => k !== 'field' && k !== 'value');
    if (opKeys.length) {
      return {
        rows: opKeys.map((op) => ({
          field: filterJson.field,
          op,
          value: formatConditionValueForInput(filterJson[op]),
        })),
        complexJson: null,
      };
    }
    if ('value' in filterJson) {
      return {
        rows: [{ field: filterJson.field, op: '$eq', value: formatConditionValueForInput(filterJson.value) }],
        complexJson: null,
      };
    }
  }

  if (keys.some((k) => ['$or', '$not', 'or', 'any'].includes(k))) {
    return { rows: [], complexJson: filterJson };
  }

  if (keys.length === 1 && ['$and', 'and', 'all', 'rules'].includes(keys[0]) && Array.isArray(filterJson[keys[0]])) {
    return parseFilterJsonToState(filterJson[keys[0]]);
  }

  const rows = [];
  for (const [field, expected] of Object.entries(filterJson)) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const opEntries = Object.entries(expected).filter(([k]) => k.startsWith('$'));
      if (!opEntries.length) return { rows: [], complexJson: filterJson };
      for (const [op, val] of opEntries) {
        rows.push({ field, op, value: formatConditionValueForInput(val) });
      }
    } else if (Array.isArray(expected)) {
      rows.push({ field, op: '$in', value: formatConditionValueForInput(expected) });
    } else {
      rows.push({ field, op: '$eq', value: formatConditionValueForInput(expected) });
    }
  }
  return { rows, complexJson: null };
}

function serializeFilterRows(rows, complexJson) {
  if (complexJson && (!rows || !rows.length)) {
    return complexJson;
  }
  const cleanRows = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      field: String(r?.field || '').trim(),
      op: String(r?.op || '$eq').trim() || '$eq',
      value: r?.value ?? '',
    }))
    .filter((r) => r.field && !BLOCKED_PROTO_KEYS.has(r.field));

  if (!cleanRows.length) return null;

  const grouped = new Map();
  let hasMultiClauseConflict = false;
  for (const row of cleanRows) {
    const existing = grouped.get(row.field) || [];
    if (existing.some((e) => e.op === '$eq' || row.op === '$eq')) {
      if (existing.length > 0) hasMultiClauseConflict = true;
    }
    existing.push(row);
    grouped.set(row.field, existing);
  }

  if (hasMultiClauseConflict) {
    return {
      $and: cleanRows.map((r) => ({
        field: r.field,
        op: r.op,
        value: coerceConditionValue(r.value, r.op),
      })),
    };
  }

  const out = {};
  for (const [field, entries] of grouped.entries()) {
    if (entries.length === 1 && entries[0].op === '$eq') {
      out[field] = coerceConditionValue(entries[0].value, '$eq');
    } else {
      const opObj = {};
      for (const entry of entries) {
        opObj[entry.op] = coerceConditionValue(entry.value, entry.op);
      }
      out[field] = opObj;
    }
  }
  return out;
}

function parseWhenCondition(when) {
  if (!when || typeof when !== 'object') {
    return {
      enabled: false,
      isComplex: false,
      field: 'dmn.workOrderPriority',
      op: '$eq',
      value: 'critical',
      rows: [],
      rawWhen: null,
    };
  }
  const keys = Array.isArray(when) ? [] : Object.keys(when);
  const hasLogicalKey = Array.isArray(when)
    || keys.some((k) => ['$or', '$not', '$and', 'or', 'any', 'and', 'all', 'rules'].includes(k));
  const parsed = parseFilterJsonToState(when);
  const isComplex = Boolean(hasLogicalKey || parsed.complexJson || parsed.rows.length !== 1);
  if (isComplex) {
    return {
      enabled: true,
      isComplex: true,
      field: parsed.rows[0]?.field || '',
      op: parsed.rows[0]?.op || '$eq',
      value: parsed.rows[0]?.value ?? '',
      rows: parsed.rows,
      rawWhen: when,
    };
  }
  const first = parsed.rows[0];
  return {
    enabled: true,
    isComplex: false,
    field: first.field,
    op: first.op,
    value: first.value,
    rows: parsed.rows,
    rawWhen: null,
  };
}

function summarizeConditionRow(row) {
  if (!row || !row.field) return '';
  return `${row.field} ${row.op || '$eq'} ${row.value ?? ''}`.trim();
}

function describeWhenLabel(action) {
  if (!action?.when) return 'Luồng chính (Mọi mức)';
  if (action.branchLabel) return String(action.branchLabel);
  const parsed = parseWhenCondition(action.when);
  if (parsed.isComplex) {
    const hasOrNot = Array.isArray(action.when)
      || Object.keys(action.when).some((k) => ['$or', '$not', 'or', 'any'].includes(k));
    if (!hasOrNot && parsed.rows.length > 1) {
      return `Khi ${parsed.rows.map(summarizeConditionRow).join(' & ')}`;
    }
    const jsonStr = JSON.stringify(action.when);
    return `Khi ${jsonStr.length > 72 ? `${jsonStr.slice(0, 69)}...` : jsonStr}`;
  }
  return `Khi ${parsed.field} ${parsed.op} ${parsed.value}`;
}

function buildKeyValuePairs(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj)
    .filter(([k]) => !BLOCKED_PROTO_KEYS.has(String(k).trim()))
    .map(([k, v]) => ({
      key: k,
      value: typeof v === 'string' ? v : JSON.stringify(v),
    }));
}

function pairsToObject(pairs, { allowBlank = false } = {}) {
  const out = {};
  for (const pair of pairs) {
    const rawKey = String(pair?.key ?? '');
    const k = allowBlank ? rawKey : rawKey.trim();
    const trimmedKey = k.trim();
    if (!allowBlank && !trimmedKey) continue;
    if (BLOCKED_PROTO_KEYS.has(trimmedKey)) continue;
    const raw = pair?.value ?? '';
    if (typeof raw === 'string') {
      const t = raw.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try {
          out[k] = JSON.parse(t);
          continue;
        } catch {
          // Keep as string template
        }
      }
      out[k] = coerceScalarValue(raw);
    } else {
      out[k] = raw;
    }
  }
  return out;
}

function cleanBlankObjectKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const trimmed = String(k).trim();
    if (trimmed && !BLOCKED_PROTO_KEYS.has(trimmed)) out[k] = v;
  }
  return out;
}

function normalizeCatalog(rawCatalog, vaultConnectors = [], fallbackRoles = []) {
  const src = rawCatalog && typeof rawCatalog === 'object' ? rawCatalog : {};
  const rawEvents = Array.isArray(src.eventTypes) && src.eventTypes.length
    ? src.eventTypes
    : (Array.isArray(src.events) && src.events.length ? src.events : DEFAULT_AUTOMATION_CATALOG.eventTypes);

  const eventTypes = rawEvents.map((ev) => {
    if (typeof ev === 'string') {
      const def = DEFAULT_AUTOMATION_CATALOG.eventTypes.find((d) => d.eventType === ev);
      return def || { eventType: ev, label: ev, category: 'custom', sampleEvent: { type: ev, data: {} } };
    }
    const eventType = String(ev.eventType || ev.type || ev.key || '').trim();
    const def = DEFAULT_AUTOMATION_CATALOG.eventTypes.find((d) => d.eventType === eventType);
    return {
      eventType,
      label: ev.label || ev.name || def?.label || eventType,
      category: ev.category || def?.category || 'event',
      sampleEvent: ev.sampleEvent || ev.examplePayload || def?.sampleEvent || { type: eventType, data: {} },
    };
  }).filter((e) => e.eventType);

  const rawDmns = Array.isArray(src.dmnTables) && src.dmnTables.length
    ? src.dmnTables
    : DEFAULT_AUTOMATION_CATALOG.dmnTables;
  const dmnMap = new Map();
  for (const d of [...DEFAULT_AUTOMATION_CATALOG.dmnTables, ...rawDmns]) {
    const key = String(d?.tableKey || d?.key || d || '').trim();
    if (!key) continue;
    const outputsRaw = Array.isArray(d.outputsJson) ? d.outputsJson : (Array.isArray(d.outputs) ? d.outputs : []);
    const outputs = outputsRaw.map((o) => (typeof o === 'string' ? o : o?.name)).filter(Boolean);
    const prev = dmnMap.get(key) || {};
    dmnMap.set(key, {
      tableKey: key,
      name: d.name || prev.name || key,
      outputs: outputs.length ? outputs : (prev.outputs || []),
    });
  }

  const colMap = new Map();
  const rawCols = Array.isArray(src.collections) && src.collections.length
    ? src.collections
    : DEFAULT_AUTOMATION_CATALOG.collections;
  for (const c of [...DEFAULT_AUTOMATION_CATALOG.collections, ...rawCols]) {
    const name = String(c?.name || c?.collectionName || c || '').trim();
    if (!name) continue;
    const rawFields = Array.isArray(c?.fields) ? c.fields : [];
    const fields = rawFields.map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean);
    const prev = colMap.get(name) || {};
    colMap.set(name, {
      name,
      title: c?.title || prev.title || name,
      fields: fields.length ? fields : (prev.fields || []),
    });
  }

  const roleSet = new Set([
    ...(Array.isArray(fallbackRoles) ? fallbackRoles : []),
    ...DEFAULT_AUTOMATION_CATALOG.roles,
    ...(Array.isArray(src.roles) ? src.roles.map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean) : []),
  ]);

  const connMap = new Map();
  for (const c of [...(Array.isArray(src.connectors) ? src.connectors : []), ...(Array.isArray(vaultConnectors) ? vaultConnectors : [])]) {
    const key = String(c?.connectorKey || '').trim();
    if (!key) continue;
    connMap.set(key, {
      connectorKey: key,
      name: c.name || key,
      connectorType: c.connectorType || 'http_api',
      authType: c.authType || 'none',
    });
  }

  const rawBlueprints = Array.isArray(src.blueprints) && src.blueprints.length
    ? src.blueprints
    : DEFAULT_AUTOMATION_BLUEPRINTS;
  const blueprints = rawBlueprints.map((bp) => {
    const fallbackBp = DEFAULT_AUTOMATION_BLUEPRINTS.find((d) => d.ruleKey === bp.ruleKey);
    return {
      ...fallbackBp,
      ...bp,
      actionsJson: Array.isArray(bp.actionsJson) ? bp.actionsJson : (fallbackBp?.actionsJson || []),
      sampleEvent: bp.sampleEvent || fallbackBp?.sampleEvent || { type: String(bp.triggerEventType || 'telemetry.alarm').split(',')[0], data: {} },
    };
  });

  return {
    eventTypes,
    dmnTables: Array.from(dmnMap.values()),
    collections: Array.from(colMap.values()),
    roles: Array.from(roleSet),
    connectors: Array.from(connMap.values()),
    blueprints,
  };
}

function summarizeActionTarget(act) {
  if (!act || typeof act !== 'object') return '-';
  switch (act.type) {
    case 'create_record':
      return `${act.collection || '(chưa chọn bảng)'} · ${Object.keys(act.values || {}).length} trường`;
    case 'update_record':
      return `${act.collection || '(chưa chọn bảng)'} · cập nhật`;
    case 'notify_role':
      return `${act.role || act.roleName || 'ldx_operator'} · ${act.severity || 'warning'}`;
    case 'call_connector':
      return `${act.connectorKey || '(chưa chọn connector)'} ${act.method || 'POST'}${act.path ? ` ${act.path}` : ''}`;
    case 'twin_set_desired': {
      const temp = act.desiredPatch?.targetTempC ?? act.desired?.targetTempC;
      return `${act.assetEntityId || act.assetId || 'Twin'}${temp !== undefined ? ` → ${temp}°C` : ''} (HITL)`;
    }
    case 'trigger_ai_triage':
      return `${act.targetCollection || 'latticeAssets'} #${act.targetRecordId ?? '-'}`;
    default:
      return act.type || '-';
  }
}

function traceStatusStyle(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed' || s === 'ok' || s === 'succeeded') {
    return { label: '✓ completed', color: '#166534', bg: '#f0fdf4', border: '#22c55e', dashed: false };
  }
  if (s === 'simulated') {
    return { label: '▶ simulated', color: '#0e7490', bg: '#ecfeff', border: '#06b6d4', dashed: false };
  }
  if (s === 'skipped') {
    return { label: '⊘ skipped', color: '#92400e', bg: '#fffbeb', border: '#f59e0b', dashed: true };
  }
  if (s === 'failed' || s === 'error') {
    return { label: '✕ failed', color: '#991b1b', bg: '#fef2f2', border: '#ef4444', dashed: false };
  }
  return null;
}

function describeSelectedNode(selectedNode) {
  if (selectedNode === 'trigger') return 'Node 1: Event Trigger';
  if (selectedNode === 'filter') return 'Node 2: Filter & Guard';
  if (selectedNode === 'dmn') return 'Node 3: Ma trận DMN';
  if (String(selectedNode || '').startsWith('step:')) {
    const idx = Number(String(selectedNode).slice(5));
    return `Bước #${Number.isFinite(idx) ? idx + 1 : 1}`;
  }
  return 'Toàn bộ Rule';
}

function makeStudioStyles(baseStyles) {
  return {
    ...baseStyles,
    toolbar: {
      padding: '12px 14px',
      borderRadius: 12,
      border: '1px solid #cbd5e1',
      background: 'linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    },
    kpiPill: (tone = 'neutral') => ({
      ...baseStyles.badge(tone),
      padding: '4px 10px',
      fontSize: 11,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
    }),
    blueprintGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
      gap: 10,
      padding: 12,
      borderRadius: 10,
      border: '1px solid #bfdbfe',
      background: '#f8fafc',
    },
    blueprintCard: {
      padding: 12,
      borderRadius: 10,
      border: '1px solid #cbd5e1',
      background: '#ffffff',
      display: 'grid',
      gap: 8,
      alignContent: 'space-between',
    },
    workspace: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 12,
      alignItems: 'flex-start',
    },
    leftPane: {
      flex: '1 1 255px',
      minWidth: 250,
      padding: 12,
      borderRadius: 10,
      border: '1px solid #e2e8f0',
      background: '#f8fafc',
      display: 'grid',
      gap: 10,
    },
    centerPane: {
      flex: '1.45 1 340px',
      minWidth: 310,
      padding: 14,
      borderRadius: 12,
      border: '1px solid #cbd5e1',
      background: 'radial-gradient(#e2e8f0 1px, transparent 1px) 0 0 / 16px 16px #f8fafc',
      display: 'grid',
      gap: 10,
    },
    rightPane: {
      flex: '1.25 1 315px',
      minWidth: 300,
      padding: 12,
      borderRadius: 10,
      border: '1px solid #cbd5e1',
      background: '#ffffff',
      display: 'grid',
      gap: 10,
    },
    canvasNode: (isSelected, traceMeta) => {
      const borderColor = isSelected
        ? '#1677ff'
        : (traceMeta?.border || '#cbd5e1');
      const bg = traceMeta?.bg || '#ffffff';
      return {
        padding: '10px 12px',
        borderRadius: 10,
        border: `2px ${traceMeta?.dashed && !isSelected ? 'dashed' : 'solid'} ${borderColor}`,
        background: bg,
        boxShadow: isSelected ? '0 0 0 3px rgba(22,119,255,0.14)' : '0 1px 2px rgba(15,23,42,0.05)',
        cursor: 'pointer',
        display: 'grid',
        gap: 6,
        textAlign: 'left',
        width: '100%',
        boxSizing: 'border-box',
      };
    },
    branchLane: (isConditional) => ({
      padding: 10,
      borderRadius: 10,
      border: isConditional ? '1px dashed #8b5cf6' : '1px solid #cbd5e1',
      background: isConditional ? 'rgba(245, 243, 255, 0.72)' : 'rgba(255, 255, 255, 0.85)',
      display: 'grid',
      gap: 8,
    }),
    chip: (active = false) => ({
      padding: '3px 8px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      border: `1px solid ${active ? '#1677ff' : '#cbd5e1'}`,
      background: active ? '#dbeafe' : '#ffffff',
      color: active ? '#1e40af' : '#334155',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }),
    miniBtn: (danger = false) => ({
      padding: '3px 7px',
      borderRadius: 6,
      fontSize: 11,
      fontWeight: 600,
      border: `1px solid ${danger ? '#fca5a5' : '#cbd5e1'}`,
      background: danger ? '#fef2f2' : '#ffffff',
      color: danger ? '#b91c1c' : '#334155',
      cursor: 'pointer',
    }),
  };
}

function createAutomationStudioPanel(_client, React, _antd, _app, helpers = {}) {
  const h = React.createElement;
  const {
    unwrapData = (res) => res?.data?.data ?? res?.data ?? {},
    extractError = (err, fallback) => err?.response?.data?.errors?.[0]?.message || err?.message || fallback,
    formatTs = (v) => (v ? String(v).slice(0, 19).replace('T', ' ') : '-'),
    safeJsonParse = (raw, label) => {
      try {
        return { ok: true, value: JSON.parse(String(raw || '')) };
      } catch {
        return { ok: false, error: `${label} không phải JSON hợp lệ.` };
      }
    },
    statusTone = () => 'neutral',
    makeStyles = () => ({}),
    AUTOMATION_ACTION_TYPES = ['create_record', 'update_record', 'notify_role', 'call_connector', 'twin_set_desired', 'trigger_ai_triage'],
    BUILDER_ROLES = DEFAULT_AUTOMATION_CATALOG.roles,
    DEFAULT_AUTOMATION_ACTIONS = [
      { type: 'create_record', collection: 'latticeCustomWorkOrders', values: { title: 'Bảo trì khẩn kho lạnh' } },
      { type: 'notify_role', role: 'ldx_operator', title: 'Cảnh báo tự động từ Automation Engine' },
    ],
    DEFAULT_SAMPLE_EVENT = '{\n  "type": "telemetry.alarm",\n  "data": {\n    "temperature": 12.5,\n    "assetId": 1\n  }\n}',
  } = helpers;

  const S = makeStudioStyles(makeStyles());

  function defaultActionForType(type) {
    switch (type) {
      case 'create_record':
        return { type: 'create_record', label: 'Tạo bản ghi mới', collection: 'latticeCustomWorkOrders', values: { title: 'Phiếu tự động {{data.deviceKey}}' } };
      case 'update_record':
        return { type: 'update_record', label: 'Cập nhật bản ghi', collection: 'latticeCustomWorkOrders', filter: { deviceKey: '{{data.deviceKey}}' }, values: { status: 'in_progress' } };
      case 'notify_role':
        return { type: 'notify_role', label: 'Thông báo vai trò', role: 'ldx_operator', severity: 'warning', category: 'automation', title: 'Cảnh báo tự động', body: '', targetPath: '/p/cmms' };
      case 'call_connector':
        return { type: 'call_connector', label: 'Gọi Connector ngoài', connectorKey: 'n8n-coldchain-orchestrator', method: 'POST', path: '', body: { eventType: '{{type}}', data: '{{data}}' } };
      case 'twin_set_desired':
        return { type: 'twin_set_desired', label: 'Đặt lệnh Digital Twin', assetId: '{{data.assetId}}', assetEntityId: '{{data.deviceKey}}', desiredPatch: { targetTempC: 2.0, fanMode: 'high' } };
      case 'trigger_ai_triage':
        return { type: 'trigger_ai_triage', label: 'Khởi chạy AI Triage', targetCollection: 'latticeAssets', targetRecordId: '{{data.assetId}}', severity: 'high', recommendation: 'Kiểm tra sự cố {{data.deviceKey}}' };
      default:
        return { type: type || 'notify_role' };
    }
  }

  function normalizeSelectedNodeForList(node, len) {
    if (!String(node || '').startsWith('step:')) return node || 'trigger';
    const idx = Number(String(node).slice(5));
    if (!len) return 'trigger';
    if (!Number.isInteger(idx) || idx < 0 || idx >= len) return `step:${len - 1}`;
    return node;
  }

  function clearStepBufferKeys(rawBuf, idx) {
    const nextWhen = { ...(rawBuf?.whenValues || {}) };
    const nextTemp = { ...(rawBuf?.targetTempC || {}) };
    delete nextWhen[idx];
    delete nextTemp[idx];
    return { whenValues: nextWhen, targetTempC: nextTemp };
  }

  function remapStepBufferMap(mapObj, remapIndex) {
    const out = {};
    for (const [k, v] of Object.entries(mapObj || {})) {
      const nextKey = remapIndex(Number(k));
      if (nextKey !== null && nextKey !== undefined) out[nextKey] = v;
    }
    return out;
  }

  return function AutomationStudioPanel(props = {}) {
    const {
      orgPayload = {},
      runtimeRef,
      reportFeedback,
      busy = false,
      runMutation,
      loading = false,
      loadAll,
      connectors = [],
      rules = [],
      runs = [],
      rawCatalog = null,
      selectedRuleKey = '',
      setSelectedRuleKey,
      selectedRun = null,
      setSelectedRun,
    } = props;

    const effectiveOrg = String(props.effectiveOrg ?? orgPayload?.organizationId ?? '').trim();

    const [flowState, setFlowState] = React.useState(() => {
      const initialList = cloneSafe(DEFAULT_AUTOMATION_ACTIONS);
      return {
        selectedNode: 'trigger',
        list: initialList,
        text: JSON.stringify(initialList, null, 2),
        rawBuffers: { whenValues: {}, targetTempC: {} },
      };
    });
    const selectedNode = flowState.selectedNode;
    const actionsList = flowState.list;
    const actionsText = flowState.text;
    const rawBuffers = flowState.rawBuffers;

    const [showBlueprints, setShowBlueprints] = React.useState(false);
    const [showAdvancedJson, setShowAdvancedJson] = React.useState(false);
    const [ruleSearch, setRuleSearch] = React.useState('');
    const [sampleEventText, setSampleEventText] = React.useState(DEFAULT_SAMPLE_EVENT);
    const [filterState, setFilterState] = React.useState({ rows: [], complexJson: null });
    const filterRows = filterState.rows;
    const complexFilterJson = filterState.complexJson;
    const [ruleForm, setRuleForm] = React.useState({
      ruleKey: '',
      name: '',
      description: '',
      triggerEventType: 'telemetry.alarm',
      dmnTableKey: 'cmms_priority_routing_v1',
      cooldownSec: 0,
      maxDepth: 8,
      active: true,
    });
    const [activeFieldTarget, setActiveFieldTarget] = React.useState(null);
    const [aiPrompt, setAiPrompt] = React.useState('');
    const [aiBusy, setAiBusy] = React.useState(false);
    const [aiResult, setAiResult] = React.useState(null);

    React.useEffect(() => {
      setAiResult(null);
      setActiveFieldTarget(null);
    }, [effectiveOrg]);

    const catalog = React.useMemo(
      () => normalizeCatalog(rawCatalog, connectors, BUILDER_ROLES),
      [rawCatalog, connectors],
    );

    const parsedSamplePreview = React.useMemo(() => {
      const parsed = safeJsonParse(sampleEventText, 'Sample Event');
      return parsed.ok ? parsed.value : null;
    }, [sampleEventText]);

    function setSelectedNode(nextOrUpdater) {
      setFlowState((prev) => {
        const resolved = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev.selectedNode) : nextOrUpdater;
        const normalized = normalizeSelectedNodeForList(resolved, prev.list.length);
        return normalized === prev.selectedNode ? prev : { ...prev, selectedNode: normalized };
      });
    }

    function clearDryRunIfActive() {
      setSelectedRun?.((prev) => (prev?._isDryRun ? null : prev));
    }

    function updateStructuralRuleForm(updater) {
      clearDryRunIfActive();
      setRuleForm(updater);
    }

    function updateSampleEventText(raw) {
      clearDryRunIfActive();
      setSampleEventText(raw);
    }

    function updateActions(nextOrUpdater, options = {}) {
      const { nextNode, clearDryRun = true, nextRawBuffers } = options;
      if (clearDryRun) clearDryRunIfActive();
      setFlowState((prev) => {
        const resolved = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev.list, prev) : nextOrUpdater;
        const safeList = (Array.isArray(resolved) ? resolved : []).filter(
          (item) => item && typeof item === 'object' && !Array.isArray(item),
        );
        const candidateNode = nextNode !== undefined
          ? (typeof nextNode === 'function' ? nextNode(prev.selectedNode, safeList) : nextNode)
          : prev.selectedNode;
        const resolvedBuffers = nextRawBuffers !== undefined
          ? (typeof nextRawBuffers === 'function' ? nextRawBuffers(prev.rawBuffers, safeList) : nextRawBuffers)
          : prev.rawBuffers;
        return {
          selectedNode: normalizeSelectedNodeForList(candidateNode, safeList.length),
          list: safeList,
          text: JSON.stringify(safeList, null, 2),
          rawBuffers: resolvedBuffers || { whenValues: {}, targetTempC: {} },
        };
      });
    }

    function handleActionsJsonChange(raw) {
      clearDryRunIfActive();
      setFlowState((prev) => {
        let nextList = prev.list;
        let nextNode = prev.selectedNode;
        let nextBuffers = prev.rawBuffers;
        try {
          const parsed = JSON.parse(raw);
          if (
            Array.isArray(parsed)
            && parsed.every((item) => item && typeof item === 'object' && !Array.isArray(item))
          ) {
            nextList = parsed;
            nextNode = normalizeSelectedNodeForList(prev.selectedNode, nextList.length);
            nextBuffers = { whenValues: {}, targetTempC: {} };
          }
        } catch {
          // Defer validation error until Save or Dry-Run
        }
        return {
          ...prev,
          list: nextList,
          text: raw,
          selectedNode: nextNode,
          rawBuffers: nextBuffers,
        };
      });
    }

    function updateFilterState(nextOrUpdater, nextComplex = null) {
      clearDryRunIfActive();
      setFilterState((prev) => {
        const nextRows = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev.rows) : nextOrUpdater;
        return { rows: Array.isArray(nextRows) ? nextRows : [], complexJson: nextComplex };
      });
    }

    function applyRuleToCanvas(ruleObj, { updateSample = false, nextNode = 'trigger' } = {}) {
      if (!ruleObj || typeof ruleObj !== 'object') return;
      const isActive = ruleObj.active !== false && ruleObj.enabled !== false;
      const rawLoadedActions = Array.isArray(ruleObj.actionsJson)
        ? ruleObj.actionsJson
        : (Array.isArray(ruleObj.actions) ? ruleObj.actions : []);
      const loadedActions = rawLoadedActions.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
      const nextFilterState = parseFilterJsonToState(ruleObj.filterJson ?? null);
      const maxDepthNum = Number(ruleObj.maxDepth);
      const cooldownNum = Number(ruleObj.cooldownSec);
      const nextRuleKey = String(ruleObj.ruleKey || '');

      if (nextRuleKey !== String(ruleForm.ruleKey || '')) {
        setSelectedRun?.(null);
      } else {
        clearDryRunIfActive();
      }
      setActiveFieldTarget(null);
      setRuleForm({
        ruleKey: nextRuleKey,
        name: String(ruleObj.name || ''),
        description: ruleObj.description ? String(ruleObj.description) : '',
        triggerEventType: String(ruleObj.triggerEventType || 'telemetry.alarm'),
        dmnTableKey: ruleObj.dmnTableKey ? String(ruleObj.dmnTableKey) : '',
        cooldownSec: Number.isFinite(cooldownNum) && cooldownNum >= 0 ? cooldownNum : 0,
        maxDepth: Number.isFinite(maxDepthNum) && maxDepthNum >= 1 ? Math.min(8, maxDepthNum) : 8,
        active: isActive,
      });
      setFilterState({
        rows: Array.isArray(nextFilterState.rows) ? nextFilterState.rows : [],
        complexJson: nextFilterState.complexJson ?? null,
      });
      updateActions(cloneSafe(loadedActions), {
        nextNode: nextNode || undefined,
        clearDryRun: false,
        nextRawBuffers: { whenValues: {}, targetTempC: {} },
      });
      if (updateSample && ruleObj.sampleEvent && typeof ruleObj.sampleEvent === 'object') {
        setSampleEventText(JSON.stringify(ruleObj.sampleEvent, null, 2));
      }
    }

    function handleNewRule() {
      setSelectedRun?.(null);
      applyRuleToCanvas({
        ruleKey: '',
        name: '',
        description: '',
        triggerEventType: 'telemetry.alarm',
        filterJson: null,
        dmnTableKey: '',
        cooldownSec: 0,
        maxDepth: 8,
        active: true,
        actionsJson: cloneSafe(DEFAULT_AUTOMATION_ACTIONS),
      }, { nextNode: 'trigger' });
      setSampleEventText(DEFAULT_SAMPLE_EVENT);
      setAiResult(null);
    }

    function buildCurrentRulePayload(parsedActionsValue) {
      const cooldownSec = Math.max(0, Number.parseInt(String(ruleForm.cooldownSec ?? 0), 10) || 0);
      const maxDepthRaw = Number.parseInt(String(ruleForm.maxDepth ?? 8), 10);
      const maxDepth = Number.isFinite(maxDepthRaw) ? Math.min(8, Math.max(1, maxDepthRaw)) : 8;
      const sanitizedActions = (Array.isArray(parsedActionsValue) ? parsedActionsValue : []).map((act, idx) => {
        if (!act || typeof act !== 'object' || Array.isArray(act)) return act;
        const copy = { ...act };
        if (copy.values && typeof copy.values === 'object') copy.values = cleanBlankObjectKeys(copy.values);
        if (copy.filter && typeof copy.filter === 'object') copy.filter = cleanBlankObjectKeys(copy.filter);
        if (copy.body && typeof copy.body === 'object' && !Array.isArray(copy.body)) copy.body = cleanBlankObjectKeys(copy.body);
        if (Object.prototype.hasOwnProperty.call(rawBuffers.whenValues, idx) && copy.when) {
          const parsedWhen = parseWhenCondition(copy.when);
          if (!parsedWhen.isComplex) {
            copy.when = {
              field: parsedWhen.field,
              op: parsedWhen.op,
              value: coerceConditionValue(rawBuffers.whenValues[idx], parsedWhen.op),
            };
          }
        }
        if (copy.type === 'twin_set_desired' && Object.prototype.hasOwnProperty.call(rawBuffers.targetTempC, idx)) {
          const rawTemp = String(rawBuffers.targetTempC[idx] ?? '');
          const nextDesired = { ...(copy.desiredPatch || {}) };
          if (rawTemp.trim() === '') delete nextDesired.targetTempC;
          else nextDesired.targetTempC = coerceScalarValue(rawTemp);
          copy.desiredPatch = nextDesired;
        }
        return copy;
      });
      return {
        ruleKey: ruleForm.ruleKey.trim(),
        name: ruleForm.name.trim(),
        ...(ruleForm.description?.trim() ? { description: ruleForm.description.trim() } : {}),
        triggerEventType: ruleForm.triggerEventType.trim() || '*',
        filterJson: serializeFilterRows(filterRows, complexFilterJson),
        dmnTableKey: ruleForm.dmnTableKey.trim() || null,
        cooldownSec,
        maxDepth,
        actionsJson: sanitizedActions,
        actions: sanitizedActions,
        active: Boolean(ruleForm.active),
      };
    }

    function hasValidActionObjects(actionsArr) {
      return Array.isArray(actionsArr) && actionsArr.every((item) => item && typeof item === 'object' && !Array.isArray(item));
    }

    function handleSaveRule(e) {
      e?.preventDefault?.();
      const parsedActions = safeJsonParse(actionsText, 'Actions JSON');
      if (!parsedActions.ok || !hasValidActionObjects(parsedActions.value)) {
        reportFeedback({ type: 'error', text: parsedActions.error || 'Actions phải là mảng JSON gồm các object hợp lệ.' });
        return;
      }
      const rulePayload = buildCurrentRulePayload(parsedActions.value);
      return runMutation('Không lưu được Automation Rule.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosAutomations:saveRule',
          method: 'post',
          data: {
            ...orgPayload,
            ...rulePayload,
          },
        });
        const d = unwrapData(res);
        const savedKey = d.rule?.ruleKey || d.ruleKey || rulePayload.ruleKey;
        reportFeedback({ type: 'success', text: `Đã lưu Automation Rule "${savedKey}".` });
        await loadAll();
      });
    }

    function handleToggleRule(rule) {
      const isActive = rule.active !== false && rule.enabled !== false;
      return runMutation('Không bật/tắt được Automation Rule.', async (clientApi) => {
        await clientApi.request({
          url: 'dxosAutomations:toggleRule',
          method: 'post',
          data: { ...orgPayload, ruleKey: rule.ruleKey, ...(rule.id != null ? { id: rule.id } : {}), active: !isActive },
        });
        reportFeedback({ type: 'success', text: `Đã ${isActive ? 'tắt' : 'bật'} rule "${rule.ruleKey}".` });
        await loadAll();
      });
    }

    function handleDeleteRule(rule) {
      return runMutation('Không xóa được Automation Rule.', async (clientApi) => {
        await clientApi.request({
          url: 'dxosAutomations:deleteRule',
          method: 'post',
          data: { ...orgPayload, ruleKey: rule.ruleKey, ...(rule.id != null ? { id: rule.id } : {}) },
        });
        reportFeedback({ type: 'success', text: `Đã xóa rule "${rule.ruleKey}".` });
        await loadAll();
      });
    }

    function handleDryRun() {
      const parsedActions = safeJsonParse(actionsText, 'Actions JSON');
      if (!parsedActions.ok || !hasValidActionObjects(parsedActions.value)) {
        reportFeedback({ type: 'error', text: parsedActions.error || 'Actions phải là mảng JSON gồm các object hợp lệ.' });
        return;
      }
      const parsedSample = safeJsonParse(sampleEventText, 'Sample Event JSON');
      if (!parsedSample.ok || !parsedSample.value || typeof parsedSample.value !== 'object' || Array.isArray(parsedSample.value)) {
        reportFeedback({ type: 'error', text: parsedSample.error || 'Sample Event phải là JSON object hợp lệ.' });
        return;
      }
      const draftPayload = buildCurrentRulePayload(parsedActions.value);
      const simulatedRuleKey = String(draftPayload.ruleKey || '');
      const simRule = {
        ...draftPayload,
        ruleKey: draftPayload.ruleKey || 'draft_preview_rule',
        name: draftPayload.name || 'Draft Preview Rule',
      };
      return runMutation('Không mô phỏng (Dry-Run) được Automation Rule.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosAutomations:testRule',
          method: 'post',
          data: {
            ...orgPayload,
            rule: simRule,
            event: parsedSample.value,
            sampleEvent: parsedSample.value,
          },
        });
        const d = unwrapData(res);
        const sim = d.simulation || d.run || d;
        const enrichedSim = {
          ...sim,
          ruleKey: sim.ruleKey || simRule.ruleKey,
          _isDryRun: true,
          _simulatedRuleKey: simulatedRuleKey,
        };
        setSelectedRun?.(enrichedSim);
        reportFeedback({
          type: sim.status === 'failed' ? 'error' : 'success',
          text: `Dry-Run "${simRule.ruleKey}": ${sim.status || 'completed'} (${sim.durationMs ?? 0} ms).`,
        });
      });
    }

    function handleRunNow(targetKey) {
      const key = String(targetKey || ruleForm.ruleKey || '').trim();
      if (!key) {
        reportFeedback({ type: 'error', text: 'Vui lòng nhập hoặc chọn Rule Key trước khi Run Now.' });
        return;
      }
      const parsedSample = safeJsonParse(sampleEventText, 'Sample Event JSON');
      if (!parsedSample.ok || !parsedSample.value || typeof parsedSample.value !== 'object' || Array.isArray(parsedSample.value)) {
        reportFeedback({ type: 'error', text: parsedSample.error || 'Sample Event phải là JSON object hợp lệ.' });
        return;
      }
      return runMutation('Không chạy thử được Automation Rule.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosAutomations:runNow',
          method: 'post',
          data: {
            ...orgPayload,
            ruleKey: key,
            sampleEvent: parsedSample.value,
            event: parsedSample.value,
          },
        });
        const d = unwrapData(res);
        const runObj = d.run || d;
        setSelectedRuleKey?.(key);
        if (runObj && (runObj.stepTracesJson || runObj.stepTraces || runObj.runUid || runObj.runId || runObj.id)) {
          setSelectedRun?.(runObj);
        }
        reportFeedback({ type: 'success', text: `Đã chạy thử rule "${key}" (${runObj.status || 'completed'}).` });
        await loadAll(key);
      });
    }

    function handleInspectRuns(ruleKey) {
      setSelectedRuleKey?.(ruleKey);
      return loadAll(ruleKey);
    }

    function handleReplayRun(run) {
      const runUid = run.runUid || (typeof run.runId === 'string' && run.runId.startsWith('run_') ? run.runId : undefined);
      const runId = run.runId ?? run.runUid ?? run.id;
      return runMutation('Không replay được Automation Rule Run.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosAutomations:replayRun',
          method: 'post',
          data: {
            ...orgPayload,
            runId,
            ...(runUid ? { runUid } : {}),
            ...(run.id != null ? { id: run.id } : {}),
          },
        });
        const d = unwrapData(res);
        const nextRun = d.run || d;
        if (nextRun && (nextRun.stepTracesJson || nextRun.stepTraces)) setSelectedRun?.(nextRun);
        reportFeedback({ type: 'success', text: `Đã phát lại Run #${runId}.` });
        await loadAll();
      });
    }

    async function handleAiAssist(mode) {
      const clientApi = runtimeRef?.api;
      if (!clientApi?.request || aiBusy || busy) return;
      const parsedActions = safeJsonParse(actionsText, 'Actions JSON');
      const currentActions = parsedActions.ok && hasValidActionObjects(parsedActions.value) ? parsedActions.value : actionsList;
      const ruleDraft = buildCurrentRulePayload(currentActions);
      setAiBusy(true);
      reportFeedback(null);
      try {
        const res = await clientApi.request({
          url: 'dxosAutomations:aiAssist',
          method: 'post',
          data: {
            ...orgPayload,
            mode,
            prompt: aiPrompt.trim() || (mode === 'suggest' ? 'Đề xuất tối ưu hóa rule hiện tại' : 'Hoàn thiện cấu hình flow'),
            targetNode: selectedNode,
            rule: ruleDraft,
            sampleEvent: parsedSamplePreview,
          },
        });
        const d = unwrapData(res);
        setAiResult({
          mode,
          summary: d.summary || d.explanation || d.message || 'AI Copilot đã phân tích và tạo đề xuất cấu hình.',
          diffSummary: Array.isArray(d.diffSummary) ? d.diffSummary : [],
          rule: d.rule || d.draftRule || d.proposedRule || d.patchedRule || d.previewRule || null,
          patch: d.patch || null,
          sampleEvent: d.sampleEvent || null,
          suggestions: Array.isArray(d.suggestions) ? d.suggestions : [],
          targetNode: d.targetNode || (mode === 'full' ? 'trigger' : selectedNode),
        });
        reportFeedback({ type: 'success', text: `AI Copilot (${mode}) đã hoàn tất đề xuất.` });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không gọi được AI Automation Copilot.') });
      } finally {
        setAiBusy(false);
      }
    }

    function applyAiCandidate(candidateRule, candidatePatch, candidateSample, candidateTargetNode) {
      const parsedActions = safeJsonParse(actionsText, 'Actions JSON');
      const baseActions = parsedActions.ok && hasValidActionObjects(parsedActions.value) ? parsedActions.value : actionsList;
      const base = buildCurrentRulePayload(baseActions);

      let merged = candidateRule && typeof candidateRule === 'object' ? { ...base, ...candidateRule } : { ...base };
      if (!candidateRule && candidatePatch && typeof candidatePatch === 'object') {
        merged = { ...merged, ...candidatePatch };
        if (candidatePatch.stepIndex != null && candidatePatch.action) {
          const stepIdxPatch = Number(candidatePatch.stepIndex);
          const nextActs = cloneSafe(base.actionsJson);
          if (Number.isInteger(stepIdxPatch) && stepIdxPatch >= 0 && stepIdxPatch <= nextActs.length) {
            nextActs[stepIdxPatch] = candidatePatch.action;
          }
          merged.actionsJson = nextActs;
        }
      }
      if (candidateSample && typeof candidateSample === 'object') {
        merged.sampleEvent = candidateSample;
      }
      const rawTarget = candidateTargetNode !== undefined ? candidateTargetNode : aiResult?.targetNode;
      const mergedActions = Array.isArray(merged.actionsJson)
        ? merged.actionsJson
        : (Array.isArray(merged.actions) ? merged.actions : []);
      let nextNode = rawTarget && /^(trigger|filter|dmn|step:\d+)$/.test(rawTarget) ? rawTarget : 'trigger';
      if (nextNode.startsWith('step:')) {
        const targetStepIdx = Number(nextNode.slice(5));
        if (!Number.isInteger(targetStepIdx) || targetStepIdx < 0 || targetStepIdx >= mergedActions.length) {
          nextNode = 'trigger';
        }
      }
      applyRuleToCanvas(merged, {
        updateSample: Boolean(merged.sampleEvent),
        nextNode,
      });
      reportFeedback({ type: 'success', text: `Đã áp dụng đề xuất AI vào Canvas (${merged.ruleKey || 'draft'}).` });
    }

    function mutateStep(idx, updater, options = {}) {
      const { keepBuffers = true } = options;
      updateActions(
        (prevList) => prevList.map((act, i) => (i === idx ? updater(cloneSafe(act)) : act)),
        {
          nextRawBuffers: keepBuffers
            ? undefined
            : (prevBuf) => clearStepBufferKeys(prevBuf, idx),
        },
      );
    }

    function moveStep(idx, delta) {
      updateActions(
        (prevList) => {
          const target = idx + delta;
          if (idx < 0 || idx >= prevList.length || target < 0 || target >= prevList.length) return prevList;
          const next = cloneSafe(prevList);
          const [item] = next.splice(idx, 1);
          next.splice(target, 0, item);
          return next;
        },
        {
          nextNode: (prevNode, nextList) => {
            const target = idx + delta;
            if (idx >= 0 && target >= 0 && target < nextList.length) return `step:${target}`;
            return prevNode;
          },
          nextRawBuffers: (prevBuf, nextList) => {
            const target = idx + delta;
            if (idx < 0 || target < 0 || target >= nextList.length) return prevBuf;
            const swapIdx = (k) => (k === idx ? target : (k === target ? idx : k));
            return {
              whenValues: remapStepBufferMap(prevBuf?.whenValues, swapIdx),
              targetTempC: remapStepBufferMap(prevBuf?.targetTempC, swapIdx),
            };
          },
        },
      );
    }

    function duplicateStep(idx) {
      updateActions(
        (prevList) => {
          if (idx < 0 || idx >= prevList.length) return prevList;
          const next = cloneSafe(prevList);
          const copy = cloneSafe(next[idx]);
          if (copy.label) copy.label = `${copy.label} (bản sao)`;
          next.splice(idx + 1, 0, copy);
          return next;
        },
        {
          nextNode: (prevNode, nextList) => (idx >= 0 && idx + 1 < nextList.length ? `step:${idx + 1}` : prevNode),
          nextRawBuffers: (prevBuf) => {
            const shiftUp = (k) => (k > idx ? k + 1 : k);
            return {
              whenValues: remapStepBufferMap(prevBuf?.whenValues, shiftUp),
              targetTempC: remapStepBufferMap(prevBuf?.targetTempC, shiftUp),
            };
          },
        },
      );
    }

    function removeStep(idx) {
      updateActions(
        (prevList) => prevList.filter((_, i) => i !== idx),
        {
          nextNode: (prevNode, nextList) => {
            if (!String(prevNode || '').startsWith('step:')) return prevNode;
            const curIdx = Number(String(prevNode).slice(5));
            if (!nextList.length) return 'trigger';
            if (!Number.isInteger(curIdx) || curIdx < 0) return 'trigger';
            if (curIdx === idx) return `step:${Math.min(idx, nextList.length - 1)}`;
            if (curIdx > idx) return `step:${curIdx - 1}`;
            return prevNode;
          },
          nextRawBuffers: (prevBuf) => {
            const shiftDown = (k) => (k === idx ? null : (k > idx ? k - 1 : k));
            return {
              whenValues: remapStepBufferMap(prevBuf?.whenValues, shiftDown),
              targetTempC: remapStepBufferMap(prevBuf?.targetTempC, shiftDown),
            };
          },
        },
      );
    }

    function addStep(customAction) {
      const nextAct = customAction || defaultActionForType('notify_role');
      updateActions(
        (prevList) => [...cloneSafe(prevList), cloneSafe(nextAct)],
        {
          nextNode: (_prevNode, nextList) => `step:${nextList.length - 1}`,
        },
      );
    }

    function insertVariableChip(chip) {
      if (!String(selectedNode).startsWith('step:')) {
        reportFeedback({ type: 'info', text: `Đã chọn biến ${chip} — hãy mở một bước Action để chèn trực tiếp.` });
        return;
      }
      const stepIdx = Number(String(selectedNode).slice(5));
      const act = actionsList[stepIdx];
      if (!act) return;
      const target = activeFieldTarget && activeFieldTarget.stepIdx === stepIdx ? activeFieldTarget : null;
      mutateStep(stepIdx, (draft) => {
        if (target?.area === 'values' && target.key) {
          draft.values = draft.values || {};
          draft.values[target.key] = `${draft.values[target.key] ?? ''}${chip}`;
        } else if (target?.area === 'filter' && target.key) {
          draft.filter = draft.filter || {};
          draft.filter[target.key] = `${draft.filter[target.key] ?? ''}${chip}`;
        } else if (target?.area === 'body' && target.key) {
          draft.body = (draft.body && typeof draft.body === 'object' && !Array.isArray(draft.body)) ? draft.body : {};
          draft.body[target.key] = `${draft.body[target.key] ?? ''}${chip}`;
        } else if (target?.area === 'prop' && target.key) {
          draft[target.key] = `${draft[target.key] ?? ''}${chip}`;
        } else if (act.type === 'create_record' || act.type === 'update_record') {
          draft.values = draft.values || {};
          const firstKey = Object.keys(draft.values)[0] || 'title';
          draft.values[firstKey] = `${draft.values[firstKey] ?? ''}${chip}`;
        } else if (act.type === 'notify_role') {
          draft.body = `${draft.body ?? ''}${chip}`;
        } else if (act.type === 'trigger_ai_triage') {
          draft.recommendation = `${draft.recommendation ?? ''}${chip}`;
        } else if (act.type === 'twin_set_desired') {
          draft.assetEntityId = `${draft.assetEntityId ?? ''}${chip}`;
        } else {
          draft.path = `${draft.path ?? ''}${chip}`;
        }
        return draft;
      });
    }

    const tracesRaw = selectedRun?.stepTracesJson ?? selectedRun?.stepTraces ?? null;
    const tracesList = Array.isArray(tracesRaw)
      ? tracesRaw
      : (typeof tracesRaw === 'string' ? (() => { try { return JSON.parse(tracesRaw); } catch { return []; } })() : []);

    const currentRuleKey = String(ruleForm.ruleKey || '');
    const runMatchesCanvas = Boolean(
      selectedRun && (
        selectedRun._isDryRun
          ? ('_simulatedRuleKey' in selectedRun
            ? currentRuleKey === String(selectedRun._simulatedRuleKey || '')
            : Boolean(currentRuleKey && selectedRun.ruleKey === currentRuleKey))
          : Boolean(currentRuleKey && selectedRun.ruleKey === currentRuleKey)
      ),
    );
    const stepTraceByIndex = new Map();
    if (runMatchesCanvas) {
      let actionPos = 0;
      for (const tr of tracesList) {
        if (!tr || typeof tr !== 'object') continue;
        if (tr.stage === 'trigger' || tr.stage === 'dmn' || tr.type === 'recursion_guard' || tr.type === 'cooldown_guard') continue;
        if (Number.isInteger(tr.stepIndex)) {
          stepTraceByIndex.set(tr.stepIndex, tr);
        } else {
          stepTraceByIndex.set(actionPos, tr);
          actionPos += 1;
        }
      }
    }

    const triggerTraceMeta = runMatchesCanvas && selectedRun
      ? traceStatusStyle(selectedRun.status === 'skipped' && selectedRun.errorMessage === 'RECURSION_DEPTH_LIMIT_EXCEEDED' ? 'skipped' : 'completed')
      : null;
    const filterFailed = runMatchesCanvas && selectedRun?.status === 'skipped' && ['FILTER_NOT_MATCHED', 'COOLDOWN_ACTIVE', 'RECURSION_DEPTH_LIMIT_EXCEEDED'].some((c) => String(selectedRun?.errorMessage || '').includes(c));
    const filterTraceMeta = runMatchesCanvas && selectedRun
      ? traceStatusStyle(filterFailed ? 'skipped' : (selectedRun._isDryRun ? 'simulated' : 'completed'))
      : null;
    const dmnTraceMeta = runMatchesCanvas && selectedRun?.dmnResultJson
      ? traceStatusStyle(selectedRun.dmnResultJson.matched === false ? 'skipped' : (selectedRun._isDryRun ? 'simulated' : 'completed'))
      : null;

    const triggerPatterns = String(ruleForm.triggerEventType || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const branchMap = new Map();
    const mainSteps = [];
    actionsList.forEach((act, idx) => {
      if (!act?.when) {
        mainSteps.push({ act, idx });
      } else {
        const label = describeWhenLabel(act);
        const key = `${label}::${JSON.stringify(act.when)}`;
        const bucket = branchMap.get(key) || { label, when: act.when, items: [] };
        bucket.items.push({ act, idx });
        branchMap.set(key, bucket);
      }
    });
    const conditionalBranches = Array.from(branchMap.values());
    const lanes = [
      ...(mainSteps.length > 0 || conditionalBranches.length === 0
        ? [{ key: 'main', label: 'Luồng chính (Mọi mức)', isConditional: false, items: mainSteps }]
        : []),
      ...conditionalBranches.map((b, i) => ({
        key: `branch-${i}`,
        label: b.label,
        isConditional: true,
        items: b.items,
      })),
    ];

    const filteredRules = rules.filter((r) => {
      const q = ruleSearch.trim().toLowerCase();
      if (!q) return true;
      return String(r.ruleKey || '').toLowerCase().includes(q)
        || String(r.name || '').toLowerCase().includes(q)
        || String(r.triggerEventType || '').toLowerCase().includes(q);
    });

    const activeRulesCount = rules.filter((r) => r.active !== false && r.enabled !== false).length;
    const selectedStepIdx = String(selectedNode).startsWith('step:') ? Number(String(selectedNode).slice(5)) : -1;
    const selectedStep = selectedStepIdx >= 0 && selectedStepIdx < actionsList.length ? actionsList[selectedStepIdx] : null;
    const selectedDmnInfo = catalog.dmnTables.find((d) => d.tableKey === ruleForm.dmnTableKey) || null;
    const dmnOutputChips = (selectedDmnInfo?.outputs?.length ? selectedDmnInfo.outputs : ['workOrderPriority', 'assignedRole', 'approvalTier'])
      .map((name) => `{{dmn.${name}}}`);

    const aiApplyCandidate = aiResult && (
      aiResult.rule
      || aiResult.patch
      || (aiResult.suggestions?.[0]?.previewRule || aiResult.suggestions?.[0]?.rule || aiResult.suggestions?.[0]?.patch)
    );

    function renderStepForm(act, idx) {
      const colInfo = catalog.collections.find((c) => c.name === act.collection) || catalog.collections[0];
      const fieldHints = colInfo?.fields || [];
      const whenCond = parseWhenCondition(act.when);
      const hasWhenBuffer = Object.prototype.hasOwnProperty.call(rawBuffers.whenValues, idx);
      const whenInputValue = hasWhenBuffer ? rawBuffers.whenValues[idx] : whenCond.value;

      return h('div', { style: { display: 'grid', gap: 10 } },
        h('div', { style: S.grid2 },
          h('div', null,
            h('label', { style: S.label }, 'Loại Action'),
            h('select', {
              'data-testid': 'dxos-automation-step-type-select',
              value: act.type || 'create_record',
              onChange: (e) => {
                const nextType = e.target.value;
                const template = defaultActionForType(nextType);
                mutateStep(idx, (old) => ({
                  ...template,
                  label: old.label || template.label,
                  ...(old.when ? { when: old.when, branchLabel: old.branchLabel } : {}),
                }), { keepBuffers: false });
              },
              style: S.input,
            }, AUTOMATION_ACTION_TYPES.map((t) => h('option', { key: t, value: t }, `${ACTION_META[t]?.icon || ''} ${t}`))),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Tên hiển thị bước (Label)'),
            h('input', {
              'data-testid': 'dxos-automation-step-label-input',
              type: 'text',
              placeholder: ACTION_META[act.type]?.label || 'Tên bước',
              value: act.label || '',
              onChange: (e) => mutateStep(idx, (d) => ({ ...d, label: e.target.value })),
              style: S.input,
            }),
          ),
        ),

        // Branching condition control
        h('div', { style: { ...S.subCard, padding: 10, background: act.when ? '#f5f3ff' : '#f8fafc' } },
          h('div', { style: S.rowBetween },
            h('label', { style: { ...S.label, marginBottom: 0 } }, 'Điều kiện nhánh (Branching when)'),
            h('select', {
              'data-testid': 'dxos-automation-step-branch-mode',
              value: act.when ? 'when' : 'always',
              onChange: (e) => {
                const mode = e.target.value;
                mutateStep(idx, (d) => {
                  if (mode === 'always') {
                    delete d.when;
                    delete d.branchLabel;
                  } else {
                    d.when = { field: 'dmn.workOrderPriority', op: '$eq', value: 'critical' };
                    d.branchLabel = 'Khi ưu tiên = critical';
                  }
                  return d;
                }, { keepBuffers: false });
              },
              style: { ...S.input, width: 'auto', minWidth: 180 },
            },
              h('option', { value: 'always' }, 'Luôn chạy (Luồng chính)'),
              h('option', { value: 'when' }, 'Rẽ nhánh theo điều kiện (when)'),
            ),
          ),
          act.when ? h('div', { style: { display: 'grid', gap: 6 } },
            whenCond.isComplex
              ? h('div', {
                'data-testid': 'dxos-automation-step-when-complex',
                style: {
                  padding: 8,
                  borderRadius: 6,
                  border: '1px solid #ddd6fe',
                  background: '#ffffff',
                  display: 'grid',
                  gap: 4,
                  fontSize: 11,
                  color: '#4c1d95',
                },
              },
                h('strong', null, 'Điều kiện nhánh đa mệnh đề / logic ($and, $or, $not) — được giữ nguyên vẹn:'),
                whenCond.rows.length > 0
                  ? h('div', { style: S.rowWrap }, whenCond.rows.map((r, ri) => h('span', { key: ri, style: S.badge('info') }, summarizeConditionRow(r))))
                  : null,
                h('code', { style: { fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#334155' } }, JSON.stringify(act.when)),
                h('span', { style: { color: '#64748b' } }, 'Dùng mục "JSON Actions & Sample Event nâng cao" bên dưới để chỉnh sửa trực tiếp biểu thức nhiều điều kiện (mọi sửa đổi nhãn/trường khác không làm mất mệnh đề 2..N).'),
              )
              : h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 110px 1fr', gap: 6 } },
                h('input', {
                  'data-testid': 'dxos-automation-step-when-field',
                  type: 'text',
                  list: 'dxos-automation-filter-fields',
                  placeholder: 'VD: dmn.workOrderPriority',
                  value: whenCond.field,
                  onChange: (e) => {
                    const nextField = e.target.value;
                    updateActions((prevList, prevFlow) => prevList.map((d, i) => {
                      if (i !== idx) return d;
                      const cur = parseWhenCondition(d.when);
                      const rawBuf = Object.prototype.hasOwnProperty.call(prevFlow.rawBuffers.whenValues, idx)
                        ? prevFlow.rawBuffers.whenValues[idx]
                        : cur.value;
                      return {
                        ...d,
                        when: { field: nextField, op: cur.op, value: coerceConditionValue(rawBuf, cur.op) },
                      };
                    }));
                  },
                  style: S.input,
                }),
                h('select', {
                  'data-testid': 'dxos-automation-step-when-op',
                  value: whenCond.op,
                  onChange: (e) => {
                    const nextOp = e.target.value;
                    updateActions((prevList, prevFlow) => prevList.map((d, i) => {
                      if (i !== idx) return d;
                      const cur = parseWhenCondition(d.when);
                      const rawBuf = Object.prototype.hasOwnProperty.call(prevFlow.rawBuffers.whenValues, idx)
                        ? prevFlow.rawBuffers.whenValues[idx]
                        : cur.value;
                      return {
                        ...d,
                        when: { field: cur.field, op: nextOp, value: coerceConditionValue(rawBuf, nextOp) },
                      };
                    }));
                  },
                  style: S.input,
                }, FILTER_OPERATORS.map((op) => h('option', { key: op.value, value: op.value }, op.label))),
                h('input', {
                  'data-testid': 'dxos-automation-step-when-value',
                  type: 'text',
                  placeholder: 'critical',
                  value: whenInputValue,
                  onChange: (e) => {
                    const rawVal = e.target.value;
                    updateActions(
                      (prevList) => prevList.map((d, i) => {
                        if (i !== idx) return d;
                        const cur = parseWhenCondition(d.when);
                        return {
                          ...d,
                          when: { field: cur.field, op: cur.op, value: coerceConditionValue(rawVal, cur.op) },
                        };
                      }),
                      {
                        nextRawBuffers: (prevBuf) => ({
                          ...prevBuf,
                          whenValues: { ...(prevBuf?.whenValues || {}), [idx]: rawVal },
                        }),
                      },
                    );
                  },
                  onBlur: () => {
                    setFlowState((prev) => {
                      if (!Object.prototype.hasOwnProperty.call(prev.rawBuffers.whenValues, idx)) return prev;
                      const rawVal = prev.rawBuffers.whenValues[idx];
                      const nextWhenValues = { ...prev.rawBuffers.whenValues };
                      delete nextWhenValues[idx];
                      const nextList = cloneSafe(prev.list);
                      const targetAct = nextList[idx];
                      if (targetAct && targetAct.when) {
                        const cur = parseWhenCondition(targetAct.when);
                        if (!cur.isComplex) {
                          nextList[idx] = {
                            ...targetAct,
                            when: { field: cur.field, op: cur.op, value: coerceConditionValue(rawVal, cur.op) },
                          };
                        }
                      }
                      return {
                        ...prev,
                        list: nextList,
                        text: JSON.stringify(nextList, null, 2),
                        rawBuffers: { ...prev.rawBuffers, whenValues: nextWhenValues },
                      };
                    });
                  },
                  style: S.input,
                }),
              ),
            h('input', {
              'data-testid': 'dxos-automation-step-branch-label',
              type: 'text',
              placeholder: 'Nhãn nhánh hiển thị trên sơ đồ (VD: Khi ưu tiên = critical)',
              value: act.branchLabel || '',
              onChange: (e) => mutateStep(idx, (d) => ({ ...d, branchLabel: e.target.value })),
              style: S.input,
            }),
          ) : null,
        ),

        // Dedicated fields per action type
        (act.type === 'create_record' || act.type === 'update_record') ? h('div', { style: { display: 'grid', gap: 8 } },
          h('div', null,
            h('label', { style: S.label }, 'Collection mục tiêu (Allowlisted / latticeCustom*)'),
            h('select', {
              'data-testid': 'dxos-automation-step-collection-select',
              value: act.collection || '',
              onChange: (e) => mutateStep(idx, (d) => ({ ...d, collection: e.target.value })),
              style: S.input,
            },
              h('option', { value: '' }, '-- Chọn collection --'),
              catalog.collections.map((c) => h('option', { key: c.name, value: c.name }, `${c.name} (${c.title})`)),
              act.collection && !catalog.collections.some((c) => c.name === act.collection)
                ? h('option', { value: act.collection }, act.collection)
                : null,
            ),
          ),
          act.type === 'update_record' ? h('div', { style: { ...S.subCard, padding: 8 } },
            h('div', { style: S.rowBetween },
              h('span', { style: { ...S.label, marginBottom: 0 } }, 'Bộ lọc bản ghi cần cập nhật (filter)'),
              h('button', {
                type: 'button',
                onClick: () => mutateStep(idx, (d) => ({ ...d, filter: { ...(d.filter || {}), [fieldHints[0] || 'code']: '' } })),
                style: S.miniBtn(false),
              }, '+ Thêm filter'),
            ),
            buildKeyValuePairs(act.filter || {}).map((pair, pIdx) => h('div', { key: pIdx, style: { display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6 } },
              h('input', {
                type: 'text',
                list: `dxos-col-fields-${idx}`,
                value: pair.key,
                onChange: (e) => mutateStep(idx, (d) => {
                  const pairs = buildKeyValuePairs(d.filter || {});
                  if (pairs[pIdx]) pairs[pIdx].key = e.target.value;
                  return { ...d, filter: pairsToObject(pairs, { allowBlank: true }) };
                }),
                style: S.input,
              }),
              h('input', {
                type: 'text',
                value: pair.value,
                onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'filter', key: pair.key }),
                onChange: (e) => mutateStep(idx, (d) => {
                  const pairs = buildKeyValuePairs(d.filter || {});
                  if (pairs[pIdx]) pairs[pIdx].value = e.target.value;
                  return { ...d, filter: pairsToObject(pairs, { allowBlank: true }) };
                }),
                style: S.input,
              }),
              h('button', {
                type: 'button',
                onClick: () => mutateStep(idx, (d) => {
                  const pairs = buildKeyValuePairs(d.filter || {}).filter((_, i) => i !== pIdx);
                  return { ...d, filter: pairsToObject(pairs, { allowBlank: true }) };
                }),
                style: S.miniBtn(true),
              }, '✕'),
            )),
          ) : null,
          h('div', { style: { ...S.subCard, padding: 8 } },
            h('div', { style: S.rowBetween },
              h('span', { style: { ...S.label, marginBottom: 0 } }, 'Giá trị trường dữ liệu (values)'),
              h('button', {
                type: 'button',
                onClick: () => mutateStep(idx, (d) => {
                  const used = new Set(Object.keys(d.values || {}));
                  const nextField = fieldHints.find((f) => !used.has(f)) || `field_${used.size + 1}`;
                  return { ...d, values: { ...(d.values || {}), [nextField]: '' } };
                }),
                style: S.miniBtn(false),
              }, '+ Thêm trường'),
            ),
            buildKeyValuePairs(act.values || {}).map((pair, pIdx) => h('div', { key: pIdx, style: { display: 'grid', gridTemplateColumns: '1fr 1.2fr auto', gap: 6 } },
              h('input', {
                type: 'text',
                list: `dxos-col-fields-${idx}`,
                placeholder: 'Tên trường',
                value: pair.key,
                onChange: (e) => mutateStep(idx, (d) => {
                  const pairs = buildKeyValuePairs(d.values || {});
                  if (pairs[pIdx]) pairs[pIdx].key = e.target.value;
                  return { ...d, values: pairsToObject(pairs, { allowBlank: true }) };
                }),
                style: S.input,
              }),
              h('input', {
                'data-testid': `dxos-automation-step-val-${pair.key}`,
                type: 'text',
                placeholder: 'Giá trị hoặc {{template}}',
                value: pair.value,
                onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'values', key: pair.key }),
                onChange: (e) => mutateStep(idx, (d) => {
                  const pairs = buildKeyValuePairs(d.values || {});
                  if (pairs[pIdx]) pairs[pIdx].value = e.target.value;
                  return { ...d, values: pairsToObject(pairs, { allowBlank: true }) };
                }),
                style: S.input,
              }),
              h('button', {
                type: 'button',
                onClick: () => mutateStep(idx, (d) => {
                  const pairs = buildKeyValuePairs(d.values || {}).filter((_, i) => i !== pIdx);
                  return { ...d, values: pairsToObject(pairs, { allowBlank: true }) };
                }),
                style: S.miniBtn(true),
              }, '✕'),
            )),
            h('datalist', { id: `dxos-col-fields-${idx}` }, fieldHints.map((f) => h('option', { key: f, value: f }, f))),
          ),
        ) : null,

        act.type === 'notify_role' ? h('div', { style: { display: 'grid', gap: 8 } },
          h('div', { style: S.grid2 },
            h('div', null,
              h('label', { style: S.label }, 'Vai trò nhận (Role / {{dmn.assignedRole}})'),
              h('input', {
                'data-testid': 'dxos-automation-step-role-input',
                type: 'text',
                list: 'dxos-automation-roles-list',
                value: act.role || act.roleName || '',
                onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'prop', key: 'role' }),
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, role: e.target.value })),
                style: S.input,
              }),
              h('datalist', { id: 'dxos-automation-roles-list' },
                h('option', { value: '{{dmn.assignedRole}}' }, '{{dmn.assignedRole}}'),
                catalog.roles.map((r) => h('option', { key: r, value: r }, r)),
              ),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Mức độ (Severity)'),
              h('select', {
                value: act.severity || 'warning',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, severity: e.target.value })),
                style: S.input,
              }, ['info', 'warning', 'critical'].map((sv) => h('option', { key: sv, value: sv }, sv))),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Danh mục (Category)'),
              h('input', {
                type: 'text',
                value: act.category || 'automation',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, category: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Đường dẫn mở (Target Path)'),
              h('input', {
                type: 'text',
                placeholder: '/p/cmms',
                value: act.targetPath || '',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, targetPath: e.target.value })),
                style: S.input,
              }),
            ),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Tiêu đề thông báo'),
            h('input', {
              type: 'text',
              value: act.title || '',
              onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'prop', key: 'title' }),
              onChange: (e) => mutateStep(idx, (d) => ({ ...d, title: e.target.value })),
              style: S.input,
            }),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Nội dung thông báo'),
            h('textarea', {
              rows: 2,
              value: act.body || '',
              onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'prop', key: 'body' }),
              onChange: (e) => mutateStep(idx, (d) => ({ ...d, body: e.target.value })),
              style: S.textarea,
            }),
          ),
        ) : null,

        act.type === 'call_connector' ? h('div', { style: { display: 'grid', gap: 8 } },
          h('div', { style: S.grid3 },
            h('div', null,
              h('label', { style: S.label }, 'Connector từ Vault'),
              h('select', {
                'data-testid': 'dxos-automation-step-connector-select',
                value: act.connectorKey || '',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, connectorKey: e.target.value })),
                style: S.input,
              },
                h('option', { value: '' }, '-- Chọn Connector --'),
                catalog.connectors.map((c) => h('option', { key: c.connectorKey, value: c.connectorKey }, `${c.connectorKey} (${c.connectorType}/${c.authType})`)),
                act.connectorKey && !catalog.connectors.some((c) => c.connectorKey === act.connectorKey)
                  ? h('option', { value: act.connectorKey }, act.connectorKey)
                  : null,
              ),
            ),
            h('div', null,
              h('label', { style: S.label }, 'HTTP Method'),
              h('select', {
                value: act.method || 'POST',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, method: e.target.value })),
                style: S.input,
              }, ['POST', 'PUT', 'PATCH', 'GET', 'DELETE'].map((m) => h('option', { key: m, value: m }, m))),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Path nối vào Base URL'),
              h('input', {
                type: 'text',
                placeholder: 'Để trống hoặc /alerts',
                value: act.path || '',
                onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'prop', key: 'path' }),
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, path: e.target.value })),
                style: S.input,
              }),
            ),
          ),
          h('div', { style: { ...S.subCard, padding: 8 } },
            h('div', { style: S.rowBetween },
              h('span', { style: { ...S.label, marginBottom: 0 } }, 'Payload Body gửi sang Connector'),
              h('button', {
                type: 'button',
                onClick: () => mutateStep(idx, (d) => {
                  const baseBody = (d.body && typeof d.body === 'object' && !Array.isArray(d.body)) ? d.body : {};
                  return { ...d, body: { ...baseBody, [`key_${Object.keys(baseBody).length + 1}`]: '' } };
                }),
                style: S.miniBtn(false),
              }, '+ Thêm field Body'),
            ),
            buildKeyValuePairs(act.body || {}).map((pair, pIdx) => h('div', { key: pIdx, style: { display: 'grid', gridTemplateColumns: '1fr 1.2fr auto', gap: 6 } },
              h('input', {
                type: 'text',
                value: pair.key,
                onChange: (e) => mutateStep(idx, (d) => {
                  const pairs = buildKeyValuePairs(d.body || {});
                  if (pairs[pIdx]) pairs[pIdx].key = e.target.value;
                  return { ...d, body: pairsToObject(pairs, { allowBlank: true }) };
                }),
                style: S.input,
              }),
              h('input', {
                type: 'text',
                value: pair.value,
                onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'body', key: pair.key }),
                onChange: (e) => mutateStep(idx, (d) => {
                  const pairs = buildKeyValuePairs(d.body || {});
                  if (pairs[pIdx]) pairs[pIdx].value = e.target.value;
                  return { ...d, body: pairsToObject(pairs, { allowBlank: true }) };
                }),
                style: S.input,
              }),
              h('button', {
                type: 'button',
                onClick: () => mutateStep(idx, (d) => {
                  const pairs = buildKeyValuePairs(d.body || {}).filter((_, i) => i !== pIdx);
                  return { ...d, body: pairsToObject(pairs, { allowBlank: true }) };
                }),
                style: S.miniBtn(true),
              }, '✕'),
            )),
          ),
        ) : null,

        act.type === 'twin_set_desired' ? h('div', { style: { display: 'grid', gap: 8 } },
          h('div', { style: { padding: '6px 10px', borderRadius: 6, background: '#f0fdfa', border: '1px solid #99f6e4', fontSize: 11, color: '#115e59' } },
            '🛡 HITL Safety Gate: Thay đổi nhiệt độ > 2.0°C sẽ tự động chuyển qua hàng đợi phê duyệt con người (latticeAiApprovalQueue).',
          ),
          h('div', { style: S.grid2 },
            h('div', null,
              h('label', { style: S.label }, 'Asset ID'),
              h('input', {
                type: 'text',
                value: act.assetId ?? '{{data.assetId}}',
                onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'prop', key: 'assetId' }),
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, assetId: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Asset Entity ID / Device Key'),
              h('input', {
                type: 'text',
                value: act.assetEntityId ?? '{{data.deviceKey}}',
                onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'prop', key: 'assetEntityId' }),
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, assetEntityId: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Target Temp (°C)'),
              h('input', {
                'data-testid': 'dxos-automation-step-target-temp',
                type: 'text',
                value: Object.prototype.hasOwnProperty.call(rawBuffers.targetTempC, idx)
                  ? rawBuffers.targetTempC[idx]
                  : (act.desiredPatch?.targetTempC ?? ''),
                onChange: (e) => {
                  const rawTemp = e.target.value;
                  updateActions(
                    (prevList) => prevList.map((d, i) => {
                      if (i !== idx) return d;
                      const nextDesired = { ...(d.desiredPatch || {}) };
                      if (rawTemp.trim() === '') delete nextDesired.targetTempC;
                      else nextDesired.targetTempC = coerceScalarValue(rawTemp);
                      return { ...d, desiredPatch: nextDesired };
                    }),
                    {
                      nextRawBuffers: (prevBuf) => ({
                        ...prevBuf,
                        targetTempC: { ...(prevBuf?.targetTempC || {}), [idx]: rawTemp },
                      }),
                    },
                  );
                },
                onBlur: () => {
                  setFlowState((prev) => {
                    if (!Object.prototype.hasOwnProperty.call(prev.rawBuffers.targetTempC, idx)) return prev;
                    const rawTemp = String(prev.rawBuffers.targetTempC[idx] ?? '');
                    const nextTargets = { ...prev.rawBuffers.targetTempC };
                    delete nextTargets[idx];
                    const nextList = cloneSafe(prev.list);
                    const targetAct = nextList[idx];
                    if (targetAct) {
                      const nextDesired = { ...(targetAct.desiredPatch || {}) };
                      if (rawTemp.trim() === '') delete nextDesired.targetTempC;
                      else nextDesired.targetTempC = coerceScalarValue(rawTemp);
                      nextList[idx] = { ...targetAct, desiredPatch: nextDesired };
                    }
                    return {
                      ...prev,
                      list: nextList,
                      text: JSON.stringify(nextList, null, 2),
                      rawBuffers: { ...prev.rawBuffers, targetTempC: nextTargets },
                    };
                  });
                },
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Fan Mode'),
              h('select', {
                value: act.desiredPatch?.fanMode || 'auto',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, desiredPatch: { ...(d.desiredPatch || {}), fanMode: e.target.value } })),
                style: S.input,
              }, ['auto', 'eco', 'high', 'low'].map((m) => h('option', { key: m, value: m }, m))),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Defrost Mode'),
              h('select', {
                value: act.desiredPatch?.defrostMode || 'auto',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, desiredPatch: { ...(d.desiredPatch || {}), defrostMode: e.target.value } })),
                style: S.input,
              }, ['auto', 'manual', 'off'].map((m) => h('option', { key: m, value: m }, m))),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Door Lock'),
              h('select', {
                value: act.desiredPatch?.doorLock || 'locked',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, desiredPatch: { ...(d.desiredPatch || {}), doorLock: e.target.value } })),
                style: S.input,
              }, ['locked', 'unlocked'].map((m) => h('option', { key: m, value: m }, m))),
            ),
          ),
        ) : null,

        act.type === 'trigger_ai_triage' ? h('div', { style: { display: 'grid', gap: 8 } },
          h('div', { style: S.grid3 },
            h('div', null,
              h('label', { style: S.label }, 'Target Collection'),
              h('select', {
                value: act.targetCollection || 'latticeAssets',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, targetCollection: e.target.value })),
                style: S.input,
              },
                catalog.collections.map((c) => h('option', { key: c.name, value: c.name }, c.name)),
                act.targetCollection && !catalog.collections.some((c) => c.name === act.targetCollection)
                  ? h('option', { value: act.targetCollection }, act.targetCollection)
                  : null,
              ),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Target Record ID'),
              h('input', {
                type: 'text',
                value: act.targetRecordId ?? '{{steps.0.id}}',
                onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'prop', key: 'targetRecordId' }),
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, targetRecordId: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Severity'),
              h('select', {
                value: act.severity || 'high',
                onChange: (e) => mutateStep(idx, (d) => ({ ...d, severity: e.target.value })),
                style: S.input,
              }, ['medium', 'high', 'critical'].map((sv) => h('option', { key: sv, value: sv }, sv))),
            ),
          ),
          h('div', null,
            h('label', { style: S.label }, 'Khuyến nghị Triage (Recommendation)'),
            h('textarea', {
              rows: 2,
              value: act.recommendation || '',
              onFocus: () => setActiveFieldTarget({ stepIdx: idx, area: 'prop', key: 'recommendation' }),
              onChange: (e) => mutateStep(idx, (d) => ({ ...d, recommendation: e.target.value })),
              style: S.textarea,
            }),
          ),
        ) : null,

        // Variable chips inserter
        h('div', { style: { display: 'grid', gap: 4 } },
          h('span', { style: { fontSize: 11, fontWeight: 600, color: '#475569' } }, 'Chèn biến động vào trường đang chọn:'),
          h('div', { style: S.rowWrap },
            [...VARIABLE_CHIPS, ...dmnOutputChips.filter((c) => !VARIABLE_CHIPS.includes(c))].map((chip) => h('button', {
              key: chip,
              type: 'button',
              onClick: () => insertVariableChip(chip),
              style: S.chip(false),
            }, chip)),
          ),
        ),
      );
    }

    return h('div', { style: S.card },
      // 1. Top Studio Toolbar
      h('div', { 'data-testid': 'dxos-automation-studio-toolbar', style: S.toolbar },
        h('div', { style: { display: 'grid', gap: 6 } },
          h('div', { style: S.rowWrap },
            h('h3', { style: { margin: 0, fontSize: 16, color: '#0f172a' } }, 'Visual Automation Studio & Inline AI Copilot'),
            h('span', { style: S.kpiPill('info') }, `${rules.length} Rules`),
            h('span', { style: S.kpiPill('ok') }, `${activeRulesCount} Đang bật`),
            h('span', { style: S.kpiPill('neutral') }, `${actionsList.length} Bước · ${conditionalBranches.length} Nhánh`),
            selectedRun ? h('span', { style: S.kpiPill(statusTone(selectedRun.status)) },
              `${selectedRun._isDryRun ? 'Dry-Run' : 'Run'}: ${selectedRun.status || 'completed'} · ${selectedRun.durationMs ?? 0} ms`,
            ) : null,
          ),
          h('p', { style: { margin: 0, fontSize: 12, color: '#475569' } }, 'Thiết kế luồng Event → Filter & Guard → DMN → Nhánh hành động (SVG), mô phỏng Dry-Run và trợ lý AI Copilot theo từng node.'),
        ),
        h('div', { style: S.rowWrap },
          h('button', {
            'data-testid': 'dxos-automation-new-rule-btn',
            type: 'button',
            disabled: busy,
            onClick: handleNewRule,
            style: S.btn(false, false, busy),
          }, '+ Rule mới'),
          h('button', {
            'data-testid': 'dxos-automation-blueprint-toggle-btn',
            type: 'button',
            onClick: () => setShowBlueprints((p) => !p),
            style: S.btn(showBlueprints, false, false),
          }, `📦 Thư viện Blueprint (${catalog.blueprints.length} mẫu)`),
          h('button', {
            'data-testid': 'dxos-automation-dryrun-btn',
            type: 'button',
            disabled: busy,
            onClick: handleDryRun,
            style: S.btn(false, false, busy),
          }, '▶ Mô phỏng (Dry-Run)'),
          h('button', {
            'data-testid': 'dxos-automation-toolbar-run-btn',
            type: 'button',
            disabled: busy,
            onClick: () => handleRunNow(ruleForm.ruleKey),
            style: S.btn(false, false, busy),
          }, '⚡ Chạy thật'),
          h('button', {
            'data-testid': 'dxos-automation-toolbar-save-btn',
            type: 'button',
            disabled: busy,
            onClick: handleSaveRule,
            style: S.btn(true, false, busy),
          }, '💾 Lưu Rule'),
        ),
      ),

      // Blueprint Gallery (toggleable)
      showBlueprints ? h('div', { 'data-testid': 'dxos-automation-blueprint-gallery', style: S.blueprintGrid },
        catalog.blueprints.map((bp) => h('div', { key: bp.ruleKey, style: S.blueprintCard },
          h('div', { style: { display: 'grid', gap: 4 } },
            h('div', { style: S.rowBetween },
              h('strong', { style: { fontSize: 13, color: '#0f172a' } }, bp.name),
              h('span', { style: S.badge('info') }, bp.badge || `${(bp.actionsJson || []).length} bước`),
            ),
            h('div', { style: { fontSize: 11, color: '#475569' } }, bp.description),
            h('div', { style: { fontSize: 11, color: '#64748b' } },
              `Event: ${bp.triggerEventType}${bp.dmnTableKey ? ` · DMN: ${bp.dmnTableKey}` : ''}`,
            ),
          ),
          h('button', {
            'data-testid': `dxos-automation-blueprint-load-${bp.ruleKey}`,
            type: 'button',
            onClick: () => {
              applyRuleToCanvas(bp, { updateSample: true, nextNode: 'trigger' });
              reportFeedback({ type: 'success', text: `Đã nạp Blueprint "${bp.ruleKey}" vào Flow Canvas.` });
            },
            style: S.btn(true),
          }, 'Nạp vào Canvas'),
        )),
      ) : null,

      // 2. 3-Pane Studio Workspace
      h('div', { style: S.workspace },
        // Left Pane: Rules List & Legacy Actions Table
        h('div', { style: S.leftPane },
          h('div', { style: S.rowBetween },
            h('strong', { style: { fontSize: 13, color: '#0f172a' } }, 'Danh sách Rules'),
            h('span', { style: S.badge('neutral') }, `${filteredRules.length}/${rules.length}`),
          ),
          h('input', {
            'data-testid': 'dxos-automation-rule-search',
            type: 'text',
            placeholder: 'Tìm theo ruleKey, tên, event…',
            value: ruleSearch,
            onChange: (e) => setRuleSearch(e.target.value),
            style: S.input,
          }),
          h('div', { style: S.tableWrap },
            h('table', { 'data-testid': 'dxos-automation-rules-table', style: S.table },
              h('thead', null, h('tr', null, ['Rule & Event', 'Cấu trúc', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
              h('tbody', null,
                !filteredRules.length
                  ? h('tr', null, h('td', { colSpan: 3, style: { ...S.td, color: '#64748b' } }, 'Chưa có Automation Rule nào.'))
                  : filteredRules.map((r) => {
                    const isActive = r.active !== false && r.enabled !== false;
                    const acts = Array.isArray(r.actionsJson) ? r.actionsJson : (Array.isArray(r.actions) ? r.actions : []);
                    const branchCount = acts.filter((a) => Boolean(a?.when)).length;
                    const isCurrent = ruleForm.ruleKey && ruleForm.ruleKey === r.ruleKey;
                    return h('tr', { key: r.id || r.ruleKey, style: isCurrent ? { background: '#eff6ff' } : undefined },
                      h('td', { style: S.td },
                        h('div', { style: { display: 'grid', gap: 2 } },
                          h('code', { style: { fontWeight: 700 } }, r.ruleKey),
                          h('span', { style: { fontSize: 11, color: '#334155' } }, r.name),
                          h('div', { style: S.rowWrap },
                            h('span', { style: S.badge('info') }, r.triggerEventType || '*'),
                            r.dmnTableKey ? h('span', { style: S.badge('warn') }, r.dmnTableKey) : null,
                          ),
                        ),
                      ),
                      h('td', { style: S.td },
                        h('div', { style: { display: 'grid', gap: 4 } },
                          h('span', { style: S.badge(isActive ? 'ok' : 'neutral') }, isActive ? 'active' : 'paused'),
                          h('span', { style: { fontSize: 11, color: '#475569' } }, `${acts.length} bước${branchCount ? ` · ${branchCount} nhánh` : ''}`),
                        ),
                      ),
                      h('td', { style: { ...S.td, display: 'flex', gap: 4, flexWrap: 'wrap' } },
                        h('button', {
                          'data-testid': `dxos-automation-run-${r.ruleKey}`,
                          type: 'button',
                          disabled: busy,
                          onClick: () => handleRunNow(r.ruleKey),
                          style: S.miniBtn(false),
                        }, 'Run Now'),
                        h('button', {
                          'data-testid': `dxos-automation-toggle-${r.ruleKey}`,
                          type: 'button',
                          disabled: busy,
                          onClick: () => handleToggleRule(r),
                          style: S.miniBtn(false),
                        }, isActive ? 'Tạm dừng' : 'Bật'),
                        h('button', {
                          'data-testid': `dxos-automation-runs-btn-${r.ruleKey}`,
                          type: 'button',
                          disabled: busy,
                          onClick: () => handleInspectRuns(r.ruleKey),
                          style: S.miniBtn(false),
                        }, 'Runs'),
                        h('button', {
                          'data-testid': `dxos-automation-edit-${r.ruleKey}`,
                          type: 'button',
                          disabled: busy,
                          onClick: () => applyRuleToCanvas(r, { nextNode: 'trigger' }),
                          style: S.miniBtn(false),
                        }, 'Nạp sửa'),
                        h('button', {
                          'data-testid': `dxos-automation-delete-${r.ruleKey}`,
                          type: 'button',
                          disabled: busy,
                          onClick: () => handleDeleteRule(r),
                          style: S.miniBtn(true),
                        }, 'Xóa'),
                      ),
                    );
                  }),
              ),
            ),
          ),
        ),

        // Center Pane: Interactive SVG Branching Flow Canvas
        h('div', { 'data-testid': 'dxos-automation-flow-canvas', style: S.centerPane },
          h('div', { style: S.rowBetween },
            h('div', { style: S.rowWrap },
              h('strong', { style: { fontSize: 13, color: '#0f172a' } }, 'Flow Canvas'),
              h('code', { style: { fontSize: 11, background: '#e2e8f0', padding: '2px 6px', borderRadius: 4 } }, ruleForm.ruleKey || 'draft_rule'),
              h('span', { style: S.badge(ruleForm.active ? 'ok' : 'neutral') }, ruleForm.active ? 'active' : 'paused'),
            ),
            h('div', { style: S.rowWrap },
              h('button', {
                'data-testid': 'dxos-automation-add-action-btn',
                type: 'button',
                onClick: () => addStep(),
                style: S.miniBtn(false),
              }, '+ Thêm bước'),
              h('button', {
                'data-testid': 'dxos-automation-add-branch-btn',
                type: 'button',
                onClick: () => addStep({
                  ...defaultActionForType('notify_role'),
                  label: 'Thông báo leo thang critical',
                  when: { field: 'dmn.workOrderPriority', op: '$eq', value: 'critical' },
                  branchLabel: 'Khi ưu tiên = critical',
                  role: 'ldx_manager',
                  severity: 'critical',
                }),
                style: S.miniBtn(false),
              }, '+ Thêm nhánh critical'),
            ),
          ),

          // Node 1: Trigger
          h('div', {
            'data-testid': 'dxos-canvas-node-trigger',
            role: 'button',
            tabIndex: 0,
            onClick: () => setSelectedNode('trigger'),
            style: S.canvasNode(selectedNode === 'trigger', triggerTraceMeta),
          },
            h('div', { style: S.rowBetween },
              h('span', { style: { fontSize: 12, fontWeight: 700, color: '#1e3a8a' } }, '⚡ 1. Event Trigger'),
              triggerTraceMeta ? h('span', { style: { fontSize: 11, fontWeight: 700, color: triggerTraceMeta.color } }, triggerTraceMeta.label) : null,
            ),
            h('div', { style: S.rowWrap },
              triggerPatterns.map((pat) => h('span', { key: pat, style: S.badge('info') }, pat)),
            ),
            parsedSamplePreview ? h('div', { style: { fontSize: 11, color: '#475569' } },
              `Sample: ${parsedSamplePreview.type || '-'} · ${Object.keys(parsedSamplePreview.data || {}).slice(0, 3).map((k) => `${k}=${JSON.stringify(parsedSamplePreview.data[k])}`).join(', ') || 'empty'}`,
            ) : null,
          ),

          // SVG Connector Trigger -> Filter
          h('svg', { width: '100%', height: 22, viewBox: '0 0 240 22', preserveAspectRatio: 'xMidYMid meet', style: { display: 'block' } },
            h('line', { x1: 120, y1: 0, x2: 120, y2: 16, stroke: '#94a3b8', strokeWidth: 2 }),
            h('polygon', { points: '115,14 125,14 120,21', fill: '#64748b' }),
          ),

          // Node 2: Filter & Guard
          h('div', {
            'data-testid': 'dxos-canvas-node-filter',
            role: 'button',
            tabIndex: 0,
            onClick: () => setSelectedNode('filter'),
            style: S.canvasNode(selectedNode === 'filter', filterTraceMeta),
          },
            h('div', { style: S.rowBetween },
              h('span', { style: { fontSize: 12, fontWeight: 700, color: '#334155' } }, '🛡 2. Filter & Anti-Loop Guard'),
              filterTraceMeta ? h('span', { style: { fontSize: 11, fontWeight: 700, color: filterTraceMeta.color } },
                filterFailed ? `⊘ ${selectedRun.errorMessage}` : filterTraceMeta.label,
              ) : null,
            ),
            h('div', { style: S.rowWrap },
              filterRows.length
                ? filterRows.map((fr, i) => h('span', { key: i, style: S.badge('warn') }, summarizeConditionRow(fr)))
                : (complexFilterJson
                  ? h('span', { style: S.badge('warn') }, 'Filter nâng cao (JSON)')
                  : h('span', { style: S.badge('neutral') }, 'Không lọc · Nhận mọi payload')),
              h('span', { style: S.badge('neutral') }, `Cooldown: ${ruleForm.cooldownSec ?? 0}s`),
              h('span', { style: S.badge('neutral') }, `Max Depth: ${ruleForm.maxDepth ?? 8}`),
            ),
          ),

          // SVG Connector Filter -> DMN
          h('svg', { width: '100%', height: 22, viewBox: '0 0 240 22', preserveAspectRatio: 'xMidYMid meet', style: { display: 'block' } },
            h('line', { x1: 120, y1: 0, x2: 120, y2: 16, stroke: '#94a3b8', strokeWidth: 2 }),
            h('polygon', { points: '115,14 125,14 120,21', fill: '#64748b' }),
          ),

          // Node 3: DMN Matrix
          h('div', {
            'data-testid': 'dxos-canvas-node-dmn',
            role: 'button',
            tabIndex: 0,
            onClick: () => setSelectedNode('dmn'),
            style: S.canvasNode(selectedNode === 'dmn', dmnTraceMeta),
          },
            h('div', { style: S.rowBetween },
              h('span', { style: { fontSize: 12, fontWeight: 700, color: '#92400e' } }, '🧮 3. DMN Decision Table'),
              dmnTraceMeta ? h('span', { style: { fontSize: 11, fontWeight: 700, color: dmnTraceMeta.color } }, dmnTraceMeta.label) : null,
            ),
            h('div', { style: S.rowWrap },
              h('span', { style: S.badge(ruleForm.dmnTableKey ? 'warn' : 'neutral') }, ruleForm.dmnTableKey || 'Bỏ qua DMN (chạy thẳng Actions)'),
            ),
            runMatchesCanvas && selectedRun?.dmnResultJson?.outputs ? h('div', { style: S.rowWrap },
              Object.entries(selectedRun.dmnResultJson.outputs).map(([k, v]) => h('span', { key: k, style: S.badge('ok') }, `${k}: ${v}`)),
            ) : null,
          ),

          // SVG Fork Diagram (DMN -> Lanes)
          h('svg', { width: '100%', height: 28, viewBox: '0 0 320 28', preserveAspectRatio: 'none', style: { display: 'block' } },
            lanes.length <= 1
              ? [
                h('line', { key: 'v', x1: 160, y1: 0, x2: 160, y2: 22, stroke: '#64748b', strokeWidth: 2 }),
                h('polygon', { key: 'a', points: '155,20 165,20 160,27', fill: '#64748b' }),
              ]
              : lanes.map((lane, lIdx) => {
                const targetX = Math.round(((lIdx + 0.5) * 320) / lanes.length);
                const stroke = lane.isConditional ? '#8b5cf6' : '#64748b';
                return h('g', { key: lane.key },
                  h('path', {
                    d: `M 160 0 C 160 14, ${targetX} 10, ${targetX} 24`,
                    fill: 'none',
                    stroke,
                    strokeWidth: 2,
                    ...(lane.isConditional ? { strokeDasharray: '4 3' } : {}),
                  }),
                  h('circle', { cx: targetX, cy: 24, r: 3, fill: stroke }),
                );
              }),
          ),

          // Branch Lanes & Action Step Nodes
          h('div', { style: { display: 'grid', gridTemplateColumns: lanes.length > 1 ? 'repeat(auto-fit, minmax(220px, 1fr))' : '1fr', gap: 10 } },
            lanes.map((lane) => h('div', { key: lane.key, style: S.branchLane(lane.isConditional) },
              h('div', { style: S.rowBetween },
                h('strong', { style: { fontSize: 11, color: lane.isConditional ? '#6d28d9' : '#334155' } },
                  lane.isConditional ? `⑂ Nhánh: ${lane.label}` : `▶ ${lane.label}`,
                ),
                h('span', { style: S.badge(lane.isConditional ? 'info' : 'neutral') }, `${lane.items.length} bước`),
              ),
              !lane.items.length
                ? h('div', { style: { fontSize: 11, color: '#64748b', padding: 6 } }, 'Chưa có bước nào trong luồng chính.')
                : lane.items.map(({ act, idx }) => {
                  const meta = ACTION_META[act.type] || { icon: '⚙', label: act.type || 'step', color: '#475569', bg: '#f1f5f9', border: '#cbd5e1' };
                  const trace = stepTraceByIndex.get(idx) || null;
                  const traceMeta = trace ? traceStatusStyle(trace.status) : null;
                  return h('div', {
                    key: idx,
                    'data-testid': `dxos-canvas-node-step-${idx}`,
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => setSelectedNode(`step:${idx}`),
                    style: S.canvasNode(selectedNode === `step:${idx}`, traceMeta),
                  },
                    h('div', { style: S.rowBetween },
                      h('div', { style: S.rowWrap },
                        h('span', { style: { fontSize: 11, fontWeight: 700, color: '#475569' } }, `#${idx + 1}`),
                        h('span', {
                          style: {
                            padding: '2px 6px',
                            borderRadius: 6,
                            fontSize: 10,
                            fontWeight: 700,
                            background: meta.bg,
                            color: meta.color,
                            border: `1px solid ${meta.border}`,
                          },
                        }, `${meta.icon} ${act.type}`),
                      ),
                      traceMeta ? h('span', { style: { fontSize: 10, fontWeight: 700, color: traceMeta.color } },
                        `${traceMeta.label}${trace?.durationMs != null ? ` · ${trace.durationMs}ms` : ''}`,
                      ) : null,
                    ),
                    h('strong', { style: { fontSize: 12, color: '#0f172a' } }, act.label || meta.label),
                    h('div', { style: { fontSize: 11, color: '#475569' } }, summarizeActionTarget(act)),
                    act.when ? h('div', { style: { fontSize: 10, color: '#6d28d9' } }, `when: ${describeWhenLabel(act)}`) : null,
                    trace?.error ? h('div', { style: { fontSize: 10, color: '#b91c1c' } }, trace.error) : null,
                    h('div', { style: { display: 'flex', gap: 4, justifyContent: 'flex-end', marginTop: 2 } },
                      h('button', {
                        type: 'button',
                        disabled: idx === 0,
                        onClick: (e) => { e?.stopPropagation?.(); moveStep(idx, -1); },
                        style: S.miniBtn(false),
                      }, '↑'),
                      h('button', {
                        type: 'button',
                        disabled: idx === actionsList.length - 1,
                        onClick: (e) => { e?.stopPropagation?.(); moveStep(idx, 1); },
                        style: S.miniBtn(false),
                      }, '↓'),
                      h('button', {
                        type: 'button',
                        onClick: (e) => { e?.stopPropagation?.(); duplicateStep(idx); },
                        style: S.miniBtn(false),
                      }, '⧉'),
                      h('button', {
                        type: 'button',
                        onClick: (e) => { e?.stopPropagation?.(); removeStep(idx); },
                        style: S.miniBtn(true),
                      }, 'Xóa'),
                    ),
                  );
                }),
            )),
          ),
        ),

        // Right Pane: Contextual Property Inspector & Inline AI Copilot
        h('div', { 'data-testid': 'dxos-automation-inspector', style: S.rightPane },
          h('form', { 'data-testid': 'dxos-automation-rule-form', onSubmit: handleSaveRule, style: { display: 'grid', gap: 10 } },
            h('div', { style: S.rowBetween },
              h('strong', { style: { fontSize: 13, color: '#0f172a' } }, `Inspector · ${describeSelectedNode(selectedNode)}`),
              h('div', { style: S.rowWrap },
                ['trigger', 'filter', 'dmn'].map((nodeKey) => h('button', {
                  key: nodeKey,
                  type: 'button',
                  onClick: () => setSelectedNode(nodeKey),
                  style: S.chip(selectedNode === nodeKey),
                }, nodeKey.toUpperCase())),
              ),
            ),

            // Core Rule Identity (always visible for quick editing & legacy test compatibility)
            h('div', { style: { ...S.subCard, padding: 10 } },
              h('div', { style: S.grid2 },
                h('div', null,
                  h('label', { style: S.label }, 'Rule Key'),
                  h('input', {
                    'data-testid': 'dxos-automation-rule-key-input',
                    type: 'text',
                    required: true,
                    placeholder: 'VD: auto_cmms_on_coldchain_fault',
                    value: ruleForm.ruleKey,
                    onChange: (e) => updateStructuralRuleForm((p) => ({ ...p, ruleKey: e.target.value })),
                    style: S.input,
                  }),
                ),
                h('div', null,
                  h('label', { style: S.label }, 'Tên Rule'),
                  h('input', {
                    'data-testid': 'dxos-automation-rule-name-input',
                    type: 'text',
                    required: true,
                    placeholder: 'VD: Tự tạo WO bảo trì khi vượt nhiệt',
                    value: ruleForm.name,
                    onChange: (e) => setRuleForm((p) => ({ ...p, name: e.target.value })),
                    style: S.input,
                  }),
                ),
              ),
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155' } },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(ruleForm.active),
                  onChange: (e) => updateStructuralRuleForm((p) => ({ ...p, active: Boolean(e?.target?.checked) })),
                }),
                'Kích hoạt Rule tự động theo Event Bus',
              ),
            ),

            // Trigger Inspector (kept mounted in DOM)
            h('div', { style: { ...S.subCard, padding: 10, display: selectedNode === 'trigger' ? 'grid' : 'none' } },
              h('div', { style: S.rowBetween },
                h('strong', { style: { fontSize: 12 } }, 'Cấu hình Event Trigger'),
                h('button', {
                  type: 'button',
                  onClick: () => {
                    const primaryType = triggerPatterns[0] || 'telemetry.alarm';
                    const matched = catalog.eventTypes.find((ev) => ev.eventType === primaryType);
                    if (matched?.sampleEvent) {
                      updateSampleEventText(JSON.stringify(matched.sampleEvent, null, 2));
                      reportFeedback({ type: 'info', text: `Đã nạp Sample Event chuẩn cho "${primaryType}".` });
                    }
                  },
                  style: S.miniBtn(false),
                }, 'Nạp Sample Event chuẩn'),
              ),
              h('div', null,
                h('label', { style: S.label }, 'Chọn Event chuẩn từ Catalog'),
                h('select', {
                  value: catalog.eventTypes.some((e) => e.eventType === ruleForm.triggerEventType) ? ruleForm.triggerEventType : '',
                  onChange: (e) => {
                    if (e.target.value) updateStructuralRuleForm((p) => ({ ...p, triggerEventType: e.target.value }));
                  },
                  style: S.input,
                },
                  h('option', { value: '' }, '-- Chọn hoặc nhập pattern nhiều event bên dưới --'),
                  catalog.eventTypes.map((ev) => h('option', { key: ev.eventType, value: ev.eventType }, `${ev.eventType} — ${ev.label}`)),
                ),
              ),
              h('div', null,
                h('label', { style: S.label }, 'Trigger Event Type (hỗ trợ nhiều event cách nhau dấu phẩy)'),
                h('input', {
                  'data-testid': 'dxos-automation-trigger-input',
                  type: 'text',
                  required: true,
                  placeholder: 'telemetry.alarm',
                  value: ruleForm.triggerEventType,
                  onChange: (e) => updateStructuralRuleForm((p) => ({ ...p, triggerEventType: e.target.value })),
                  style: S.input,
                }),
              ),
            ),

            // Filter & Guard Inspector (kept mounted in DOM)
            h('div', { style: { ...S.subCard, padding: 10, display: selectedNode === 'filter' ? 'grid' : 'none' } },
              h('div', { style: S.rowBetween },
                h('strong', { style: { fontSize: 12 } }, 'Bộ lọc Điều kiện & Chống lặp'),
                h('button', {
                  'data-testid': 'dxos-automation-add-filter-btn',
                  type: 'button',
                onClick: () => updateFilterState((prev) => [...prev, { field: 'temperature', op: '$gte', value: '8' }], null),
                  style: S.miniBtn(false),
                }, '+ Điều kiện'),
              ),
              h('datalist', { id: 'dxos-automation-filter-fields' },
                SUGGESTED_FILTER_FIELDS.map((f) => h('option', { key: f, value: f }, f)),
              ),
              filterRows.map((fr, i) => h('div', { key: i, style: { display: 'grid', gridTemplateColumns: '1fr 105px 1fr auto', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'text',
                  list: 'dxos-automation-filter-fields',
                  placeholder: 'Trường (VD: temperature)',
                  value: fr.field,
                  onChange: (e) => updateFilterState((prev) => prev.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)), null),
                  style: S.input,
                }),
                h('select', {
                  value: fr.op,
                  onChange: (e) => updateFilterState((prev) => prev.map((r, j) => (j === i ? { ...r, op: e.target.value } : r)), null),
                  style: S.input,
                }, FILTER_OPERATORS.map((op) => h('option', { key: op.value, value: op.value }, op.label))),
                h('input', {
                  type: 'text',
                  placeholder: 'Giá trị',
                  value: fr.value,
                  onChange: (e) => updateFilterState((prev) => prev.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)), null),
                  style: S.input,
                }),
                h('button', {
                  type: 'button',
                  onClick: () => updateFilterState((prev) => prev.filter((_, j) => j !== i), null),
                  style: S.miniBtn(true),
                }, '✕'),
              )),
              h('div', { style: S.grid2 },
                h('div', null,
                  h('label', { style: S.label }, 'Cooldown chống bão (giây)'),
                  h('input', {
                    'data-testid': 'dxos-automation-cooldown-input',
                    type: 'number',
                    min: 0,
                    value: ruleForm.cooldownSec,
                    onChange: (e) => updateStructuralRuleForm((p) => ({ ...p, cooldownSec: e.target.value === '' ? 0 : Math.max(0, Number(e.target.value) || 0) })),
                    style: S.input,
                  }),
                ),
                h('div', null,
                  h('label', { style: S.label }, 'Max Depth chống lặp (1..8)'),
                  h('input', {
                    'data-testid': 'dxos-automation-maxdepth-input',
                    type: 'number',
                    min: 1,
                    max: 8,
                    value: ruleForm.maxDepth,
                    onChange: (e) => updateStructuralRuleForm((p) => ({ ...p, maxDepth: Math.min(8, Math.max(1, Number(e.target.value) || 8)) })),
                    style: S.input,
                  }),
                ),
              ),
            ),

            // DMN Inspector (kept mounted in DOM)
            h('div', { style: { ...S.subCard, padding: 10, display: selectedNode === 'dmn' ? 'grid' : 'none' } },
              h('strong', { style: { fontSize: 12 } }, 'Ma trận Quyết định DMN'),
              h('div', null,
                h('label', { style: S.label }, 'Chọn bảng DMN'),
                h('select', {
                  value: ruleForm.dmnTableKey || '',
                  onChange: (e) => updateStructuralRuleForm((p) => ({ ...p, dmnTableKey: e.target.value })),
                  style: S.input,
                },
                  h('option', { value: '' }, '-- Không dùng DMN --'),
                  catalog.dmnTables.map((d) => h('option', { key: d.tableKey, value: d.tableKey }, `${d.tableKey} — ${d.name}`)),
                  ruleForm.dmnTableKey && !catalog.dmnTables.some((d) => d.tableKey === ruleForm.dmnTableKey)
                    ? h('option', { value: ruleForm.dmnTableKey }, ruleForm.dmnTableKey)
                    : null,
                ),
              ),
              h('div', null,
                h('label', { style: S.label }, 'DMN Table Key (tùy chọn)'),
                h('input', {
                  'data-testid': 'dxos-automation-dmn-input',
                  type: 'text',
                  placeholder: 'cmms_priority_routing_v1',
                  value: ruleForm.dmnTableKey,
                  onChange: (e) => updateStructuralRuleForm((p) => ({ ...p, dmnTableKey: e.target.value })),
                  style: S.input,
                }),
              ),
              h('div', { style: { display: 'grid', gap: 4 } },
                h('span', { style: { fontSize: 11, color: '#475569', fontWeight: 600 } }, 'Biến đầu ra DMN khả dụng (bấm để chèn / sao chép):'),
                h('div', { style: S.rowWrap },
                  dmnOutputChips.map((chip) => h('button', {
                    key: chip,
                    type: 'button',
                    onClick: () => {
                      if (actionsList.length > 0) {
                        setSelectedNode('step:0');
                        reportFeedback({ type: 'info', text: `Đã chuyển sang Bước #1 — bấm lại ${chip} để chèn vào trường đang sửa.` });
                      } else {
                        reportFeedback({ type: 'info', text: `Biến DMN: ${chip}` });
                      }
                    },
                    style: S.chip(false),
                  }, chip)),
                ),
              ),
            ),

            // Action Step Inspector + Always-Mounted Advanced JSON & Sample Event Drawer
            h('div', { 'data-testid': 'dxos-automation-actions-editor', style: { display: 'grid', gap: 8 } },
              selectedStep ? h('div', { style: { ...S.subCard, padding: 10 } },
                h('div', { style: S.rowBetween },
                  h('strong', { style: { fontSize: 12 } }, `Cấu hình Bước #${selectedStepIdx + 1}`),
                  h('span', { style: S.badge('info') }, selectedStep.type),
                ),
                renderStepForm(selectedStep, selectedStepIdx),
              ) : null,

              h('div', { style: { ...S.subCard, padding: 10 } },
                h('div', { style: S.rowBetween },
                  h('strong', { style: { fontSize: 12, color: '#334155' } }, 'JSON Actions & Sample Event nâng cao (đồng bộ 2 chiều)'),
                  h('button', {
                    'data-testid': 'dxos-automation-json-toggle-btn',
                    type: 'button',
                    onClick: () => setShowAdvancedJson((p) => !p),
                    style: S.miniBtn(false),
                  }, showAdvancedJson ? 'Thu gọn JSON' : 'Mở JSON nâng cao'),
                ),
                h('div', { style: { display: showAdvancedJson ? 'grid' : 'none', gap: 8 } },
                  h('div', null,
                    h('label', { style: S.label }, 'Actions JSON (đồng bộ hai chiều)'),
                    h('textarea', {
                      'data-testid': 'dxos-automation-actions-json',
                      rows: 4,
                      value: actionsText,
                      onChange: (e) => handleActionsJsonChange(e.target.value),
                      style: S.textarea,
                    }),
                  ),
                  h('div', null,
                    h('label', { style: S.label }, 'Sample Event JSON dùng khi Dry-Run / Run Now'),
                    h('textarea', {
                      'data-testid': 'dxos-automation-sample-event',
                      rows: 3,
                      value: sampleEventText,
                      onChange: (e) => updateSampleEventText(e.target.value),
                      style: S.textarea,
                    }),
                  ),
                ),
              ),
            ),

            h('div', { style: S.rowWrap },
              h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Lưu Automation Rule'),
            ),
          ),

          // Inline AI Automation Copilot
          h('div', {
            'data-testid': 'dxos-automation-ai-copilot',
            style: { ...S.subCard, border: '1px solid #c4b5fd', background: 'linear-gradient(180deg, #faf5ff 0%, #ffffff 100%)' },
          },
            h('div', { style: S.rowBetween },
              h('strong', { style: { fontSize: 13, color: '#5b21b6' } }, '✨ Inline AI Automation Copilot'),
              h('span', { style: S.badge('info') }, `Đang chọn: ${describeSelectedNode(selectedNode)}`),
            ),
            h('textarea', {
              'data-testid': 'dxos-automation-ai-prompt',
              rows: 2,
              placeholder: 'Mô tả bằng tiếng Việt luồng bạn muốn dựng hoặc tối ưu hóa…',
              value: aiPrompt,
              onChange: (e) => setAiPrompt(e.target.value),
              style: S.textarea,
            }),
            h('div', { style: S.rowWrap },
              AI_QUICK_PROMPTS.map((qp, i) => h('button', {
                key: i,
                type: 'button',
                onClick: () => setAiPrompt(qp),
                style: S.chip(false),
              }, qp.length > 44 ? `${qp.slice(0, 44)}…` : qp)),
            ),
            h('div', { style: S.rowWrap },
              h('button', {
                'data-testid': 'dxos-automation-ai-suggest-btn',
                type: 'button',
                disabled: aiBusy || busy,
                onClick: () => handleAiAssist('suggest'),
                style: S.btn(false, false, aiBusy || busy),
              }, '✨ Gợi ý tối ưu'),
              h('button', {
                'data-testid': 'dxos-automation-ai-node-btn',
                type: 'button',
                disabled: aiBusy || busy,
                onClick: () => handleAiAssist('node'),
                style: S.btn(false, false, aiBusy || busy),
              }, '🎯 Sửa node đang chọn'),
              h('button', {
                'data-testid': 'dxos-automation-ai-full-btn',
                type: 'button',
                disabled: aiBusy || busy,
                onClick: () => handleAiAssist('full'),
                style: S.btn(true, false, aiBusy || busy),
              }, '🚀 Dựng toàn bộ flow'),
            ),

            aiResult ? h('div', {
              style: { padding: 10, borderRadius: 8, border: '1px solid #ddd6fe', background: '#ffffff', display: 'grid', gap: 8 },
            },
              h('div', { style: S.rowBetween },
                h('strong', { style: { fontSize: 12, color: '#4c1d95' } }, `Kết quả Copilot (${aiResult.mode})`),
                aiApplyCandidate ? h('button', {
                  'data-testid': 'dxos-automation-ai-apply-btn',
                  type: 'button',
                  onClick: () => applyAiCandidate(
                    aiResult.rule || aiResult.suggestions?.[0]?.previewRule || aiResult.suggestions?.[0]?.rule,
                    aiResult.patch || aiResult.suggestions?.[0]?.patch,
                    aiResult.sampleEvent,
                  ),
                  style: S.btn(true),
                }, 'Áp dụng vào Canvas') : null,
              ),
              h('div', { style: { fontSize: 12, color: '#1e293b' } }, aiResult.summary),
              aiResult.diffSummary.length ? h('ul', { style: { margin: 0, paddingLeft: 18, fontSize: 11, color: '#475569' } },
                aiResult.diffSummary.map((line, i) => h('li', { key: i }, line)),
              ) : null,
              aiResult.suggestions.length ? h('div', { style: { display: 'grid', gap: 6 } },
                aiResult.suggestions.map((sug, i) => {
                  const sid = sug.id || `sug-${i}`;
                  const sugTarget = sug.previewRule || sug.rule || sug.patch;
                  return h('div', {
                    key: sid,
                    style: { padding: 8, borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
                  },
                    h('div', { style: { fontSize: 11 } },
                      h('strong', { style: { color: '#0f172a' } }, sug.title || sid),
                      (sug.description || sug.reason) ? h('div', { style: { color: '#475569', marginTop: 2 } }, sug.description || sug.reason) : null,
                    ),
                    sugTarget ? h('button', {
                      'data-testid': `dxos-automation-ai-apply-suggestion-${sid}`,
                      type: 'button',
                      onClick: () => applyAiCandidate(sug.previewRule || sug.rule, sug.patch, sug.sampleEvent, sug.targetNode),
                      style: S.miniBtn(false),
                    }, 'Áp dụng') : null,
                  );
                }),
              ) : null,
            ) : null,
          ),
        ),
      ),

      // 3. Bottom Panel: Execution Runs & Step Trace Inspector
      h('div', { 'data-testid': 'dxos-automation-runs-panel', style: S.subCard },
        h('div', { style: S.rowBetween },
          h('strong', { style: { fontSize: 13 } }, `Execution Runs & Step Traces${selectedRuleKey ? ` (${selectedRuleKey})` : ''}`),
          h('div', { style: S.rowWrap },
            selectedRuleKey ? h('button', { type: 'button', onClick: () => handleInspectRuns(''), style: S.btn(false) }, 'Xem tất cả Rules') : null,
            h('button', { type: 'button', onClick: () => loadAll(), disabled: loading, style: S.btn(false, false, loading) }, 'Làm mới Runs'),
          ),
        ),
        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-automation-runs-table', style: S.table },
            h('thead', null, h('tr', null, ['Run ID', 'Rule Key', 'Status', 'Duration', 'Executed At', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !runs.length
                ? h('tr', null, h('td', { colSpan: 6, style: { ...S.td, color: '#64748b' } }, 'Chưa có lượt chạy Automation nào.'))
                : runs.map((run) => {
                  const runId = run.runUid ?? run.runId ?? run.id;
                  const duration = run.durationMs ?? run.duration ?? 0;
                  return h('tr', { key: runId },
                    h('td', { style: S.td }, h('code', null, String(runId))),
                    h('td', { style: S.td }, h('code', null, run.ruleKey || '-')),
                    h('td', { style: S.td }, h('span', { style: S.badge(statusTone(run.status)) }, run.status || 'completed')),
                    h('td', { style: S.td }, `${duration} ms`),
                    h('td', { style: S.td }, formatTs(run.startedAt || run.createdAt)),
                    h('td', { style: { ...S.td, display: 'flex', gap: 6 } },
                      h('button', {
                        'data-testid': `dxos-automation-trace-btn-${runId}`,
                        type: 'button',
                        onClick: () => setSelectedRun(run),
                        style: S.btn(false),
                      }, 'Xem Trace'),
                      h('button', {
                        'data-testid': `dxos-automation-replay-${runId}`,
                        type: 'button',
                        disabled: busy,
                        onClick: () => handleReplayRun(run),
                        style: S.btn(false, false, busy),
                      }, 'Replay'),
                    ),
                  );
                }),
            ),
          ),
        ),
        selectedRun ? h('div', { 'data-testid': 'dxos-automation-trace-inspector', style: { padding: 10, borderRadius: 8, background: '#ffffff', border: '1px solid #cbd5e1', display: 'grid', gap: 6 } },
          h('div', { style: S.rowBetween },
            h('strong', { style: { fontSize: 12 } }, `${selectedRun._isDryRun ? 'Dry-Run Simulation' : 'Trace Inspector'} — Run ${selectedRun.runUid ?? selectedRun.runId ?? selectedRun.id ?? ''} (${selectedRun.durationMs ?? selectedRun.duration ?? 0} ms)`),
            h('span', { style: S.badge(statusTone(selectedRun.status)) }, selectedRun.status || 'completed'),
          ),
          selectedRun.dmnResultJson ? h('div', { style: { fontSize: 11, color: '#334155', background: '#fffbeb', padding: '6px 8px', borderRadius: 6, border: '1px solid #fde68a' } },
            `DMN ${selectedRun.dmnResultJson.tableKey || ''}: ${JSON.stringify(selectedRun.dmnResultJson.outputs || {})}`,
          ) : null,
          tracesList.length ? h('div', { style: { display: 'grid', gap: 6 } },
            tracesList.map((step, i) => {
              const stepIdx = step.stepIndex ?? i;
              const tone = statusTone(step.status || 'ok');
              return h('div', {
                key: i,
                onClick: () => {
                  if (Number.isInteger(step.stepIndex) && step.stepIndex < actionsList.length) {
                    setSelectedNode(`step:${step.stepIndex}`);
                  }
                },
                style: { padding: 8, borderRadius: 6, background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 12, cursor: 'pointer' },
              },
                h('div', { style: S.rowBetween },
                  h('strong', null, `#${stepIdx + 1} ${step.stage || step.type || step.name || 'step'}`),
                  h('span', { style: S.badge(tone) }, `${step.status || 'ok'} · ${step.durationMs ?? 0} ms`),
                ),
                step.skipReason ? h('div', { style: { fontSize: 11, color: '#92400e', marginTop: 2 } }, `Skip: ${step.skipReason}`) : null,
                h('pre', { style: { margin: '4px 0 0', fontSize: 11, overflowX: 'auto' } }, JSON.stringify(step, null, 2)),
              );
            }),
          ) : h('pre', { style: { margin: 0, fontSize: 11, overflowX: 'auto' } }, JSON.stringify(tracesRaw ?? selectedRun, null, 2)),
        ) : null,
      ),
    );
  };
}

module.exports = {
  createAutomationStudioPanel,
  DEFAULT_AUTOMATION_CATALOG,
  DEFAULT_AUTOMATION_BLUEPRINTS,
  FILTER_OPERATORS,
  normalizeCatalog,
  parseFilterJsonToState,
  serializeFilterRows,
  parseWhenCondition,
  pairsToObject,
  coerceScalarValue,
  coerceConditionValue,
};
