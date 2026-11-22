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
const base = (name, title, fields, indexes = []) => ({
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
    {fields: ['organizationId', 'code'], unique: true},
    ...indexes,
  ],
});
const documentFields = () => [
  text('description','Nội dung'),text('category','Loại yêu cầu'),
  text('status','Trạng thái',{defaultValue:'draft',allowNull:false}),
  {name:'version',type:'integer',defaultValue:1,allowNull:false},
  text('decisionReason','Lý do quyết định'),
  relation('requester','latticeEmployees','requesterId'),
  relation('assignee','latticeEmployees','assigneeId'),
  relation('department','latticeDepartments','departmentId'),
];
const documentIndexes = [
  {fields: ['organizationId', 'status', 'createdAt']},
  {fields: ['organizationId', 'requesterId', 'status']},
  {fields: ['organizationId', 'assigneeId', 'status']},
  {fields: ['organizationId', 'departmentId']},
];
module.exports = {
  requests: base('latticeRequests', 'Yêu cầu nghiệp vụ', documentFields(), documentIndexes),
  orders: base('latticeOrders', 'Đơn hàng', [
    ...documentFields(), text('customer', 'Khách hàng'), text('origin', 'Điểm đi'), text('destination', 'Điểm đến'),
    {name: 'quantity', type: 'double', interface: 'number', uiSchema: {title: 'Số lượng', 'x-component': 'InputNumber'}},
  ], documentIndexes),
  departments: base('latticeDepartments', 'Đơn vị / phòng ban', [
    many('employees', 'latticeEmployees', 'departmentId'), many('locations', 'latticeLocations', 'departmentId'),
    many('assets', 'latticeAssets', 'departmentId'),
  ], [
    {fields: ['organizationId', 'active']},
    {fields: ['organizationId', 'name']},
  ]),
  employees: base('latticeEmployees', 'Nhân viên', [text('email', 'Email'), text('identitySubject', 'Identity subject'),
    {name: 'userId', type: 'bigInt', unique: true, allowNull: true}, relation('user', 'users', 'userId'),
    relation('department', 'latticeDepartments', 'departmentId'), many('assets', 'latticeAssets', 'custodianId'),
  ], [
    {fields: ['organizationId', 'active']},
    {fields: ['organizationId', 'departmentId', 'active']},
    {fields: ['userId']},
  ]),
  locations: base('latticeLocations', 'Địa điểm', [text('kind', 'Loại địa điểm'), text('address', 'Địa chỉ'),
    relation('department', 'latticeDepartments', 'departmentId'), many('assets', 'latticeAssets', 'locationId'),
  ], [
    {fields: ['organizationId', 'departmentId', 'active']},
    {fields: ['organizationId', 'kind']},
  ]),
  assets: base('latticeAssets', 'Tài sản', [text('kind', 'Loại tài sản'), text('status', 'Trạng thái', {defaultValue: 'available'}),
    {name: 'version', type: 'integer', defaultValue: 1, allowNull: false},
    relation('department', 'latticeDepartments', 'departmentId'), relation('location', 'latticeLocations', 'locationId'),
    relation('custodian', 'latticeEmployees', 'custodianId'),
  ], [
    {fields: ['organizationId', 'departmentId', 'status']},
    {fields: ['organizationId', 'locationId']},
    {fields: ['organizationId', 'custodianId']},
    {fields: ['organizationId', 'active']},
  ]),
  incidentRules: base('latticeIncidentRules', 'Luật cảnh báo sự cố', [
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
    {fields: ['organizationId', 'assetEntityId', 'active']},
    {fields: ['organizationId', 'assetId']},
    {fields: ['organizationId', 'handlerId']},
  ]),
  incidentCases: base('latticeIncidentCases', 'Sự cố thiết bị', [
    text('runId', 'Mã lượt quy trình', {allowNull: false}),
    text('assetEntityId', 'Mã tài sản', {allowNull: false}),
    text('notificationId', 'Mã thông báo cảnh báo'),
    text('handlerId', 'Kỹ thuật viên phụ trách', {allowNull: false}),
    text('severity', 'Mức độ nghiêm trọng', {defaultValue: 'medium'}),
    text('status', 'Trạng thái xử lý', {defaultValue: 'open'}),
    text('proposal', 'Đề xuất giải pháp AI'),
    text('resolutionNote', 'Ghi chú khắc phục'),
    text('closeNote', 'Ghi chú đóng sự cố'),
    relation('asset', 'latticeAssets', 'assetId'),
  ], [
    {fields: ['organizationId', 'status', 'severity']},
    {fields: ['organizationId', 'assetEntityId', 'status']},
    {fields: ['organizationId', 'runId']},
    {fields: ['organizationId', 'handlerId']},
    {fields: ['organizationId', 'assetId']},
  ]),
};
