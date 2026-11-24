/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('node:crypto');

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const LDX_ROLE_RE = /^ldx_[a-z0-9_]{2,40}$/;
const SENSITIVE_FIELD_RE = /password|secret|token|apikey|api_key|identitySubject|privateKey|hash|salt|signatureDataUrl|encrypted/i;

const ALLOWLISTED_BUSINESS_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeOrderLines',
  'latticeServiceTickets',
  'latticeParaDocuments',
  'latticeIncidentCases',
  'latticeLocations',
  'latticeAssets',
  'latticeAgentProposals',
]);

const FORBIDDEN_SYSTEM_COLLECTIONS = new Set([
  'users',
  'roles',
  'rolesUsers',
  'apiKeys',
  'authenticators',
  'migrations',
  'applicationPlugins',
  'applicationTokens',
  'sessions',
  'aiSettings',
  'aiEmployees',
  'aiMcpClients',
  'rolesAiEmployees',
  'latticeAiAuditLogs',
  'latticeAiProfiles',
  'latticeAiQuotaUsage',
  'latticeUiSnapshots',
  'dataSourcesRoles',
  'dataSourcesRolesResources',
  'dataSourcesRolesResourcesActions',
  'dataSourcesRolesResourcesScopes',
  'llmServices',
  'rolesDesktopRoutes',
  'desktopRoutes',
  'uiLayouts',
  'workflows',
  'flow_nodes',
  'collections',
  'fields',
  'latticeNotifications',
  'latticeSlaPolicies',
  'latticeAiApprovalQueue',
  'latticeParaChunks',
  'latticePkiKeys',
  'latticeCryptoLedger',
  'latticeConnectors',
  'latticeWebhookSubscriptions',
  'latticeWebhookDeliveries',
  'latticeEventBus',
  'latticeApiKeys',
  'latticeDelegations',
  'latticeDecisionTables',
  'latticeEpodRecords',
  'latticeOrganizations',
  'latticeAutomationRules',
  'latticeAutomationRuns',
]);

const DEFAULT_LDX_ROLES = Object.freeze([
  'ldx_admin',
  'ldx_manager',
  'ldx_operator',
  'ldx_dispatcher',
  'ldx_warehouse',
  'ldx_driver',
  'ldx_employee',
  'ldx_viewer',
]);

const DEFAULT_COLLECTION_SCHEMAS = Object.freeze({
  latticeCustomWorkOrders: {
    title: 'Phiếu bảo trì CMMS',
    fields: [
      { name: 'workOrderCode', type: 'string', title: 'Mã phiếu bảo trì' },
      { name: 'title', type: 'string', title: 'Tiêu đề' },
      { name: 'assetId', type: 'integer', title: 'ID Tài sản' },
      { name: 'deviceKey', type: 'string', title: 'Mã thiết bị' },
      { name: 'priority', type: 'string', title: 'Độ ưu tiên', enumValues: ['low', 'medium', 'high', 'critical'] },
      { name: 'status', type: 'string', title: 'Trạng thái', enumValues: ['open', 'in_progress', 'completed', 'cancelled'] },
      { name: 'faultSummary', type: 'text', title: 'Mô tả sự cố' },
      { name: 'assignedRole', type: 'string', title: 'Vai trò phụ trách' },
      { name: 'dueAt', type: 'datetime', title: 'Hạn xử lý' },
    ],
  },
  latticeServiceTickets: {
    title: 'Phiếu dịch vụ nội bộ',
    fields: [
      { name: 'code', type: 'string', title: 'Mã phiếu' },
      { name: 'name', type: 'string', title: 'Tiêu đề phiếu' },
      { name: 'serviceType', type: 'string', title: 'Loại dịch vụ', enumValues: ['leave', 'it_support', 'facilities', 'hr_request'] },
      { name: 'priority', type: 'string', title: 'Độ ưu tiên', enumValues: ['low', 'medium', 'high'] },
      { name: 'description', type: 'text', title: 'Mô tả chi tiết' },
      { name: 'resolutionNote', type: 'text', title: 'Kết quả xử lý' },
    ],
  },
  latticeIncidentCases: {
    title: 'Hồ sơ sự cố',
    fields: [
      { name: 'code', type: 'string', title: 'Mã sự cố' },
      { name: 'name', type: 'string', title: 'Tên sự cố' },
      { name: 'runId', type: 'string', title: 'Mã lượt quy trình' },
      { name: 'assetEntityId', type: 'string', title: 'URN tài sản' },
      { name: 'handlerId', type: 'string', title: 'Người xử lý' },
      { name: 'severity', type: 'string', title: 'Mức độ', enumValues: ['low', 'medium', 'high', 'critical'] },
      { name: 'status', type: 'string', title: 'Trạng thái', enumValues: ['open', 'acknowledged', 'closed'] },
      { name: 'proposal', type: 'text', title: 'Đề xuất giải pháp' },
      { name: 'resolutionNote', type: 'text', title: 'Ghi chú khắc phục' },
    ],
  },
  latticeOrders: {
    title: 'Đơn hàng / Vận đơn',
    fields: [
      { name: 'code', type: 'string', title: 'Mã đơn' },
      { name: 'name', type: 'string', title: 'Tên đơn hàng' },
      { name: 'customer', type: 'string', title: 'Khách hàng' },
      { name: 'origin', type: 'string', title: 'Điểm đi' },
      { name: 'destination', type: 'string', title: 'Điểm đến' },
      { name: 'quantity', type: 'float', title: 'Số lượng' },
      { name: 'description', type: 'text', title: 'Nội dung' },
    ],
  },
  latticeOrderLines: {
    title: 'Dòng đơn hàng WMS',
    fields: [
      { name: 'orderCode', type: 'string', title: 'Mã đơn' },
      { name: 'lineNo', type: 'integer', title: 'Số dòng' },
      { name: 'sku', type: 'string', title: 'SKU' },
      { name: 'productName', type: 'string', title: 'Sản phẩm' },
      { name: 'requestedQty', type: 'float', title: 'Số lượng yêu cầu' },
      { name: 'notes', type: 'string', title: 'Ghi chú' },
    ],
  },
  latticeRequests: {
    title: 'Yêu cầu nghiệp vụ',
    fields: [
      { name: 'code', type: 'string', title: 'Mã yêu cầu' },
      { name: 'name', type: 'string', title: 'Tiêu đề' },
      { name: 'category', type: 'string', title: 'Phân loại' },
      { name: 'description', type: 'text', title: 'Mô tả' },
    ],
  },
  latticeParaDocuments: {
    title: 'Tài liệu P.A.R.A.',
    fields: [
      { name: 'title', type: 'string', title: 'Tiêu đề' },
      { name: 'paraCategory', type: 'string', title: 'Phân loại P.A.R.A.' },
      { name: 'summary', type: 'text', title: 'Tóm tắt' },
      { name: 'sourceCollection', type: 'string', title: 'Bảng nguồn' },
    ],
  },
  latticeLocations: {
    title: 'Địa điểm / Kho lạnh',
    fields: [
      { name: 'code', type: 'string', title: 'Mã địa điểm' },
      { name: 'name', type: 'string', title: 'Tên địa điểm' },
      { name: 'kind', type: 'string', title: 'Loại địa điểm' },
      { name: 'address', type: 'string', title: 'Địa chỉ' },
    ],
  },
  latticeAssets: {
    title: 'Tài sản & Thiết bị',
    fields: [
      { name: 'code', type: 'string', title: 'Mã tài sản' },
      { name: 'name', type: 'string', title: 'Tên tài sản' },
      { name: 'kind', type: 'string', title: 'Loại thiết bị' },
      { name: 'status', type: 'string', title: 'Trạng thái' },
    ],
  },
  latticeAgentProposals: {
    title: 'Đề xuất AI Agent',
    fields: [
      { name: 'targetCollection', type: 'string', title: 'Bảng đích' },
      { name: 'targetRecordId', type: 'integer', title: 'ID bản ghi' },
      { name: 'recommendation', type: 'text', title: 'Khuyến nghị AI' },
      { name: 'state', type: 'string', title: 'Trạng thái', enumValues: ['proposed', 'approved', 'rejected'] },
    ],
  },
});

const STANDARD_EVENT_CATALOG = Object.freeze([
  {
    type: 'alarm.triggered',
    label: 'Cảnh báo sự cố IoT / Ngưỡng',
    category: 'iot',
    description: 'Phát ra khi bộ giám sát ngưỡng thiết bị kích hoạt cảnh báo sự cố.',
    sampleEvent: {
      type: 'alarm.triggered',
      source: '/dxos/alarm-engine',
      subject: 'urn:ngsi-ld:Asset:org-a:native:1',
      data: {
        severity: 'critical',
        deviceKey: 'freezer-01',
        assetId: 1,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1',
        metricName: 'temperature',
        numericValue: 11.5,
        message: 'Nhiệt độ kho lạnh vượt ngưỡng 8°C (11.5°C)',
      },
    },
  },
  {
    type: 'device.offline',
    label: 'Thiết bị IoT mất kết nối (LWT)',
    category: 'iot',
    description: 'Phát ra khi Broker nhận MQTT Last Will & Testament hoặc phát hiện thiết bị offline.',
    sampleEvent: {
      type: 'device.offline',
      source: 'dxos-broker',
      subject: 'cold-truck-ct-01',
      data: {
        severity: 'critical',
        deviceKey: 'cold-truck-ct-01',
        assetId: 1,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1',
        reason: 'MQTT LWT connection lost',
        message: 'Mất kết nối cảm biến xe lạnh (LWT)',
      },
    },
  },
  {
    type: 'telemetry.alarm',
    label: 'Cảnh báo Telemetry chuỗi thời gian',
    category: 'iot',
    description: 'Phát ra khi luồng telemetry nhiệt độ/độ ẩm vượt dải an toàn.',
    sampleEvent: {
      type: 'telemetry.alarm',
      source: 'dxos-telemetry',
      subject: 'sensor-01',
      data: {
        severity: 'high',
        deviceKey: 'sensor-01',
        assetId: 1,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1',
        temperature: 12.5,
        threshold: 8.0,
        message: 'Nhiệt độ cảm biến vượt ngưỡng 12.5°C',
      },
    },
  },
  {
    type: 'lot.held_mkt',
    label: 'Cách ly lô vượt ngưỡng MKT',
    category: 'wms',
    description: 'Phát ra khi Mean Kinetic Temperature của lô hàng vượt ngưỡng và bị chuyển trạng thái hold_mkt.',
    sampleEvent: {
      type: 'lot.held_mkt',
      source: 'dxos-studio:wms',
      subject: 'LOT-VAX-01',
      data: {
        lotCode: 'LOT-VAX-01',
        sku: 'SKU-VAX-MKT-28',
        mktCelsius: 10.4,
        maxTempC: 11.2,
        thresholdCelsius: 8.0,
        lotStatus: 'hold_mkt',
        severity: 'high',
        assetEntityId: 'lot:LOT-VAX-01',
        totalAmountM: 650,
      },
    },
  },
  {
    type: 'epod.signed',
    label: 'ePOD đã ký xác nhận bàn giao',
    category: 'wms',
    description: 'Phát ra sau khi tài xế/khách hàng hoàn tất chữ ký điện tử ePOD kèm GPS và niêm phong PKI.',
    sampleEvent: {
      type: 'epod.signed',
      source: 'dxos-studio:wms',
      subject: 'EPOD-001',
      data: {
        epodUid: 'EPOD-001',
        orderId: 10,
        orderCode: 'ORD-V100-001',
        recipientName: 'Trung tâm Tiêm chủng Cần Thơ',
        deliveredQty: 30,
        inRange: true,
      },
    },
  },
  {
    type: 'voucher.submitted',
    label: 'Chứng từ trình duyệt',
    category: 'governance',
    description: 'Phát ra khi chứng từ nghiệp vụ được trình duyệt chính thức.',
    sampleEvent: {
      type: 'voucher.submitted',
      source: 'dxos-studio:voucher',
      subject: 'ORD-V100-001',
      data: {
        collection: 'latticeOrders',
        recordId: 10,
        code: 'ORD-V100-001',
        totalAmountM: 650,
        maxTempC: 6.5,
        severity: 'medium',
      },
    },
  },
  {
    type: 'voucher.cancelled',
    label: 'Chứng từ bị hủy',
    category: 'governance',
    description: 'Phát ra khi chứng từ đã trình duyệt được hủy theo quy trình đối soát.',
    sampleEvent: {
      type: 'voucher.cancelled',
      source: 'dxos-studio:voucher',
      subject: 'REQ-100',
      data: {
        collection: 'latticeRequests',
        recordId: 12,
        code: 'REQ-100',
        cancelReason: 'Thay đổi kế hoạch điều vận',
      },
    },
  },
  {
    type: 'sla.warning',
    label: 'Cảnh báo sắp chạm ngưỡng SLA',
    category: 'sla',
    description: 'Phát ra trước khi phiếu dịch vụ hoặc sự cố vượt thời hạn SLA.',
    sampleEvent: {
      type: 'sla.warning',
      source: 'dxos-sla',
      subject: 'TKT-001',
      data: {
        targetCollection: 'latticeServiceTickets',
        recordId: 15,
        code: 'TKT-001',
        priority: 'high',
        remainingMinutes: 15,
        slaPolicy: 'urgent',
      },
    },
  },
  {
    type: 'sla.breached',
    label: 'Vi phạm SLA quá hạn',
    category: 'sla',
    description: 'Phát ra khi bản ghi đã vượt quá ngưỡng thời gian cam kết SLA.',
    sampleEvent: {
      type: 'sla.breached',
      source: 'dxos-sla',
      subject: 'TKT-001',
      data: {
        targetCollection: 'latticeServiceTickets',
        recordId: 15,
        code: 'TKT-001',
        priority: 'urgent',
        overdueMinutes: 30,
        slaPolicy: 'urgent',
      },
    },
  },
  {
    type: 'orion.notification',
    label: 'Thông báo NGSI-LD Orion-LD',
    category: 'iot',
    description: 'Phát ra khi FIWARE Orion-LD đẩy callback thay đổi thuộc tính thực thể Digital Twin.',
    sampleEvent: {
      type: 'orion.notification',
      source: 'orion-ld',
      subject: 'urn:ngsi-ld:Asset:org-a:native:1',
      data: {
        entityId: 'urn:ngsi-ld:Asset:org-a:native:1',
        entityType: 'Asset',
        temperature: 9.8,
        subscriptionKey: 'coldchain-temp-sub',
      },
    },
  },
  {
    type: 'manual.trigger',
    label: 'Kích hoạt thủ công / API',
    category: 'system',
    description: 'Kích hoạt trực tiếp từ Automation Studio, AI Copilot hoặc API runNow.',
    sampleEvent: {
      type: 'manual.trigger',
      source: 'dxos-studio:manual',
      subject: 'manual',
      data: {
        severity: 'medium',
        deviceKey: 'freezer-01',
        assetId: 1,
        message: 'Kiểm thử luồng tự động hóa',
      },
    },
  },
]);

const ACTION_SCHEMA_CATALOG = Object.freeze([
  {
    type: 'create_record',
    label: 'Tạo bản ghi dữ liệu',
    category: 'data',
    description: 'Tạo bản ghi mới trong collection nghiệp vụ được allowlist hoặc latticeCustom*.',
    fields: ['collection', 'values'],
    defaultAction: {
      type: 'create_record',
      label: 'Tạo bản ghi mới',
      collection: 'latticeServiceTickets',
      values: { code: 'AUTO-{{id}}', name: 'Tự động tạo từ {{type}}', serviceType: 'facilities', priority: 'medium' },
    },
  },
  {
    type: 'update_record',
    label: 'Cập nhật bản ghi dữ liệu',
    category: 'data',
    description: 'Cập nhật trường nghiệp vụ trên collection allowlist (tự động khóa trường chứng từ lõi).',
    fields: ['collection', 'filter', 'values'],
    defaultAction: {
      type: 'update_record',
      label: 'Cập nhật bản ghi',
      collection: 'latticeCustomWorkOrders',
      filter: { deviceKey: '{{data.deviceKey}}' },
      values: { status: 'in_progress' },
    },
  },
  {
    type: 'notify_role',
    label: 'Thông báo theo Vai trò',
    category: 'notification',
    description: 'Gửi thông báo in-app hoặc đa kênh tới tất cả nhân sự thuộc vai trò ldx_*.',
    fields: ['role', 'category', 'severity', 'title', 'body', 'targetCollection', 'targetRecordId', 'targetPath'],
    defaultAction: {
      type: 'notify_role',
      label: 'Thông báo vai trò phụ trách',
      role: 'ldx_operator',
      category: 'automation',
      severity: 'warning',
      title: 'Cảnh báo tự động ({{type}})',
      body: 'Sự kiện từ {{data.deviceKey}}',
    },
  },
  {
    type: 'call_connector',
    label: 'Gọi Vault Connector (n8n / Webhook)',
    category: 'integration',
    description: 'Gọi HTTP connector đã lưu trong AES-256-GCM Vault kèm chữ ký HMAC và SSRF guard.',
    fields: ['connectorKey', 'method', 'path', 'body'],
    defaultAction: {
      type: 'call_connector',
      label: 'Gọi tích hợp ngoài',
      connectorKey: 'n8n-coldchain-orchestrator',
      method: 'POST',
      body: { eventType: '{{type}}', data: '{{data}}' },
    },
  },
  {
    type: 'twin_set_desired',
    label: 'Điều khiển Digital Twin (HITL)',
    category: 'iot',
    description: 'Cập nhật desired setpoint thiết bị; tự động chặn qua hàng đợi HITL nếu chênh lệch > 2°C.',
    fields: ['assetId', 'assetEntityId', 'desiredPatch'],
    defaultAction: {
      type: 'twin_set_desired',
      label: 'Đặt ngưỡng Digital Twin (HITL)',
      assetId: '{{data.assetId}}',
      assetEntityId: '{{data.assetEntityId}}',
      desiredPatch: { targetTempC: 4.0, fanMode: 'high' },
    },
  },
  {
    type: 'trigger_ai_triage',
    label: 'Phân tích sự cố AI Triage',
    category: 'ai',
    description: 'Tạo đề xuất phân tích AI gắn với bản ghi đích để kỹ sư/quản lý rà soát.',
    fields: ['targetCollection', 'targetRecordId', 'severity', 'recommendation'],
    defaultAction: {
      type: 'trigger_ai_triage',
      label: 'Chạy AI Triage',
      targetCollection: 'latticeAssets',
      targetRecordId: '{{data.assetId}}',
      severity: 'high',
      recommendation: 'Kiểm tra sự cố từ {{type}} trên {{data.deviceKey}}.',
    },
  },
]);

const AUTOMATION_BLUEPRINTS = Object.freeze([
  {
    blueprintKey: 'auto_cmms_on_coldchain_fault',
    ruleKey: 'auto_cmms_on_coldchain_fault',
    name: 'Ứng cứu khẩn Chuỗi lạnh & Bảo trì CMMS (5 bước rẽ nhánh)',
    description:
      'Đánh giá bảng quyết định cmms_priority_routing_v1, tự tạo phiếu bảo trì CMMS, báo vai trò phụ trách và rẽ nhánh khi ưu tiên = critical để hạ nhiệt Digital Twin (HITL), chạy AI Triage và đẩy điều phối sang n8n.',
    category: 'cold-chain',
    triggerEventType: 'alarm.triggered,device.offline',
    filterJson: null,
    dmnTableKey: 'cmms_priority_routing_v1',
    cooldownSec: 60,
    maxDepth: 8,
    active: true,
    sampleEvent: {
      type: 'alarm.triggered',
      source: '/dxos/alarm-engine',
      subject: 'urn:ngsi-ld:Asset:org-a:native:1',
      data: {
        severity: 'critical',
        deviceKey: 'freezer-01',
        assetId: 1,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1',
        message: 'Nhiệt độ kho lạnh vượt ngưỡng 8°C (11.5°C)',
      },
    },
    actionsJson: [
      {
        type: 'create_record',
        label: 'Tạo phiếu bảo trì CMMS',
        branchLabel: null,
        when: null,
        collection: 'latticeCustomWorkOrders',
        values: {
          workOrderCode: 'WO-{{id}}',
          title: 'Cold-Chain Fault: {{data.deviceKey}}',
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
        branchLabel: null,
        when: null,
        role: '{{dmn.assignedRole}}',
        category: 'cmms',
        severity: 'warning',
        title: 'CMMS Work Order ({{dmn.workOrderPriority}})',
        body: 'Tự tạo phiếu #{{steps.0.id}} cho {{data.deviceKey}}',
        targetCollection: 'latticeCustomWorkOrders',
        targetPath: '/p/cmms',
      },
      {
        type: 'twin_set_desired',
        label: 'Hạ nhiệt khẩn Digital Twin (HITL)',
        branchLabel: 'Khi ưu tiên = critical',
        when: { 'dmn.workOrderPriority': 'critical' },
        assetId: '{{data.assetId}}',
        assetEntityId: '{{data.assetEntityId}}',
        desiredPatch: { targetTempC: 4.0, fanMode: 'high' },
      },
      {
        type: 'trigger_ai_triage',
        label: 'Phân tích sự cố bằng AI Triage',
        branchLabel: 'Khi ưu tiên = critical',
        when: { 'dmn.workOrderPriority': 'critical' },
        targetCollection: 'latticeCustomWorkOrders',
        targetRecordId: '{{steps.0.id}}',
        severity: 'critical',
        recommendation:
          'Sự cố chuỗi lạnh nghiêm trọng trên {{data.deviceKey}}: kiểm tra máy nén, xác nhận lệnh hạ nhiệt 4°C và xử lý phiếu CMMS #{{steps.0.id}}.',
      },
      {
        type: 'call_connector',
        label: 'Đẩy điều phối sang n8n',
        branchLabel: 'Khi ưu tiên = critical',
        when: { 'dmn.workOrderPriority': 'critical' },
        connectorKey: 'n8n-coldchain-orchestrator',
        method: 'POST',
        body: {
          eventType: '{{type}}',
          deviceKey: '{{data.deviceKey}}',
          workOrderId: '{{steps.0.id}}',
          priority: '{{dmn.workOrderPriority}}',
          assignedRole: '{{dmn.assignedRole}}',
          slaHours: '{{dmn.slaHours}}',
        },
      },
    ],
  },
  {
    blueprintKey: 'auto_mkt_quarantine_response',
    ruleKey: 'auto_mkt_quarantine_response',
    name: 'Cách ly Lô Vắc-xin vượt MKT & Đồng bộ Đối tác (4 bước)',
    description:
      'Tự động mở hồ sơ sự cố khi lô vắc-xin bị hold MKT, chạy AI Triage gắn với hồ sơ sự cố, rẽ nhánh cấp Giám đốc Chất lượng sang n8n và thông báo ldx_manager.',
    category: 'wms',
    triggerEventType: 'lot.held_mkt',
    filterJson: null,
    dmnTableKey: 'cold_chain_approval_v1',
    cooldownSec: 60,
    maxDepth: 8,
    active: true,
    sampleEvent: {
      type: 'lot.held_mkt',
      source: 'dxos-studio:wms',
      subject: 'LOT-VAX-01',
      data: {
        lotCode: 'LOT-VAX-01',
        sku: 'SKU-VAX-MKT-28',
        mktCelsius: 10.4,
        maxTempC: 11.2,
        thresholdCelsius: 8.0,
        lotStatus: 'hold_mkt',
        severity: 'high',
        assetEntityId: 'lot:LOT-VAX-01',
        totalAmountM: 650,
      },
    },
    actionsJson: [
      {
        type: 'create_record',
        label: 'Mở hồ sơ sự cố cách ly MKT',
        branchLabel: null,
        when: null,
        collection: 'latticeIncidentCases',
        values: {
          code: 'MKT-{{id}}',
          name: 'Cách ly lô vượt MKT: {{data.lotCode}}',
          runId: 'mkt-{{id}}',
          assetEntityId: 'lot:{{data.lotCode}}',
          handlerId: 'ldx_manager',
          severity: 'critical',
          status: 'open',
          proposal:
            'Lô {{data.lotCode}} có MKT={{data.mktCelsius}}°C vượt ngưỡng {{data.thresholdCelsius}}°C (cấp duyệt: {{dmn.approvalTier}}).',
        },
      },
      {
        type: 'trigger_ai_triage',
        label: 'AI Triage đánh giá hồ sơ cách ly',
        branchLabel: null,
        when: null,
        targetCollection: 'latticeIncidentCases',
        targetRecordId: '{{steps.0.id}}',
        severity: 'high',
        recommendation:
          'Đánh giá sai lệch MKT cho lô {{data.lotCode}} ({{data.mktCelsius}}°C) gắn với sự cố #{{steps.0.id}}, phê duyệt cấp {{dmn.approvalTier}} trong {{dmn.slaMinutes}} phút.',
      },
      {
        type: 'call_connector',
        label: 'Đồng bộ n8n Giám đốc Chất lượng',
        branchLabel: 'Cấp Giám đốc Chất lượng',
        when: { 'dmn.approvalTier': 'quality_hold_director' },
        connectorKey: 'n8n-coldchain-orchestrator',
        method: 'POST',
        body: {
          eventType: '{{type}}',
          lotCode: '{{data.lotCode}}',
          mktCelsius: '{{data.mktCelsius}}',
          incidentId: '{{steps.0.id}}',
          approvalTier: '{{dmn.approvalTier}}',
          slaMinutes: '{{dmn.slaMinutes}}',
        },
      },
      {
        type: 'notify_role',
        label: 'Thông báo Quản lý Chuỗi lạnh',
        branchLabel: null,
        when: null,
        role: 'ldx_manager',
        category: 'wms',
        severity: 'critical',
        title: 'Cách ly lô MKT: {{data.lotCode}} ({{dmn.approvalTier}})',
        body: 'Đã mở hồ sơ sự cố #{{steps.0.id}} cho lô {{data.lotCode}} (MKT {{data.mktCelsius}}°C).',
        targetCollection: 'latticeIncidentCases',
        targetRecordId: '{{steps.0.id}}',
        targetPath: '/p/wms',
      },
    ],
  },
  {
    blueprintKey: 'auto_sla_breach_escalation',
    ruleKey: 'auto_sla_breach_escalation',
    name: 'Leo thang Cảnh báo & Vi phạm SLA (3 bước rẽ nhánh)',
    description:
      'Phân nhánh theo sla.warning (nhắc ldx_dispatcher) và sla.breached (tạo phiếu dịch vụ khẩn trên latticeServiceTickets và leo thang ldx_manager).',
    category: 'sla',
    triggerEventType: 'sla.warning,sla.breached',
    filterJson: null,
    dmnTableKey: null,
    cooldownSec: 120,
    maxDepth: 8,
    active: true,
    sampleEvent: {
      type: 'sla.breached',
      source: 'dxos-sla',
      subject: 'TKT-001',
      data: {
        targetCollection: 'latticeServiceTickets',
        recordId: 15,
        code: 'TKT-001',
        priority: 'urgent',
        overdueMinutes: 30,
        remainingMinutes: 0,
      },
    },
    actionsJson: [
      {
        type: 'notify_role',
        label: 'Nhắc điều phối viên sắp trễ SLA',
        branchLabel: 'Khi sla.warning',
        when: { 'event.type': 'sla.warning' },
        role: 'ldx_dispatcher',
        category: 'sla',
        severity: 'warning',
        title: 'Cảnh báo sắp chạm ngưỡng SLA ({{data.code}})',
        body: 'Bản ghi {{data.targetCollection}} #{{data.recordId}} còn {{data.remainingMinutes}} phút trước hạn SLA.',
        targetCollection: '{{data.targetCollection}}',
        targetRecordId: '{{data.recordId}}',
        targetPath: '/p/services',
      },
      {
        type: 'create_record',
        label: 'Tạo phiếu xử lý vi phạm SLA',
        branchLabel: 'Khi sla.breached',
        when: { 'event.type': 'sla.breached' },
        collection: 'latticeServiceTickets',
        values: {
          code: 'SLA-{{id}}',
          name: 'Vi phạm SLA: {{data.code}}',
          serviceType: 'facilities',
          priority: 'high',
          description: 'Quá hạn SLA {{data.overdueMinutes}} phút trên {{data.targetCollection}} #{{data.recordId}}.',
        },
      },
      {
        type: 'notify_role',
        label: 'Leo thang Quản lý khi vi phạm SLA',
        branchLabel: 'Khi sla.breached',
        when: { 'event.type': 'sla.breached' },
        role: 'ldx_manager',
        category: 'sla',
        severity: 'critical',
        title: 'Leo thang SLA quá hạn: {{data.code}}',
        body: 'Đã tạo phiếu khẩn #{{steps.1.id}} do quá hạn SLA trên {{data.targetCollection}} #{{data.recordId}}.',
        targetCollection: 'latticeServiceTickets',
        targetRecordId: '{{steps.1.id}}',
        targetPath: '/p/services',
      },
    ],
  },
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function toPlainSafe(row) {
  if (!row) return null;
  if (typeof row.toJSON === 'function') return row.toJSON();
  return { ...row };
}

function cloneSafe(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => cloneSafe(item, seen));
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const key of Object.keys(value)) {
    if (BLOCKED_PROTO_KEYS.has(key)) continue;
    out[key] = cloneSafe(value[key], seen);
  }
  return out;
}

function isCatalogSafeCollection(collectionName) {
  const name = String(collectionName || '').trim();
  if (!name) return false;
  if (FORBIDDEN_SYSTEM_COLLECTIONS.has(name)) return false;
  if (ALLOWLISTED_BUSINESS_COLLECTIONS.has(name)) return true;
  return CUSTOM_COLLECTION_RE.test(name);
}

function normalizeFieldDescriptor(rawField) {
  if (!rawField || typeof rawField !== 'object') return null;
  const name = String(val(rawField, 'name') || '').trim();
  if (!name || BLOCKED_PROTO_KEYS.has(name) || SENSITIVE_FIELD_RE.test(name)) return null;
  const type = String(val(rawField, 'type') || 'string').trim();
  const uiSchema = val(rawField, 'uiSchema');
  const title = String(val(rawField, 'title') || uiSchema?.title || name).trim();
  const rawEnum = Array.isArray(val(rawField, 'enumValues'))
    ? val(rawField, 'enumValues')
    : Array.isArray(uiSchema?.enum)
      ? uiSchema.enum.map((e) => (e && typeof e === 'object' ? (e.value ?? e.label) : e))
      : null;
  const enumValues = Array.isArray(rawEnum)
    ? [...new Set(rawEnum.map((v) => String(v ?? '').trim()).filter(Boolean))].slice(0, 50)
    : undefined;
  return {
    name,
    type,
    title,
    ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
  };
}

function collectDynamicFields(rawCollection, fieldsRepoRows) {
  const byName = new Map();
  const addField = (f) => {
    const desc = normalizeFieldDescriptor(f);
    if (!desc) return;
    byName.set(desc.name, desc);
  };

  if (Array.isArray(fieldsRepoRows)) {
    for (const row of fieldsRepoRows) addField(toPlainSafe(row));
  }
  const colFields = rawCollection?.fields;
  if (colFields instanceof Map) {
    for (const f of colFields.values()) addField(f);
  } else if (Array.isArray(colFields)) {
    for (const f of colFields) addField(f);
  }
  return [...byName.values()];
}

async function safeRepoFind(db, repoName, args) {
  try {
    const repo = db?.getRepository?.(repoName);
    if (!repo || typeof repo.find !== 'function') return [];
    const rows = await repo.find(args);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Builds tenant-scoped non-secret metadata catalog for the Visual Automation Studio and AI Copilot.
 */
async function buildAutomationBuilderCatalog(db, organizationId) {
  const orgId = String(organizationId || '').trim();

  const dmnRows = orgId
    ? await safeRepoFind(db, 'latticeDecisionTables', { filter: { organizationId: orgId }, limit: 200 })
    : [];
  const dmnTables = dmnRows
    .map(toPlainSafe)
    .filter((row) => row && (!orgId || row.organizationId === orgId) && row.active !== false)
    .map((row) => ({
      key: String(row.tableKey || ''),
      tableKey: String(row.tableKey || ''),
      name: String(row.name || row.tableKey || ''),
      description: row.description ? String(row.description) : null,
      hitPolicy: String(row.hitPolicy || 'FIRST'),
      version: Number(row.version) || 1,
      inputsJson: Array.isArray(row.inputsJson) ? cloneSafe(row.inputsJson) : [],
      outputsJson: Array.isArray(row.outputsJson) ? cloneSafe(row.outputsJson) : [],
    }));

  const connRows = orgId
    ? await safeRepoFind(db, 'latticeConnectors', { filter: { organizationId: orgId }, limit: 200 })
    : [];
  const connectors = connRows
    .map(toPlainSafe)
    .filter((row) => row && (!orgId || row.organizationId === orgId) && row.active !== false)
    .map((row) => ({
      connectorKey: String(row.connectorKey || ''),
      name: String(row.name || row.connectorKey || ''),
      connectorType: String(row.connectorType || 'http_api'),
      baseUrl: row.baseUrl ? String(row.baseUrl) : null,
      authType: String(row.authType || 'none'),
      lastTestStatus: row.lastTestStatus ? String(row.lastTestStatus) : null,
    }));

  const colMetaMap = new Map();
  for (const name of ALLOWLISTED_BUSINESS_COLLECTIONS) {
    const def = DEFAULT_COLLECTION_SCHEMAS[name];
    colMetaMap.set(name, {
      name,
      title: def?.title || name,
      isCustom: false,
      fields: cloneSafe(def?.fields || []),
    });
  }

  const colRepoRows = await safeRepoFind(db, 'collections', { limit: 500 });
  const fieldRepoRows = await safeRepoFind(db, 'fields', { limit: 1000 });
  const fieldsByCollection = new Map();
  for (const rawRow of fieldRepoRows) {
    const row = toPlainSafe(rawRow);
    const cName = String(row?.collectionName || '').trim();
    if (!cName) continue;
    if (!fieldsByCollection.has(cName)) fieldsByCollection.set(cName, []);
    fieldsByCollection.get(cName).push(row);
  }

  for (const rawCol of colRepoRows) {
    const row = toPlainSafe(rawCol);
    const name = String(row?.name || '').trim();
    if (!isCatalogSafeCollection(name)) continue;
    const fallbackDef = DEFAULT_COLLECTION_SCHEMAS[name];
    const dbCol = typeof db?.getCollection === 'function' ? db.getCollection(name) : null;
    const dynamicFields = collectDynamicFields(dbCol || row, fieldsByCollection.get(name));
    colMetaMap.set(name, {
      name,
      title: String(row?.title || fallbackDef?.title || name),
      isCustom: CUSTOM_COLLECTION_RE.test(name),
      fields: dynamicFields.length > 0 ? dynamicFields : cloneSafe(fallbackDef?.fields || []),
    });
  }

  if (db?.collections && typeof db.collections.entries === 'function') {
    for (const [rawName, colObj] of db.collections.entries()) {
      const name = String(rawName || '').trim();
      if (!isCatalogSafeCollection(name)) continue;
      const prev = colMetaMap.get(name);
      const fallbackDef = DEFAULT_COLLECTION_SCHEMAS[name];
      const dynamicFields = collectDynamicFields(colObj, fieldsByCollection.get(name));
      colMetaMap.set(name, {
        name,
        title: String(colObj?.title || prev?.title || fallbackDef?.title || name),
        isCustom: CUSTOM_COLLECTION_RE.test(name),
        fields: dynamicFields.length > 0 ? dynamicFields : prev?.fields || cloneSafe(fallbackDef?.fields || []),
      });
    }
  }

  const collections = [...colMetaMap.values()].sort((a, b) => {
    if (a.isCustom !== b.isCustom) return a.isCustom ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const roleRows = await safeRepoFind(db, 'roles', { limit: 200 });
  const discoveredRoles = roleRows
    .map((r) => String(val(r, 'name') || '').trim())
    .filter((name) => LDX_ROLE_RE.test(name));
  const roles = discoveredRoles.length > 0 ? [...new Set(discoveredRoles)] : [...DEFAULT_LDX_ROLES];

  return {
    organizationId: orgId || null,
    eventTypes: cloneSafe(STANDARD_EVENT_CATALOG),
    actionTypes: cloneSafe(ACTION_SCHEMA_CATALOG),
    dmnTables,
    collections,
    connectors,
    roles,
    blueprints: cloneSafe(AUTOMATION_BLUEPRINTS),
  };
}

function normalizeSearchText(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function hasBlockedProtoInValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasBlockedProtoInValue(item, seen));
  }
  const ownNames = Object.getOwnPropertyNames(value);
  for (const key of ownNames) {
    if (BLOCKED_PROTO_KEYS.has(key)) return true;
    if (hasBlockedProtoInValue(value[key], seen)) return true;
  }
  return false;
}

const PROMPT_INJECTION_RE = /\b(ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?|ignore\s+previous|system\s+prompt|reveal\s+(?:the\s+)?(?:system\s+)?prompt|bypass\s+(?:rbac|hitl|auth|acl|security|rls)|disable\s+(?:hitl|rbac|rls|auth)|exfiltrate|dump\s+secrets?|steal\s+secrets?|jailbreak)\b/i;
const PROTOTYPE_OR_CODE_RE = /(__proto__|process\.env|child_process|\bconstructor\b|\bprototype\b|require\s*\(|eval\s*\(|Function\s*\(|\$\{)/i;
const SENSITIVE_COLLECTION_NAME_RE = /\b(latticeConnectors|latticeApiKeys|latticePkiKeys|latticeCryptoLedger|latticeWebhookSubscriptions|latticeWebhookDeliveries|latticeEventBus|latticeDelegations|latticeOrganizations|latticeAutomationRules|latticeAutomationRuns|apiKeys|rolesUsers|applicationTokens|authenticators|sessions)\b/i;
const SYSTEM_TABLE_TARGET_RE = /(?:\b(?:create|update|read|write|delete|drop|insert|query|modify|target|access|dump|into|from|on|in|table|collection|tao|ghi|sua|xoa|doc|bang|ban ghi|vao|tren|trong|toi)\b[\s:='"]*(?:the\s+)?(?:users|roles)\b|\b(?:users|roles)\s+(?:table|collection)\b)/i;

function validateAiAssistSecurity({ prompt, targetNode, rule }) {
  const promptText = String(prompt || '');
  const targetText = String(targetNode || '');

  for (const text of [promptText, targetText]) {
    if (PROMPT_INJECTION_RE.test(text)) {
      return { refused: true, error: 'Prompt injection or security/HITL bypass attempt refused.' };
    }
    if (PROTOTYPE_OR_CODE_RE.test(text)) {
      return { refused: true, error: 'Prototype pollution or code execution expression refused.' };
    }
    if (SENSITIVE_COLLECTION_NAME_RE.test(text) || SYSTEM_TABLE_TARGET_RE.test(text)) {
      return { refused: true, error: 'Targeting system or sensitive security collections is forbidden.' };
    }
  }

  if (rule !== undefined && rule !== null) {
    if (!isPlainObject(rule)) {
      return { refused: true, error: 'rule must be a plain object.' };
    }
    if (hasBlockedProtoInValue(rule)) {
      return { refused: true, error: 'rule contains forbidden prototype key.' };
    }
    const actions = Array.isArray(rule.actionsJson) ? rule.actionsJson : [];
    for (const act of actions) {
      const col = String(act?.collection || act?.targetCollection || '').trim();
      if (col && !isCatalogSafeCollection(col)) {
        return { refused: true, error: `Target collection "${col}" is forbidden.` };
      }
    }
  }
  return { refused: false };
}

function getBlueprintByKey(key) {
  const found = AUTOMATION_BLUEPRINTS.find((b) => b.blueprintKey === key || b.ruleKey === key);
  return found ? cloneSafe(found) : null;
}

function findMatchingConnector(catalog, preferredKey, promptNorm) {
  const list = Array.isArray(catalog?.connectors) ? catalog.connectors : [];
  if (!list.length) return null;
  if (promptNorm) {
    const byKeyInPrompt = list.find((c) => c.connectorKey && promptNorm.includes(c.connectorKey.toLowerCase()));
    if (byKeyInPrompt) return byKeyInPrompt.connectorKey;
  }
  if (preferredKey && list.some((c) => c.connectorKey === preferredKey)) return preferredKey;
  const preferred = list.find((c) => ['n8n', 'webhook', 'http_api'].includes(c.connectorType));
  return (preferred || list[0]).connectorKey;
}

function findMatchingDmnTable(catalog, preferredKey, promptNorm) {
  const list = Array.isArray(catalog?.dmnTables) ? catalog.dmnTables : [];
  if (!list.length) return null;
  if (promptNorm) {
    const byKey = list.find((t) => {
      const k = String(t.tableKey || t.key || '').toLowerCase();
      return k && promptNorm.includes(k);
    });
    if (byKey) return byKey.tableKey || byKey.key;
  }
  if (preferredKey && list.some((t) => (t.tableKey || t.key) === preferredKey)) return preferredKey;
  return null;
}

function findMatchingCollection(catalog, preferredKey, promptNorm) {
  const list = Array.isArray(catalog?.collections) ? catalog.collections : [];
  if (promptNorm) {
    const byName = list.find((c) => c.name && promptNorm.includes(c.name.toLowerCase()));
    if (byName) return byName.name;
  }
  if (preferredKey && list.some((c) => c.name === preferredKey)) return preferredKey;
  if (preferredKey && isCatalogSafeCollection(preferredKey)) return preferredKey;
  return list[0]?.name || 'latticeServiceTickets';
}

function extractTemperature(promptNorm, rawPrompt) {
  const m = String(rawPrompt || '').match(/(-?\d+(?:[.,]\d+)?)\s*(?:°\s*C|do\s*c|độ\s*c|độ|do\b|celsius|\bC\b)/i);
  if (m) {
    const valNum = Number(m[1].replace(',', '.'));
    if (Number.isFinite(valNum) && valNum >= -80 && valNum <= 120) return valNum;
  }
  const mTarget = promptNorm.match(/(?:targettempc|nhiet do muc tieu|nhiet do|temperature|temp)\s*(?:la|thanh|=|:|to)?\s*(-?\d+(?:[.,]\d+)?)/i);
  if (mTarget) {
    const valNum = Number(mTarget[1].replace(',', '.'));
    if (Number.isFinite(valNum) && valNum >= -80 && valNum <= 120) return valNum;
  }
  return null;
}

function extractCooldownSec(promptNorm) {
  const m = promptNorm.match(/(?:cooldown|cho chong lap|chong lap)\s*(?:la|thanh|=|:)?\s*(\d+)\s*(?:s|sec|giay)?/i);
  if (m) {
    const sec = Number(m[1]);
    if (Number.isInteger(sec) && sec >= 0 && sec <= 86400) return sec;
  }
  return null;
}

function extractRoleFromPrompt(promptNorm, catalog) {
  const validRoles = Array.isArray(catalog?.roles) && catalog.roles.length ? catalog.roles : DEFAULT_LDX_ROLES;
  for (const r of validRoles) {
    if (promptNorm.includes(r.toLowerCase())) return r;
  }
  if (/giam doc|quan ly|manager/.test(promptNorm)) return 'ldx_manager';
  if (/dieu phoi|dispatcher/.test(promptNorm)) return 'ldx_dispatcher';
  if (/kho|warehouse/.test(promptNorm)) return 'ldx_warehouse';
  if (/tai xe|driver/.test(promptNorm)) return 'ldx_driver';
  if (/van hanh|ky thuat|operator/.test(promptNorm)) return 'ldx_operator';
  if (/quan tri|admin/.test(promptNorm)) return 'ldx_admin';
  return null;
}

function extractFilterFromPrompt(promptNorm, rawPrompt) {
  const mTemp = String(rawPrompt || '').match(/(?:nhiet do|temp(?:erature)?|mkt(?:celsius)?)\s*(>=|>|<=|<|=)\s*(-?\d+(?:[.,]\d+)?)/i);
  if (mTemp) {
    const opMap = { '>=': '$gte', '>': '$gt', '<=': '$lte', '<': '$lt', '=': '$eq' };
    const op = opMap[mTemp[1]];
    const num = Number(mTemp[2].replace(',', '.'));
    if (op && Number.isFinite(num)) {
      const field = /mkt/.test(promptNorm) ? 'mktCelsius' : 'temperature';
      return { [field]: op === '$eq' ? num : { [op]: num } };
    }
  }
  if (/chi\s+khi\s+(?:muc\s+do\s+)?critical|only\s+(?:when\s+)?critical|severity\s*=\s*critical/.test(promptNorm)) {
    return { severity: 'critical' };
  }
  return null;
}

function resolveSampleEventForRule(rule, catalog) {
  const events = Array.isArray(catalog?.eventTypes) && catalog.eventTypes.length ? catalog.eventTypes : STANDARD_EVENT_CATALOG;
  const trigger = String(rule?.triggerEventType || 'manual.trigger');
  const firstEventType = trigger.split(',')[0].trim();
  const matched = events.find((e) => e.type === firstEventType || (firstEventType.endsWith('.*') && e.type.startsWith(firstEventType.slice(0, -1))));
  if (matched?.sampleEvent) return cloneSafe(matched.sampleEvent);
  const bp = AUTOMATION_BLUEPRINTS.find((b) => b.ruleKey === rule?.ruleKey);
  if (bp?.sampleEvent) return cloneSafe(bp.sampleEvent);
  return cloneSafe(events[0].sampleEvent);
}

function makeSlugRuleKey(prefix, rawPrompt) {
  const base = normalizeSearchText(rawPrompt)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28);
  const hash = crypto.createHash('sha256').update(String(rawPrompt || prefix)).digest('hex').slice(0, 6);
  const candidate = `${prefix}_${base || 'rule'}_${hash}`.slice(0, 60).replace(/_+$/, '');
  return /^[a-z0-9][a-z0-9_-]{1,62}$/.test(candidate) ? candidate : `auto_copilot_${hash}`;
}

function buildSuggestionsForRule(rule, catalog) {
  const r = isPlainObject(rule) ? cloneSafe(rule) : {
    ruleKey: 'draft_rule',
    name: 'Draft Automation Rule',
    triggerEventType: '*',
    filterJson: null,
    dmnTableKey: null,
    cooldownSec: 0,
    maxDepth: 8,
    active: true,
    actionsJson: [],
  };
  const actions = Array.isArray(r.actionsJson) ? r.actionsJson : [];
  const trigger = String(r.triggerEventType || '*');
  const suggestions = [];

  if (!Number.isInteger(Number(r.cooldownSec)) || Number(r.cooldownSec) <= 0) {
    const previewRule = cloneSafe(r);
    previewRule.cooldownSec = 60;
    suggestions.push({
      id: 'add_cooldown_guard',
      title: 'Bật cooldown 60 giây chống bão sự kiện',
      reason: 'cooldownSec đang bằng 0; đặt 60s giúp tránh kích hoạt dồn dập khi cảm biến nhấp nháy ngưỡng.',
      severity: 'warning',
      targetNode: 'trigger',
      patch: { cooldownSec: 60 },
      previewRule,
    });
  }

  if ((trigger === '*' || trigger.includes('*')) && !r.filterJson) {
    const previewRule = cloneSafe(r);
    previewRule.triggerEventType = 'alarm.triggered,device.offline';
    previewRule.filterJson = { severity: { $in: ['high', 'critical'] } };
    suggestions.push({
      id: 'narrow_broad_trigger',
      title: 'Thu hẹp trigger diện rộng bằng bộ lọc severity',
      reason: 'Rule đang lắng nghe wildcard mà chưa có filterJson; nên giới hạn sự kiện hoặc thêm điều kiện lọc để tránh chạy thừa.',
      severity: 'warning',
      targetNode: 'filter',
      patch: { triggerEventType: previewRule.triggerEventType, filterJson: previewRule.filterJson },
      previewRule,
    });
  }

  const dmnKey = r.dmnTableKey ? String(r.dmnTableKey).trim() : '';
  const dmnMeta = dmnKey && Array.isArray(catalog?.dmnTables)
    ? catalog.dmnTables.find((t) => (t.tableKey || t.key) === dmnKey)
    : null;
  if (dmnMeta && Array.isArray(dmnMeta.outputsJson) && dmnMeta.outputsJson.length > 0) {
    const serializedActions = JSON.stringify(actions);
    const unusedOutputs = dmnMeta.outputsJson
      .map((o) => String(o?.name || '').trim())
      .filter((outName) => outName && !serializedActions.includes(`dmn.${outName}`));
    if (unusedOutputs.length > 0 && actions.length > 0) {
      const previewRule = cloneSafe(r);
      const firstOut = unusedOutputs[0];
      const notifyIdx = previewRule.actionsJson.findIndex((a) => a.type === 'notify_role');
      if (notifyIdx >= 0) {
        previewRule.actionsJson[notifyIdx].title = `${previewRule.actionsJson[notifyIdx].title || 'Thông báo'} ({{dmn.${firstOut}}})`;
      } else {
        previewRule.actionsJson.push({
          type: 'notify_role',
          label: 'Thông báo kèm đầu ra DMN',
          when: null,
          role: 'ldx_manager',
          severity: 'warning',
          title: `Kết quả DMN ${dmnKey}: {{dmn.${firstOut}}}`,
          body: `Sự kiện {{type}} đã khớp bảng DMN ${dmnKey}.`,
        });
      }
      suggestions.push({
        id: 'use_dmn_outputs',
        title: `Tận dụng đầu ra DMN chưa dùng (${unusedOutputs.join(', ')})`,
        reason: `Bảng ${dmnKey} trả về ${unusedOutputs.join(', ')} nhưng các bước action chưa tham chiếu {{dmn.*}}.`,
        severity: 'info',
        targetNode: notifyIdx >= 0 ? `step:${notifyIdx}` : 'dmn',
        patch: { unusedOutputs },
        previewRule,
      });
    }
  }

  const isColdChainContext = /alarm|device\.offline|telemetry|lot\.held_mkt|cold|cmms|freezer|mkt/i.test(
    `${trigger} ${r.ruleKey || ''} ${r.name || ''} ${dmnKey} ${JSON.stringify(actions)}`,
  );

  if (isColdChainContext && !actions.some((a) => a.type === 'twin_set_desired')) {
    const previewRule = cloneSafe(r);
    const whenCond = dmnKey === 'cmms_priority_routing_v1' ? { 'dmn.workOrderPriority': 'critical' } : { 'data.severity': 'critical' };
    previewRule.actionsJson.push({
      type: 'twin_set_desired',
      label: 'Hạ nhiệt khẩn Digital Twin (HITL)',
      branchLabel: 'Khi ưu tiên = critical',
      when: whenCond,
      assetId: '{{data.assetId}}',
      assetEntityId: '{{data.assetEntityId}}',
      desiredPatch: { targetTempC: 4.0, fanMode: 'high' },
    });
    suggestions.push({
      id: 'add_twin_hitl_step',
      title: 'Thêm bước hạ nhiệt khẩn Digital Twin (HITL)',
      reason: 'Luồng chuỗi lạnh nên có bước twin_set_desired tự động đề xuất targetTempC = 4°C có cổng phê duyệt HITL.',
      severity: 'info',
      targetNode: `step:${actions.length}`,
      patch: { addActionType: 'twin_set_desired' },
      previewRule,
    });
  }

  if (isColdChainContext && !actions.some((a) => a.type === 'trigger_ai_triage')) {
    const previewRule = cloneSafe(r);
    const hasStep0 = actions.length > 0;
    const targetCol = actions[0]?.collection || 'latticeCustomWorkOrders';
    previewRule.actionsJson.push({
      type: 'trigger_ai_triage',
      label: 'Phân tích sự cố bằng AI Triage',
      branchLabel: 'Khi ưu tiên = critical',
      when: dmnKey === 'cmms_priority_routing_v1' ? { 'dmn.workOrderPriority': 'critical' } : { 'data.severity': 'critical' },
      targetCollection: targetCol,
      targetRecordId: hasStep0 ? '{{steps.0.id}}' : '{{data.assetId}}',
      severity: 'critical',
      recommendation: `Phân tích AI Triage tự động cho sự cố {{type}} trên {{data.deviceKey}}.`,
    });
    suggestions.push({
      id: 'add_ai_triage_step',
      title: 'Bổ sung bước AI Triage gắn với bản ghi vừa tạo',
      reason: 'trigger_ai_triage tạo đề xuất xử lý sự cố kèm chứng cứ DMN và ngữ cảnh telemetry.',
      severity: 'info',
      targetNode: `step:${actions.length}`,
      patch: { addActionType: 'trigger_ai_triage' },
      previewRule,
    });
  }

  const availableConnector = findMatchingConnector(catalog, 'n8n-coldchain-orchestrator', '');
  if (isColdChainContext && availableConnector && !actions.some((a) => a.type === 'call_connector')) {
    const previewRule = cloneSafe(r);
    previewRule.actionsJson.push({
      type: 'call_connector',
      label: `Đẩy điều phối sang ${availableConnector}`,
      branchLabel: 'Khi ưu tiên = critical',
      when: dmnKey === 'cmms_priority_routing_v1' ? { 'dmn.workOrderPriority': 'critical' } : { 'data.severity': 'critical' },
      connectorKey: availableConnector,
      method: 'POST',
      body: {
        eventType: '{{type}}',
        deviceKey: '{{data.deviceKey}}',
        ...(actions.length > 0 ? { recordId: '{{steps.0.id}}' } : {}),
      },
    });
    suggestions.push({
      id: 'add_vault_connector_step',
      title: `Kết nối Vault Connector "${availableConnector}"`,
      reason: `Hệ thống đã cấu hình connector ${availableConnector}; có thể gọi sang n8n/webhook kèm chữ ký HMAC.`,
      severity: 'info',
      targetNode: `step:${actions.length}`,
      patch: { connectorKey: availableConnector },
      previewRule,
    });
  }

  const hasAnyBranch = actions.some((a) => isPlainObject(a.when) && Object.keys(a.when).length > 0);
  if (actions.length >= 2 && !hasAnyBranch) {
    const highImpactIdx = actions.findIndex((a) => ['twin_set_desired', 'call_connector', 'trigger_ai_triage'].includes(a.type));
    const idxToBranch = highImpactIdx >= 0 ? highImpactIdx : actions.length - 1;
    const previewRule = cloneSafe(r);
    const branchCond = dmnKey === 'cmms_priority_routing_v1'
      ? { 'dmn.workOrderPriority': 'critical' }
      : dmnKey === 'cold_chain_approval_v1'
        ? { 'dmn.approvalTier': 'quality_hold_director' }
        : { 'data.severity': 'critical' };
    previewRule.actionsJson[idxToBranch].when = branchCond;
    previewRule.actionsJson[idxToBranch].branchLabel = 'Nhánh khẩn cấp';
    suggestions.push({
      id: 'add_conditional_branch',
      title: `Thêm điều kiện rẽ nhánh (when) cho bước #${idxToBranch}`,
      reason: 'Tách hành động tác động mạnh vào nhánh có điều kiện (critical) giúp các cảnh báo nhẹ không kích hoạt nhầm.',
      severity: 'info',
      targetNode: `step:${idxToBranch}`,
      patch: { when: branchCond, branchLabel: 'Nhánh khẩn cấp' },
      previewRule,
    });
  }

  return suggestions;
}

function synthesizeFullRule({ prompt, rule, catalog }) {
  const promptNorm = normalizeSearchText(prompt);
  const existingRule = isPlainObject(rule) ? cloneSafe(rule) : {};

  let baseBlueprint = null;
  if (/\bmkt\b|cach ly|quarantine|vac-?xin|vaccine|lot\.held_mkt/.test(promptNorm)) {
    baseBlueprint = getBlueprintByKey('auto_mkt_quarantine_response');
  } else if (/\bsla\b|qua han|tre han|breach|leo thang sla|sla\.warning|sla\.breached/.test(promptNorm)) {
    baseBlueprint = getBlueprintByKey('auto_sla_breach_escalation');
  } else if (/chuoi lanh|cold.?chain|kho lanh|cmms|bao tri|work.?order|ha nhiet|alarm\.triggered|device\.offline|telemetry\.alarm/.test(promptNorm)) {
    baseBlueprint = getBlueprintByKey('auto_cmms_on_coldchain_fault');
  }

  let draftRule;
  if (baseBlueprint) {
    draftRule = {
      ruleKey: existingRule.ruleKey || makeSlugRuleKey(baseBlueprint.ruleKey.split('_').slice(0, 2).join('_'), prompt),
      name: baseBlueprint.name,
      description: `Sinh bởi AI Copilot từ yêu cầu: ${String(prompt).trim().slice(0, 180)}`,
      triggerEventType: baseBlueprint.triggerEventType,
      filterJson: baseBlueprint.filterJson,
      dmnTableKey: findMatchingDmnTable(catalog, baseBlueprint.dmnTableKey, promptNorm) || baseBlueprint.dmnTableKey,
      cooldownSec: baseBlueprint.cooldownSec,
      maxDepth: 8,
      active: true,
      actionsJson: cloneSafe(baseBlueprint.actionsJson),
    };

    if (/telemetry\.alarm/.test(promptNorm)) {
      draftRule.triggerEventType = 'telemetry.alarm';
    } else if (/device\.offline|mat ket noi|lwt/.test(promptNorm) && !/alarm\.triggered/.test(promptNorm)) {
      draftRule.triggerEventType = 'device.offline';
    }
    const matchedCol = findMatchingCollection(catalog, draftRule.actionsJson[0]?.collection, promptNorm);
    if (matchedCol && draftRule.actionsJson[0]?.type === 'create_record') {
      draftRule.actionsJson[0].collection = matchedCol;
    }
    const matchedConn = findMatchingConnector(catalog, null, promptNorm);
    if (matchedConn) {
      for (const act of draftRule.actionsJson) {
        if (act.type === 'call_connector') act.connectorKey = matchedConn;
      }
    }
  } else {
    let triggerEventType = 'manual.trigger';
    if (/epod|ky nhan|ban giao/.test(promptNorm)) triggerEventType = 'epod.signed';
    else if (/voucher.*cancel|huy chung tu/.test(promptNorm)) triggerEventType = 'voucher.cancelled';
    else if (/voucher|trinh duyet|don hang/.test(promptNorm)) triggerEventType = 'voucher.submitted';
    else if (/orion|ngsi/.test(promptNorm)) triggerEventType = 'orion.notification';

    const matchedCol = findMatchingCollection(catalog, 'latticeServiceTickets', promptNorm);
    const matchedDmn = findMatchingDmnTable(catalog, null, promptNorm);
    const matchedRole = extractRoleFromPrompt(promptNorm, catalog) || 'ldx_operator';
    const matchedConn = findMatchingConnector(catalog, null, promptNorm);

    const actionsJson = [];
    if (/tao phieu|create|ticket|workorder|incident|ghi/.test(promptNorm) || matchedCol) {
      const values = matchedCol === 'latticeServiceTickets'
        ? { code: 'AUTO-{{id}}', name: 'Xử lý {{type}}: {{subject}}', serviceType: 'facilities', priority: 'medium' }
        : { code: 'AUTO-{{id}}', title: 'Xử lý {{type}}: {{subject}}', status: 'open' };
      actionsJson.push({
        type: 'create_record',
        label: `Tạo bản ghi trên ${matchedCol}`,
        branchLabel: null,
        when: null,
        collection: matchedCol,
        values,
      });
    }
    actionsJson.push({
      type: 'notify_role',
      label: `Thông báo ${matchedRole}`,
      branchLabel: null,
      when: null,
      role: matchedRole,
      category: 'automation',
      severity: 'warning',
      title: 'Thông báo tự động ({{type}})',
      body: 'Sự kiện {{type}} trên {{subject}} đã được ghi nhận.',
      targetCollection: matchedCol,
    });
    if (/ai|triage|phan tich/.test(promptNorm)) {
      actionsJson.push({
        type: 'trigger_ai_triage',
        label: 'Phân tích sự cố bằng AI Triage',
        branchLabel: 'Khi mức độ critical',
        when: { 'data.severity': 'critical' },
        targetCollection: matchedCol,
        targetRecordId: '{{steps.0.id}}',
        severity: 'high',
        recommendation: 'Phân tích AI Triage tự động cho sự kiện {{type}}.',
      });
    }
    if (matchedConn && /n8n|webhook|dong bo|sync|ket noi|connector/.test(promptNorm)) {
      actionsJson.push({
        type: 'call_connector',
        label: `Gọi connector ${matchedConn}`,
        branchLabel: null,
        when: null,
        connectorKey: matchedConn,
        method: 'POST',
        body: { eventType: '{{type}}', subject: '{{subject}}', data: '{{data}}' },
      });
    }

    draftRule = {
      ruleKey: existingRule.ruleKey || makeSlugRuleKey('auto', prompt),
      name: `Quy trình tự động (${triggerEventType})`,
      description: `Sinh bởi AI Copilot từ yêu cầu: ${String(prompt).trim().slice(0, 180)}`,
      triggerEventType,
      filterJson: null,
      dmnTableKey: matchedDmn,
      cooldownSec: 60,
      maxDepth: 8,
      active: true,
      actionsJson,
    };
  }

  const parsedTemp = extractTemperature(promptNorm, prompt);
  if (parsedTemp !== null) {
    const twinStep = draftRule.actionsJson.find((a) => a.type === 'twin_set_desired');
    if (twinStep) {
      twinStep.desiredPatch = { ...(twinStep.desiredPatch || {}), targetTempC: parsedTemp };
    } else {
      draftRule.actionsJson.push({
        type: 'twin_set_desired',
        label: `Đặt nhiệt độ Digital Twin ${parsedTemp}°C`,
        branchLabel: 'Khi critical',
        when: { 'data.severity': 'critical' },
        assetId: '{{data.assetId}}',
        assetEntityId: '{{data.assetEntityId}}',
        desiredPatch: { targetTempC: parsedTemp, fanMode: 'high' },
      });
    }
  }

  const parsedCooldown = extractCooldownSec(promptNorm);
  if (parsedCooldown !== null) draftRule.cooldownSec = parsedCooldown;

  const parsedFilter = extractFilterFromPrompt(promptNorm, prompt);
  if (parsedFilter) draftRule.filterJson = parsedFilter;

  const diffSummary = [
    `Khởi tạo rule "${draftRule.ruleKey}" cho sự kiện "${draftRule.triggerEventType}" với ${draftRule.actionsJson.length} bước`,
    ...(draftRule.dmnTableKey ? [`Liên kết bảng quyết định DMN "${draftRule.dmnTableKey}"`] : []),
    ...(draftRule.filterJson ? [`Áp dụng bộ lọc điều kiện đầu vào`] : []),
  ];
  const sampleEvent = resolveSampleEventForRule(draftRule, catalog);
  const suggestions = buildSuggestionsForRule(draftRule, catalog);

  return {
    refused: false,
    mode: 'full',
    summary: `Đã dựng quy trình "${draftRule.name}" (${draftRule.actionsJson.length} bước) dựa trên catalog hệ thống.`,
    draftRule,
    sampleEvent,
    diffSummary,
    suggestions,
  };
}

function resolveTargetNode({ targetNode, promptNorm, actions }) {
  const explicit = String(targetNode || '').trim();
  if (explicit) {
    if (/^(?:trigger|filter|dmn)$/i.test(explicit)) return explicit.toLowerCase();
    if (/^step:\d+$/i.test(explicit)) return explicit.toLowerCase();
    if (/^\d+$/.test(explicit)) return `step:${explicit}`;
  }

  const stepNumMatch = promptNorm.match(/(?:buoc|step)\s*#?\s*(\d+)/i);
  if (stepNumMatch) {
    const rawIdx = Number(stepNumMatch[1]);
    if (Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < actions.length) {
      return `step:${rawIdx}`;
    }
    if (Number.isInteger(rawIdx) && rawIdx >= 1 && rawIdx - 1 < actions.length) {
      return `step:${rawIdx - 1}`;
    }
  }

  if (/them buoc|add step|them hanh dong|bo sung buoc/.test(promptNorm)) return 'step:append';
  if (/nhiet do|ha nhiet|targettempc|setpoint|digital twin|twin/.test(promptNorm)) {
    const idx = actions.findIndex((a) => a.type === 'twin_set_desired');
    return idx >= 0 ? `step:${idx}` : 'step:append';
  }
  if (/n8n|webhook|connector|ket noi/.test(promptNorm)) {
    const idx = actions.findIndex((a) => a.type === 'call_connector');
    return idx >= 0 ? `step:${idx}` : 'step:append';
  }
  if (/ai triage|triage|phan tich/.test(promptNorm)) {
    const idx = actions.findIndex((a) => a.type === 'trigger_ai_triage');
    return idx >= 0 ? `step:${idx}` : 'step:append';
  }
  if (/thong bao|notify|vai tro/.test(promptNorm)) {
    const idx = actions.findIndex((a) => a.type === 'notify_role');
    return idx >= 0 ? `step:${idx}` : 'step:append';
  }
  if (/tao phieu|tao ban ghi|create_record/.test(promptNorm)) {
    const idx = actions.findIndex((a) => a.type === 'create_record');
    return idx >= 0 ? `step:${idx}` : 'step:append';
  }
  if (/dmn|bang quyet dinh|decision table/.test(promptNorm)) return 'dmn';
  if (/bo loc|dieu kien loc|filter/.test(promptNorm)) return 'filter';
  if (/cooldown|trigger|su kien|maxdepth|do sau/.test(promptNorm)) return 'trigger';
  return actions.length > 0 ? 'step:0' : 'trigger';
}

function patchTargetNode({ prompt, rule, targetNode, catalog }) {
  const draftRule = cloneSafe(
    isPlainObject(rule)
      ? rule
      : {
          ruleKey: 'copilot_draft_rule',
          name: 'Automation Rule',
          triggerEventType: 'alarm.triggered',
          filterJson: null,
          dmnTableKey: null,
          cooldownSec: 60,
          maxDepth: 8,
          active: true,
          actionsJson: [],
        },
  );
  if (!Array.isArray(draftRule.actionsJson)) draftRule.actionsJson = [];

  const promptNorm = normalizeSearchText(prompt);
  const resolvedTarget = resolveTargetNode({ targetNode, promptNorm, actions: draftRule.actionsJson });
  const diffSummary = [];
  let patch = { targetNode: resolvedTarget };

  if (resolvedTarget === 'trigger') {
    const nextCooldown = extractCooldownSec(promptNorm);
    if (nextCooldown !== null) {
      draftRule.cooldownSec = nextCooldown;
      patch.cooldownSec = nextCooldown;
      diffSummary.push(`Cập nhật cooldownSec = ${nextCooldown}s`);
    }
    const events = (Array.isArray(catalog?.eventTypes) ? catalog.eventTypes : STANDARD_EVENT_CATALOG).map((e) => e.type);
    const matchedEvents = events.filter((ev) => promptNorm.includes(ev.toLowerCase()));
    if (matchedEvents.length > 0) {
      draftRule.triggerEventType = matchedEvents.join(',');
      patch.triggerEventType = draftRule.triggerEventType;
      diffSummary.push(`Cập nhật triggerEventType = ${draftRule.triggerEventType}`);
    }
    const depthMatch = promptNorm.match(/maxdepth\s*(?:=|la|thanh)?\s*(\d+)/i);
    if (depthMatch) {
      const d = Math.min(8, Math.max(1, Number(depthMatch[1])));
      draftRule.maxDepth = d;
      patch.maxDepth = d;
      diffSummary.push(`Cập nhật maxDepth = ${d}`);
    }
  } else if (resolvedTarget === 'filter') {
    if (/xoa bo loc|bo bo loc|clear filter|remove filter|bo loc rong/.test(promptNorm)) {
      draftRule.filterJson = null;
      patch.filterJson = null;
      diffSummary.push('Đã xóa filterJson');
    } else {
      const nextFilter = extractFilterFromPrompt(promptNorm, prompt) || { severity: 'critical' };
      draftRule.filterJson = nextFilter;
      patch.filterJson = nextFilter;
      diffSummary.push(`Cập nhật filterJson = ${JSON.stringify(nextFilter)}`);
    }
  } else if (resolvedTarget === 'dmn') {
    if (/bo dmn|xoa dmn|remove dmn|clear dmn/.test(promptNorm)) {
      draftRule.dmnTableKey = null;
      patch.dmnTableKey = null;
      diffSummary.push('Đã gỡ liên kết DMN table');
    } else {
      const dmnKey = findMatchingDmnTable(catalog, draftRule.dmnTableKey, promptNorm) || draftRule.dmnTableKey;
      draftRule.dmnTableKey = dmnKey;
      patch.dmnTableKey = dmnKey;
      diffSummary.push(`Cập nhật dmnTableKey = ${dmnKey}`);
    }
  } else if (resolvedTarget === 'step:append') {
    const temp = extractTemperature(promptNorm, prompt);
    const role = extractRoleFromPrompt(promptNorm, catalog);
    const conn = findMatchingConnector(catalog, null, promptNorm);
    let newStep;
    if (temp !== null || /twin|ha nhiet/.test(promptNorm)) {
      newStep = {
        type: 'twin_set_desired',
        label: `Đặt nhiệt độ Digital Twin (${temp ?? 4.0}°C)`,
        branchLabel: null,
        when: null,
        assetId: '{{data.assetId}}',
        assetEntityId: '{{data.assetEntityId}}',
        desiredPatch: { targetTempC: temp ?? 4.0, fanMode: 'high' },
      };
    } else if (/ai|triage/.test(promptNorm)) {
      newStep = {
        type: 'trigger_ai_triage',
        label: 'Phân tích AI Triage',
        branchLabel: null,
        when: null,
        targetCollection: draftRule.actionsJson[0]?.collection || 'latticeCustomWorkOrders',
        targetRecordId: draftRule.actionsJson.length > 0 ? '{{steps.0.id}}' : '{{data.assetId}}',
        severity: 'high',
        recommendation: 'Phân tích AI Triage cho sự kiện {{type}}.',
      };
    } else if (conn && /n8n|webhook|connector/.test(promptNorm)) {
      newStep = {
        type: 'call_connector',
        label: `Gọi connector ${conn}`,
        branchLabel: null,
        when: null,
        connectorKey: conn,
        method: 'POST',
        body: { eventType: '{{type}}', data: '{{data}}' },
      };
    } else {
      newStep = {
        type: 'notify_role',
        label: `Thông báo ${role || 'ldx_manager'}`,
        branchLabel: null,
        when: null,
        role: role || 'ldx_manager',
        category: 'automation',
        severity: 'warning',
        title: 'Thông báo tự động ({{type}})',
        body: 'Xử lý sự kiện từ {{data.deviceKey}}',
      };
    }
    draftRule.actionsJson.push(newStep);
    const idx = draftRule.actionsJson.length - 1;
    patch = { targetNode: `step:${idx}`, addedStep: cloneSafe(newStep) };
    diffSummary.push(`Thêm bước #${idx} (${newStep.type})`);
  } else if (resolvedTarget.startsWith('step:')) {
    const idx = Number(resolvedTarget.slice(5));
    if (!Number.isInteger(idx) || idx < 0 || idx >= draftRule.actionsJson.length) {
      return {
        refused: true,
        error: `Target step index "${resolvedTarget}" is out of range.`,
      };
    }
    if (/xoa buoc|go buoc|remove step|delete step/.test(promptNorm)) {
      const removed = draftRule.actionsJson.splice(idx, 1)[0];
      patch = { targetNode: resolvedTarget, removedStepIndex: idx, removedType: removed?.type };
      diffSummary.push(`Đã xóa bước #${idx} (${removed?.type || 'unknown'})`);
    } else {
      const step = draftRule.actionsJson[idx];
      const updatedFields = {};

      let temp = extractTemperature(promptNorm, prompt);
      if (temp === null && step.type === 'twin_set_desired') {
        const bareNum = promptNorm.match(/(?:doi|thanh|set|to|=)\s*(-?\d+(?:[.,]\d+)?)/i);
        if (bareNum) {
          const n = Number(bareNum[1].replace(',', '.'));
          if (Number.isFinite(n) && n >= -80 && n <= 120) temp = n;
        }
      }
      if (temp !== null && step.type === 'twin_set_desired') {
        step.desiredPatch = { ...(isPlainObject(step.desiredPatch) ? step.desiredPatch : {}), targetTempC: temp };
        updatedFields.desiredPatch = cloneSafe(step.desiredPatch);
        diffSummary.push(`Đổi bước #${idx} (${step.type}) desiredPatch.targetTempC = ${temp}°C`);
      }

      if (/fanmode\s*(?:=|la|thanh)?\s*(auto|high|low|eco)/i.test(promptNorm) && step.type === 'twin_set_desired') {
        const fan = promptNorm.match(/fanmode\s*(?:=|la|thanh)?\s*(auto|high|low|eco)/i)[1].toLowerCase();
        step.desiredPatch = { ...(isPlainObject(step.desiredPatch) ? step.desiredPatch : {}), fanMode: fan };
        updatedFields.desiredPatch = cloneSafe(step.desiredPatch);
        diffSummary.push(`Đổi bước #${idx} fanMode = ${fan}`);
      }

      const role = extractRoleFromPrompt(promptNorm, catalog);
      if (role) {
        if (step.type === 'notify_role') {
          step.role = role;
          updatedFields.role = role;
          diffSummary.push(`Đổi vai trò nhận thông báo bước #${idx} thành ${role}`);
        } else if (step.type === 'create_record' && isPlainObject(step.values)) {
          step.values.assignedRole = role;
          updatedFields.values = cloneSafe(step.values);
          diffSummary.push(`Cập nhật assignedRole bước #${idx} thành ${role}`);
        }
      }

      if (step.type === 'call_connector') {
        const conn = findMatchingConnector(catalog, null, promptNorm);
        if (conn && conn !== step.connectorKey) {
          step.connectorKey = conn;
          updatedFields.connectorKey = conn;
          diffSummary.push(`Đổi connectorKey bước #${idx} thành ${conn}`);
        }
      }

      if (step.type === 'create_record' || step.type === 'update_record') {
        const matchedCol = findMatchingCollection(catalog, null, promptNorm);
        if (matchedCol && promptNorm.includes(matchedCol.toLowerCase())) {
          step.collection = matchedCol;
          updatedFields.collection = matchedCol;
          diffSummary.push(`Đổi collection bước #${idx} thành ${matchedCol}`);
        }
      }

      if (/bo dieu kien nhanh|luon chay|main lane|clear when|xoa nhanh/.test(promptNorm)) {
        step.when = null;
        step.branchLabel = null;
        updatedFields.when = null;
        updatedFields.branchLabel = null;
        diffSummary.push(`Chuyển bước #${idx} về nhánh chính (when = null)`);
      } else if (/khi uu tien\s*=?\s*(critical|high|medium|low)|khi (critical|high)/.test(promptNorm)) {
        const prioMatch = promptNorm.match(/(critical|high|medium|low)/);
        const prio = prioMatch ? prioMatch[1] : 'critical';
        step.when = { 'dmn.workOrderPriority': prio };
        step.branchLabel = `Khi ưu tiên = ${prio}`;
        updatedFields.when = cloneSafe(step.when);
        updatedFields.branchLabel = step.branchLabel;
        diffSummary.push(`Đặt điều kiện nhánh bước #${idx}: dmn.workOrderPriority = ${prio}`);
      }

      if (Object.keys(updatedFields).length === 0) {
        const cleanPrompt = String(prompt || '').trim().slice(0, 120);
        if (cleanPrompt) {
          if (step.type === 'notify_role') {
            step.body = cleanPrompt;
            updatedFields.body = cleanPrompt;
          } else if (step.type === 'trigger_ai_triage') {
            step.recommendation = cleanPrompt;
            updatedFields.recommendation = cleanPrompt;
          } else {
            step.label = cleanPrompt;
            updatedFields.label = cleanPrompt;
          }
          diffSummary.push(`Cập nhật nội dung bước #${idx}`);
        }
      }

      patch = { targetNode: resolvedTarget, stepIndex: idx, updatedFields };
    }
  }

  return {
    refused: false,
    mode: 'node',
    summary: diffSummary.length ? diffSummary.join('; ') : `Đã rà soát node ${resolvedTarget}.`,
    targetNode: resolvedTarget,
    draftRule,
    patch,
    diffSummary,
    sampleEvent: resolveSampleEventForRule(draftRule, catalog),
    suggestions: buildSuggestionsForRule(draftRule, catalog),
  };
}

/**
 * Context-aware fail-closed AI Copilot supporting full, node, and suggest modes.
 */
function runAutomationAiAssist({ mode, prompt, rule, targetNode, catalog } = {}) {
  const resolvedMode = String(mode || (isPlainObject(rule) && !prompt ? 'suggest' : targetNode ? 'node' : 'full'))
    .trim()
    .toLowerCase();

  if (!['full', 'node', 'suggest'].includes(resolvedMode)) {
    return { refused: true, error: `Unsupported aiAssist mode "${resolvedMode}".` };
  }

  const sec = validateAiAssistSecurity({ prompt, targetNode, rule });
  if (sec.refused) return sec;

  if (resolvedMode === 'full') {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      return { refused: true, error: 'Prompt is required when mode is "full".' };
    }
    return synthesizeFullRule({ prompt: cleanPrompt, rule, catalog });
  }

  if (resolvedMode === 'node') {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      return { refused: true, error: 'Prompt is required when mode is "node".' };
    }
    return patchTargetNode({ prompt: cleanPrompt, rule, targetNode, catalog });
  }

  const baseRule = isPlainObject(rule) ? cloneSafe(rule) : getBlueprintByKey('auto_cmms_on_coldchain_fault');
  const suggestions = buildSuggestionsForRule(baseRule, catalog);
  const topPreview = cloneSafe(baseRule);
  if (!Array.isArray(topPreview.actionsJson)) topPreview.actionsJson = [];
  for (const sug of suggestions) {
    if (sug.id === 'add_cooldown_guard') topPreview.cooldownSec = 60;
    if (sug.id === 'narrow_broad_trigger') {
      topPreview.triggerEventType = sug.patch.triggerEventType;
      topPreview.filterJson = sug.patch.filterJson;
    }
    if (sug.id === 'use_dmn_outputs' && Array.isArray(sug.previewRule?.actionsJson)) {
      topPreview.actionsJson = cloneSafe(sug.previewRule.actionsJson);
    }
    if (sug.id === 'add_twin_hitl_step' && !topPreview.actionsJson.some((a) => a.type === 'twin_set_desired')) {
      topPreview.actionsJson.push(cloneSafe(sug.previewRule.actionsJson.at(-1)));
    }
    if (sug.id === 'add_ai_triage_step' && !topPreview.actionsJson.some((a) => a.type === 'trigger_ai_triage')) {
      topPreview.actionsJson.push(cloneSafe(sug.previewRule.actionsJson.at(-1)));
    }
    if (sug.id === 'add_vault_connector_step' && !topPreview.actionsJson.some((a) => a.type === 'call_connector')) {
      topPreview.actionsJson.push(cloneSafe(sug.previewRule.actionsJson.at(-1)));
    }
    if (sug.id === 'add_conditional_branch' && !topPreview.actionsJson.some((a) => isPlainObject(a.when) && Object.keys(a.when).length > 0)) {
      const highImpactIdx = topPreview.actionsJson.findIndex((a) => ['twin_set_desired', 'call_connector', 'trigger_ai_triage'].includes(a.type));
      const idxToBranch = highImpactIdx >= 0 ? highImpactIdx : topPreview.actionsJson.length - 1;
      if (idxToBranch >= 0) {
        topPreview.actionsJson[idxToBranch].when = cloneSafe(sug.patch.when);
        topPreview.actionsJson[idxToBranch].branchLabel = sug.patch.branchLabel;
      }
    }
  }

  return {
    refused: false,
    mode: 'suggest',
    summary:
      suggestions.length > 0
        ? `Phát hiện ${suggestions.length} đề xuất tối ưu hóa quy trình dựa trên dữ liệu hệ thống.`
        : 'Quy trình đã đầy đủ các lớp bảo vệ (cooldown, filter, branching và kết nối hệ thống).',
    draftRule: topPreview,
    suggestions,
    diffSummary: suggestions.map((s) => s.title),
    sampleEvent: resolveSampleEventForRule(baseRule, catalog),
  };
}

module.exports = {
  ACTION_SCHEMA_CATALOG,
  AUTOMATION_BLUEPRINTS,
  STANDARD_EVENT_CATALOG,
  buildAutomationBuilderCatalog,
  runAutomationAiAssist,
};
