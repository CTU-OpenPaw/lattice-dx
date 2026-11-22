/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const ORG_RE = /^[-a-zA-Z0-9_]{1,80}$/;
const EMP_ID_RE = /^[1-9]\d{0,18}$/;

function badTemplate(msg) {
  return Object.assign(new Error(msg), { code: 'DXOS_TEMPLATE_INVALID', status: 400 });
}

function manualInterface(name, title, actions, collection, fields, detailTitle, note) {
  const buttons = Object.fromEntries(actions.map((action) => [action.key, {
    type: 'void',
    title: action.title,
    'x-component': 'Action',
    'x-decorator': 'ManualActionStatusProvider',
    'x-decorator-props': { value: action.status },
    'x-component-props': { type: action.key === 'reject' ? 'default' : 'primary', useAction: '{{ useSubmit }}' },
    'x-designer': 'ManualActionDesigner',
    'x-action-settings': { assignedValues: { values: action.values } },
  }]));
  const actionBar = {
    type: 'void',
    'x-decorator': 'ActionBarProvider',
    'x-component': 'ActionBar',
    'x-component-props': { layout: 'one-column' },
    'x-initializer': 'workflowManual:form:configureActions',
    properties: buttons,
  };
  const properties = note
    ? { [note.key]: { type: 'string', title: note.title, required: true, 'x-decorator': 'FormItem', 'x-component': 'Input.TextArea', 'x-component-props': { maxLength: 255 } }, actions: actionBar }
    : { actions: actionBar };
  const form = { type: 'void', 'x-component': 'FormV2', 'x-use-component-props': 'useFormBlockProps', properties };
  const formBlock = {
    type: 'void',
    'x-decorator': 'CustomFormBlockProvider',
    'x-decorator-props': { collection: { name, fields: [] } },
    'x-component': 'CardItem',
    'x-component-props': { title },
    'x-designer': 'SimpleDesigner',
    'x-designer-props': { type: 'customForm' },
    properties: { [name]: form },
  };
  const detailFields = Object.fromEntries(fields.map((field) => [field, {
    type: 'string', 'x-component': 'CollectionField', 'x-decorator': 'FormItem',
    'x-collection-field': `${collection}.${field}`, 'x-read-pretty': true,
  }]));
  if (collection === 'latticeIncidentCases' && name === 'review') {
    detailFields.aiEvidence = { type: 'void', 'x-component': 'LatticeIncidentEvidence' };
  }
  const details = {
    type: 'void',
    'x-decorator': 'DetailsBlockProvider',
    'x-decorator-props': { collection, dataPath: '$context.data' },
    'x-component': 'CardItem',
    'x-component-props': { title: detailTitle },
    'x-settings': 'blockSettings:singleDataDetails',
    properties: { form: { type: 'void', 'x-component': 'FormV2', 'x-use-component-props': 'useDetailsBlockProps', 'x-read-pretty': true, properties: detailFields } },
  };
  return {
    tab1: {
      type: 'void',
      title,
      'x-component': 'Tabs.TabPane',
      'x-designer': 'Tabs.Designer',
      properties: {
        grid: {
          type: 'void',
          'x-component': 'Grid',
          'x-initializer': 'workflowManual:popup:configureUserInterface:addBlock',
          properties: {
            detailRow: { type: 'void', 'x-component': 'Grid.Row', properties: { column: { type: 'void', 'x-component': 'Grid.Col', properties: { details } } } },
            row: { type: 'void', 'x-component': 'Grid.Row', properties: { column: { type: 'void', 'x-component': 'Grid.Col', properties: { formBlock } } } },
          },
        },
      },
    },
  };
}

function listWorkflowTemplates() {
  return [
    {
      key: 'procurement',
      title: 'UC1 — Mua sắm & Yêu cầu nội bộ (Poka-yoke)',
      collection: 'latticeRequests',
      description: 'Nhân viên gửi yêu cầu → Quản lý duyệt (tách người duyệt/người gửi) → Chuyên trách thực hiện → Hoàn thành.',
      requiredBindings: [
        { field: 'reviewerEmployeeId', label: 'Quản lý duyệt', allowedRoles: ['ldx_manager', 'ldx_admin'] },
        { field: 'assigneeEmployeeId', label: 'Người thực hiện', allowedRoles: ['ldx_warehouse', 'ldx_employee', 'ldx_dispatcher', 'ldx_admin'] },
      ],
    },
    {
      key: 'logistics-5step',
      title: 'Logistics liên phòng ban 5 bước (Đơn vận chuyển)',
      collection: 'latticeOrders',
      description: 'Kinh doanh tạo đơn → Quản lý duyệt → Kho chuẩn bị hàng → Điều phối giao xe → Tài xế xác nhận hoàn tất (cập nhật assigneeId từng chặng).',
      requiredBindings: [
        { field: 'managerEmployeeId', label: 'Quản lý phê duyệt', allowedRoles: ['ldx_manager', 'ldx_admin'] },
        { field: 'warehouseEmployeeId', label: 'Thủ kho chuẩn bị', allowedRoles: ['ldx_warehouse', 'ldx_admin'] },
        { field: 'dispatcherEmployeeId', label: 'Điều phối vận chuyển', allowedRoles: ['ldx_dispatcher', 'ldx_admin'] },
        { field: 'driverEmployeeId', label: 'Tài xế giao hàng', allowedRoles: ['ldx_driver', 'ldx_admin'] },
      ],
    },
    {
      key: 'incident-uc2',
      title: 'UC2 — Xử lý Sự cố IoT & Bằng chứng AI',
      collection: 'latticeIncidentCases',
      description: 'Cảnh báo cảm biến → Quản lý xem bằng chứng AI duyệt/từ chối → Kỹ thuật viên ghi kết quả → Quản lý đóng ca.',
      requiredBindings: [
        { field: 'reviewerEmployeeId', label: 'Quản lý phê duyệt', allowedRoles: ['ldx_manager', 'ldx_admin'] },
        { field: 'assigneeEmployeeId', label: 'Kỹ thuật viên xử lý', allowedRoles: ['ldx_warehouse', 'ldx_dispatcher', 'ldx_employee'] },
      ],
    },
    {
      key: 'internal-service',
      title: 'Miền thứ 2 — Dịch vụ Nội bộ & Nghỉ phép',
      collection: 'latticeServiceTickets',
      description: 'Nhân viên tạo phiếu dịch vụ/nghỉ phép → Quản lý duyệt/từ chối → Chuyên trách xử lý ghi nhận kết quả.',
      requiredBindings: [
        { field: 'reviewerEmployeeId', label: 'Quản lý duyệt', allowedRoles: ['ldx_manager', 'ldx_admin'] },
        { field: 'assigneeEmployeeId', label: 'Chuyên trách xử lý', allowedRoles: ['ldx_employee', 'ldx_dispatcher', 'ldx_warehouse', 'ldx_admin'] },
      ],
    },
  ];
}

function assertOrg(org) {
  if (!ORG_RE.test(org ?? '')) throw badTemplate('Mã tổ chức không hợp lệ.');
}

function assertDistinctIds(ids) {
  const strIds = ids.map((v) => String(v ?? ''));
  if (!strIds.every((id) => EMP_ID_RE.test(id))) throw badTemplate('ID nhân sự phải là số nguyên dương hợp lệ.');
  if (new Set(strIds).size !== strIds.length) throw badTemplate('Các vai trò Poka-yoke trong quy trình phải là những nhân sự khác nhau.');
  return strIds;
}

function buildWorkflowTemplate(templateKey, params = {}) {
  const organizationId = params.organizationId;
  assertOrg(organizationId);
  const ctx = (f) => `{{$context.data.${f}}}`;
  const res = (k, p) => `{{$jobsMapByNodeKey.${k}.${p}}}`;

  if (templateKey === 'logistics-5step') {
    const [mgrId, whId, dispId, drvId] = assertDistinctIds([
      params.managerEmployeeId,
      params.warehouseEmployeeId,
      params.dispatcherEmployeeId,
      params.driverEmployeeId,
    ]);
    const collection = 'latticeOrders';
    const fields = ['code', 'name', 'customer', 'origin', 'destination', 'quantity', 'status'];
    const nodes = [];
    const pushNode = (key, type, title, config, overrides = {}) => {
      const upstreamKey = overrides.upstreamKey !== undefined ? overrides.upstreamKey : nodes.at(-1)?.key;
      nodes.push({ key, type, title, config, ...(upstreamKey ? { upstreamKey } : {}), ...(overrides.branchIndex !== undefined ? { branchIndex: overrides.branchIndex } : {}) });
    };
    const emp = (key, id, extra = {}) => pushNode(key, 'query', `Kiểm tra ${key}`, {
      collection: 'latticeEmployees', multiple: false, failOnEmpty: true,
      params: { filter: { id, organizationId, active: true, userId: { $ne: null }, ...extra } },
    });
    const upd = (key, statusFilter, values) => pushNode(key, 'update', `Cập nhật ${key}`, {
      collection, params: { individualHooks: true, filter: { id: ctx('id'), organizationId, ...(statusFilter ? { status: statusFilter } : {}) }, values },
    });
    const man = (key, title, userId, actions, note) => {
      const cfg = { type: 'custom', actions: actions.map(([k, t, values]) => ({ key: k, title: t, status: 1, values })) };
      pushNode(key, 'manual', title, { mode: 0, assignees: [userId], forms: { [key]: cfg }, schema: manualInterface(key, title, cfg.actions, collection, fields, 'Thông tin đơn vận chuyển', note) });
    };

    emp('requester', ctx('requesterId'));
    emp('manager', mgrId, { 'user.roles.name': { $in: ['ldx_manager', 'ldx_admin'] } });
    pushNode('separation', 'condition', 'Tách người tạo và quản lý duyệt', { rejectOnFalse: true, calculation: { calculator: 'notEqual', operands: [res('manager', 'userId'), res('requester', 'userId')] } });
    upd('markSubmitted', 'draft', { status: 'submitted' });
    man('review', 'Bước 2 — Quản lý duyệt đơn', res('manager', 'userId'), [['approve', 'Duyệt đơn', { decision: 'approved' }], ['reject', 'Từ chối', { decision: 'rejected' }]]);
    emp('managerCurrent', mgrId, { userId: res('manager', 'userId'), 'user.roles.name': { $in: ['ldx_manager', 'ldx_admin'] } });
    pushNode('approved', 'condition', 'Kết quả phê duyệt', { rejectOnFalse: false, calculation: { calculator: 'equal', operands: [res('review', 'review.decision'), 'approved'] } });

    emp('warehouse', whId, { 'user.roles.name': { $in: ['ldx_warehouse', 'ldx_admin'] } });
    upd('assignWarehouse', 'submitted', { status: 'preparing', assigneeId: res('warehouse', 'id') });
    man('prepareWarehouse', 'Bước 3 — Kho chuẩn bị hàng', res('warehouse', 'userId'), [['prepared', 'Xác nhận đủ hàng', {}]]);
    emp('warehouseCurrent', whId, { userId: res('warehouse', 'userId'), 'user.roles.name': { $in: ['ldx_warehouse', 'ldx_admin'] } });

    emp('dispatcher', dispId, { 'user.roles.name': { $in: ['ldx_dispatcher', 'ldx_admin'] } });
    upd('assignDispatcher', 'preparing', { status: 'ready_for_dispatch', assigneeId: res('dispatcher', 'id') });
    man('dispatchOrder', 'Bước 4 — Điều phối xe & tuyến', res('dispatcher', 'userId'), [['dispatched', 'Giao chuyến xe', {}]], { key: 'vehicleNote', title: 'Biển số xe / Ghi chú điều phối' });
    emp('dispatcherCurrent', dispId, { userId: res('dispatcher', 'userId'), 'user.roles.name': { $in: ['ldx_dispatcher', 'ldx_admin'] } });

    emp('driver', drvId, { 'user.roles.name': { $in: ['ldx_driver', 'ldx_admin'] } });
    upd('assignDriver', 'ready_for_dispatch', { status: 'in_transit', assigneeId: res('driver', 'id'), decisionReason: res('dispatchOrder', 'dispatchOrder.vehicleNote') });
    man('driverDeliver', 'Bước 5 — Tài xế xác nhận giao hàng', res('driver', 'userId'), [['delivered', 'Hoàn thành giao nhận', {}]], { key: 'deliveryNote', title: 'Biên bản / Ghi chú giao hàng' });
    emp('driverCurrent', drvId, { userId: res('driver', 'userId'), 'user.roles.name': { $in: ['ldx_driver', 'ldx_admin'] } });
    upd('markCompleted', 'in_transit', { status: 'completed', decisionReason: res('driverDeliver', 'driverDeliver.deliveryNote') });

    pushNode('markRejected', 'update', 'Cập nhật từ chối', {
      collection, params: { individualHooks: true, filter: { id: ctx('id'), organizationId, status: 'submitted' }, values: { status: 'rejected' } },
    }, { upstreamKey: 'approved', branchIndex: 0 });
    pushNode('endRejected', 'end', 'Kết thúc nhánh từ chối', { endStatus: 1 });

    return {
      workflow: {
        title: `DX-OS — Logistics 5 bước — ${organizationId}`,
        type: 'collection',
        enabled: false,
        sync: false,
        options: { dxosTemplateKey: 'logistics-5step', dxosOrganizationId: organizationId },
        config: { collection, mode: 1, condition: { organizationId } },
      },
      nodes,
    };
  }

  if (templateKey === 'procurement' || templateKey === 'internal-service') {
    const [reviewerId, assigneeId] = assertDistinctIds([params.reviewerEmployeeId, params.assigneeEmployeeId]);
    const collection = templateKey === 'internal-service' ? 'latticeServiceTickets' : 'latticeRequests';
    const fields = templateKey === 'internal-service'
      ? ['code', 'name', 'serviceType', 'priority', 'description']
      : ['code', 'name', 'description', 'category'];
    const detailTitle = templateKey === 'internal-service' ? 'Thông tin phiếu dịch vụ' : 'Thông tin yêu cầu';
    const nodes = [];
    const pushNode = (key, type, title, config, overrides = {}) => {
      const upstreamKey = overrides.upstreamKey !== undefined ? overrides.upstreamKey : nodes.at(-1)?.key;
      nodes.push({ key, type, title, config, ...(upstreamKey ? { upstreamKey } : {}), ...(overrides.branchIndex !== undefined ? { branchIndex: overrides.branchIndex } : {}) });
    };
    const emp = (key, id, extra = {}) => pushNode(key, 'query', `Kiểm tra ${key}`, {
      collection: 'latticeEmployees', multiple: false, failOnEmpty: true,
      params: { filter: { id, organizationId, active: true, userId: { $ne: null }, ...extra } },
    });
    const upd = (key, statusFilter, values) => pushNode(key, 'update', `Cập nhật ${key}`, {
      collection, params: { individualHooks: true, filter: { id: ctx('id'), organizationId, ...(statusFilter ? { status: statusFilter } : {}) }, values },
    });
    const man = (key, title, userId, actions, note) => {
      const cfg = { type: 'custom', actions: actions.map(([k, t, values]) => ({ key: k, title: t, status: 1, values })) };
      pushNode(key, 'manual', title, { mode: 0, assignees: [userId], forms: { [key]: cfg }, schema: manualInterface(key, title, cfg.actions, collection, fields, detailTitle, note) });
    };

    emp('requester', ctx('requesterId'));
    emp('reviewer', reviewerId, { 'user.roles.name': { $in: ['ldx_manager', 'ldx_admin'] } });
    pushNode('separation', 'condition', 'Tách người gửi và người duyệt', { rejectOnFalse: true, calculation: { calculator: 'notEqual', operands: [res('reviewer', 'userId'), res('requester', 'userId')] } });
    upd('submitted', 'draft', { status: 'submitted' });
    man('review', 'Duyệt yêu cầu', res('reviewer', 'userId'), [['approve', 'Duyệt', { decision: 'approved' }], ['reject', 'Từ chối', { decision: 'rejected' }]]);
    emp('reviewerCurrent', reviewerId, { userId: res('reviewer', 'userId'), 'user.roles.name': { $in: ['ldx_manager', 'ldx_admin'] } });
    pushNode('approved', 'condition', 'Kết quả phê duyệt', { rejectOnFalse: false, calculation: { calculator: 'equal', operands: [res('review', 'review.decision'), 'approved'] } });

    emp('assignee', assigneeId);
    upd('assigned', 'submitted', { status: templateKey === 'internal-service' ? 'in_progress' : 'assigned', assigneeId: res('assignee', 'id') });
    const noteSpec = templateKey === 'internal-service' ? { key: 'note', title: 'Kết quả xử lý' } : null;
    man('work', 'Thực hiện công việc', res('assignee', 'userId'), [['complete', 'Hoàn thành', {}]], noteSpec);
    emp('assigneeCurrent', assigneeId, { userId: res('assignee', 'userId') });
    upd('markCompleted', templateKey === 'internal-service' ? 'in_progress' : 'assigned', {
      status: 'completed',
      ...(noteSpec ? { resolutionNote: res('work', 'work.note') } : {}),
    });

    pushNode('markRejected', 'update', 'Cập nhật từ chối', {
      collection, params: { individualHooks: true, filter: { id: ctx('id'), organizationId, status: 'submitted' }, values: { status: 'rejected' } },
    }, { upstreamKey: 'approved', branchIndex: 0 });
    pushNode('endRejected', 'end', 'Kết thúc nhánh từ chối', { endStatus: 1 });

    return {
      workflow: {
        title: `DX-OS — ${templateKey === 'internal-service' ? 'Dịch vụ nội bộ' : 'UC1 Yêu cầu'} — ${organizationId}`,
        type: 'collection',
        enabled: false,
        sync: false,
        options: { dxosTemplateKey: templateKey, dxosOrganizationId: organizationId },
        config: { collection, mode: 1, condition: { organizationId } },
      },
      nodes,
    };
  }

  if (templateKey === 'incident-uc2') {
    const [reviewerId, handlerId] = assertDistinctIds([params.reviewerEmployeeId, params.assigneeEmployeeId]);
    const collection = 'latticeIncidentCases';
    const fields = ['code', 'name', 'severity', 'status', 'resolutionNote'];
    const nodes = [];
    const pushNode = (key, type, title, config, overrides = {}) => {
      const upstreamKey = overrides.upstreamKey !== undefined ? overrides.upstreamKey : nodes.at(-1)?.key;
      nodes.push({ key, type, title, config, ...(upstreamKey ? { upstreamKey } : {}), ...(overrides.branchIndex !== undefined ? { branchIndex: overrides.branchIndex } : {}) });
    };
    const emp = (key, id, extra = {}) => pushNode(key, 'query', 'Kiểm tra người được giao', {
      collection: 'latticeEmployees', multiple: false, failOnEmpty: true,
      params: { filter: { id, organizationId, active: true, userId: { $ne: null }, ...extra } },
    });
    const upd = (key, status, values) => pushNode(key, 'update', 'Cập nhật sự cố', {
      collection, params: { individualHooks: true, filter: { id: ctx('id'), organizationId, status, handlerId }, values },
    });
    const man = (key, title, user, actions, note) => {
      const cfg = { type: 'custom', actions: actions.map(([k, t, values]) => ({ key: k, title: t, status: 1, values })) };
      pushNode(key, 'manual', title, { mode: 0, assignees: [user], forms: { [key]: cfg }, schema: manualInterface(key, title, cfg.actions, collection, fields, 'Thông tin sự cố', note) });
    };
    const present = (key, operand) => pushNode(key, 'condition', `Kiểm tra ${key}`, {
      rejectOnFalse: true,
      calculation: { group: { type: 'and', calculations: [{ calculator: 'notEqual', operands: [operand, null] }, { calculator: 'notEqual', operands: [operand, ''] }] } },
    });

    const reviewer = res('reviewer', 'userId');
    const handler = res('handler', 'userId');
    emp('reviewer', reviewerId, { 'user.roles.name': { $in: ['ldx_manager', 'ldx_admin'] } });
    emp('handler', handlerId);
    pushNode('separation', 'condition', 'Tách người duyệt và kỹ thuật viên', { rejectOnFalse: true, calculation: { calculator: 'notEqual', operands: [reviewer, handler] } });
    man('review', 'Duyệt sự cố', reviewer, [['approve', 'Duyệt', { decision: 'approved' }], ['reject', 'Từ chối', { decision: 'rejected' }]]);
    emp('reviewerCurrent', reviewerId, { userId: reviewer, 'user.roles.name': { $in: ['ldx_manager', 'ldx_admin'] } });
    pushNode('approved', 'condition', 'Kết quả phê duyệt', { rejectOnFalse: false, calculation: { calculator: 'equal', operands: [res('review', 'review.decision'), 'approved'] } });
    upd('markApproved', 'open', { status: 'approved' });
    emp('handlerBeforeWork', handlerId, { userId: handler });
    man('resolution', 'Ghi kết quả xử lý', handler, [['resolve', 'Ghi kết quả', {}]], { key: 'note', title: 'Kết quả xử lý' });
    emp('handlerCurrent', handlerId, { userId: handler });
    present('resolutionPresent', res('resolution', 'resolution.note'));
    upd('markResolved', 'approved', { status: 'resolved', resolutionNote: res('resolution', 'resolution.note') });
    emp('reviewerBeforeClose', reviewerId, { userId: reviewer, 'user.roles.name': { $in: ['ldx_manager', 'ldx_admin'] } });
    man('close', 'Đóng sự cố', reviewer, [['close', 'Đóng sự cố', {}]], { key: 'note', title: 'Ghi chú đóng sự cố' });
    emp('reviewerAtClose', reviewerId, { userId: reviewer, 'user.roles.name': { $in: ['ldx_manager', 'ldx_admin'] } });
    present('closeNotePresent', res('close', 'close.note'));
    upd('markClosed', 'resolved', { status: 'closed', closeNote: res('close', 'close.note') });

    pushNode('markRejected', 'update', 'Từ chối xử lý', {
      collection, params: { individualHooks: true, filter: { id: ctx('id'), organizationId, status: 'open', handlerId }, values: { status: 'rejected' } },
    }, { upstreamKey: 'approved', branchIndex: 0 });
    pushNode('endRejected', 'end', 'Kết thúc nhánh từ chối', { endStatus: 1 });

    return {
      workflow: {
        title: `DX-OS — UC2 Xử lý sự cố — ${organizationId}`,
        type: 'collection',
        enabled: false,
        sync: false,
        options: { dxosTemplateKey: 'incident-uc2', dxosOrganizationId: organizationId },
        config: { collection, mode: 1, condition: { organizationId, handlerId, status: 'open' } },
      },
      nodes,
    };
  }

  throw badTemplate(`Mẫu quy trình "${templateKey}" không tồn tại.`);
}

module.exports = { listWorkflowTemplates, buildWorkflowTemplate };
