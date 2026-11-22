/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const text = (name, title, extra = {}) => ({name, type: 'string', interface: 'input',
  uiSchema: {type: 'string', title, 'x-component': 'Input'}, ...extra});
const relation = (name, target, foreignKey) => ({name, type: 'belongsTo', target, foreignKey});
const many = (name, target, foreignKey) => ({name, type: 'hasMany', target, foreignKey});
const base = (name, title, shortPrefix, fields, indexes = []) => ({
  name,
  title,
  titleField: 'name',
  origin: '@latticedx/plugin-lattice-foundation',
  uiManageable: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    text('code', 'Mã', {allowNull: false}),
    text('name', 'Tên', {allowNull: false}),
    text('organizationId', 'Mã tổ chức', {allowNull: false}),
    {name: 'active', type: 'boolean', defaultValue: true},
    ...fields,
  ],
  indexes: [
    {name: `uidx_lattice_${shortPrefix}_org_code`, fields: ['organizationId', 'code'], unique: true},
    ...indexes,
  ],
});
const documentFields = () => [
  text('description','Nội dung'),text('category','Loại yêu cầu'),
  text('status','Trạng thái',{defaultValue:'draft',allowNull:false}),
  {name:'version',type:'integer',defaultValue:1,allowNull:false},
  text('decisionReason','Lý do quyết định'),
  {name:'submittedAt',type:'date'},
  text('submittedBy','Người trình duyệt'),
  {name:'cancelledAt',type:'date'},
  text('cancelledBy','Người hủy chứng từ'),
  text('cancelReason','Lý do hủy chứng từ'),
  {name:'amendedFromId',type:'bigInt'},
  {name:'amendmentNo',type:'integer',defaultValue:0,allowNull:false},
  relation('requester','latticeEmployees','requesterId'),
  relation('assignee','latticeEmployees','assigneeId'),
  relation('department','latticeDepartments','departmentId'),
];
const documentIndexes = (shortPrefix) => [
  {name: `idx_lattice_${shortPrefix}_org_status_created`, fields: ['organizationId', 'status', 'createdAt']},
  {name: `idx_lattice_${shortPrefix}_org_requester_status`, fields: ['organizationId', 'requesterId', 'status']},
  {name: `idx_lattice_${shortPrefix}_org_assignee_status`, fields: ['organizationId', 'assigneeId', 'status']},
  {name: `idx_lattice_${shortPrefix}_org_department`, fields: ['organizationId', 'departmentId']},
  {name: `idx_lattice_${shortPrefix}_org_amended`, fields: ['organizationId', 'amendedFromId']},
];
module.exports = {
  requests: base('latticeRequests', 'Yêu cầu nghiệp vụ', 'requests', documentFields(), documentIndexes('requests')),
  orders: base('latticeOrders', 'Đơn hàng', 'orders', [
    ...documentFields(), text('customer', 'Khách hàng'), text('origin', 'Điểm đi'), text('destination', 'Điểm đến'),
    {name: 'quantity', type: 'double', interface: 'number', uiSchema: {title: 'Số lượng', 'x-component': 'InputNumber'}},
  ], documentIndexes('orders')),
  departments: base('latticeDepartments', 'Đơn vị / phòng ban', 'departments', [
    many('employees', 'latticeEmployees', 'departmentId'), many('locations', 'latticeLocations', 'departmentId'),
    many('assets', 'latticeAssets', 'departmentId'),
  ], [
    {name: 'idx_lattice_departments_org_active', fields: ['organizationId', 'active']},
    {name: 'idx_lattice_departments_org_name', fields: ['organizationId', 'name']},
  ]),
  employees: base('latticeEmployees', 'Nhân viên', 'employees', [text('email', 'Email'), text('identitySubject', 'Identity subject'),
    {name: 'userId', type: 'bigInt', unique: true, allowNull: true}, relation('user', 'users', 'userId'),
    relation('department', 'latticeDepartments', 'departmentId'), many('assets', 'latticeAssets', 'custodianId'),
  ], [
    {name: 'idx_lattice_employees_org_active', fields: ['organizationId', 'active']},
    {name: 'idx_lattice_employees_org_dept_active', fields: ['organizationId', 'departmentId', 'active']},
    {name: 'idx_lattice_employees_user_id', fields: ['userId']},
  ]),
  locations: base('latticeLocations', 'Địa điểm', 'locations', [text('kind', 'Loại địa điểm'), text('address', 'Địa chỉ'),
    relation('department', 'latticeDepartments', 'departmentId'), many('assets', 'latticeAssets', 'locationId'),
  ], [
    {name: 'idx_lattice_locations_org_dept_active', fields: ['organizationId', 'departmentId', 'active']},
    {name: 'idx_lattice_locations_org_kind', fields: ['organizationId', 'kind']},
  ]),
  assets: base('latticeAssets', 'Tài sản', 'assets', [text('kind', 'Loại tài sản'), text('status', 'Trạng thái', {defaultValue: 'available'}),
    {name: 'version', type: 'integer', defaultValue: 1, allowNull: false},
    relation('department', 'latticeDepartments', 'departmentId'), relation('location', 'latticeLocations', 'locationId'),
    relation('custodian', 'latticeEmployees', 'custodianId'),
  ], [
    {name: 'idx_lattice_assets_org_dept_status', fields: ['organizationId', 'departmentId', 'status']},
    {name: 'idx_lattice_assets_org_location', fields: ['organizationId', 'locationId']},
    {name: 'idx_lattice_assets_org_custodian', fields: ['organizationId', 'custodianId']},
    {name: 'idx_lattice_assets_org_active', fields: ['organizationId', 'active']},
  ]),
  incidentRules: base('latticeIncidentRules', 'Luật cảnh báo sự cố', 'incident_rules', [
    text('assetEntityId', 'Mã tài sản', {allowNull: false}),
    text('attribute', 'Thuộc tính giám sát', {allowNull: false}),
    text('operator', 'Toán tử so sánh', {allowNull: false}),
    text('threshold', 'Ngưỡng cảnh báo', {allowNull: false}),
    text('unit', 'Đơn vị đo', {allowNull: false}),
    text('severity', 'Mức độ nghiêm trọng', {defaultValue: 'medium'}),
    text('maxObservationAgeSeconds', 'Tuổi dữ liệu tối đa', {defaultValue: '300'}),
    text('cooldownSeconds', 'Thời gian chờ chống lặp', {defaultValue: '300'}),
    text('workflowDefinitionId', 'Quy trình xử lý', {defaultValue: 'incident-response'}),
    text('workflowDefinitionVersion', 'Phiên bản quy trình', {defaultValue: '1'}),
    text('handlerId', 'Kỹ thuật viên phụ trách', {allowNull: false}),
    relation('asset', 'latticeAssets', 'assetId'),
  ], [
    {name: 'idx_lattice_incident_rules_org_asset_active', fields: ['organizationId', 'assetEntityId', 'active']},
    {name: 'idx_lattice_incident_rules_org_asset_id', fields: ['organizationId', 'assetId']},
    {name: 'idx_lattice_incident_rules_org_handler', fields: ['organizationId', 'handlerId']},
  ]),
  incidentCases: base('latticeIncidentCases', 'Sự cố thiết bị', 'incident_cases', [
    text('runId', 'Mã lượt quy trình', {allowNull: false}),
    text('assetEntityId', 'Mã tài sản', {allowNull: false}),
    text('notificationId', 'Mã thông báo cảnh báo'),
    text('handlerId', 'Kỹ thuật viên phụ trách', {allowNull: false}),
    text('severity', 'Mức độ nghiêm trọng', {defaultValue: 'medium'}),
    text('status', 'Trạng thái xử lý', {defaultValue: 'open'}),
    text('proposal', 'Đề xuất giải pháp AI'),
    text('resolutionNote', 'Ghi chú khắc phục'),
    text('closeNote', 'Ghi chú đóng sự cố'),
    text('fingerprint', 'Dấu vân tay chống trùng lặp'),
    {name: 'occurrenceCount', type: 'integer', defaultValue: 1, allowNull: false},
    {name: 'firstSeenAt', type: 'date'},
    {name: 'lastSeenAt', type: 'date'},
    {name: 'acknowledgedAt', type: 'date'},
    text('acknowledgedBy', 'Người xác nhận (Ack)'),
    {name: 'clearedAt', type: 'date'},
    text('clearedBy', 'Người đóng cảnh báo (Clear)'),
    relation('asset', 'latticeAssets', 'assetId'),
  ], [
    {name: 'idx_lattice_incident_cases_org_status_sev', fields: ['organizationId', 'status', 'severity']},
    {name: 'idx_lattice_incident_cases_org_asset_status', fields: ['organizationId', 'assetEntityId', 'status']},
    {name: 'idx_lattice_incident_cases_dedup', fields: ['organizationId', 'assetEntityId', 'fingerprint', 'status']},
    {name: 'idx_lattice_incident_cases_org_run', fields: ['organizationId', 'runId']},
    {name: 'idx_lattice_incident_cases_org_handler', fields: ['organizationId', 'handlerId']},
    {name: 'idx_lattice_incident_cases_org_asset_id', fields: ['organizationId', 'assetId']},
  ]),
};
