// SPDX-License-Identifier: Apache-2.0
const text = (name, title, extra = {}) => ({name, type: 'string', interface: 'input',
  uiSchema: {type: 'string', title, 'x-component': 'Input'}, ...extra});
const relation = (name, target, foreignKey) => ({name, type: 'belongsTo', target, foreignKey});
const many = (name, target, foreignKey) => ({name, type: 'hasMany', target, foreignKey});
const base = (name, title, fields) => ({name, title, titleField: 'name', origin: '@latticedx/plugin-lattice-foundation',
  createdAt: true, updatedAt: true, fields: [
    text('code', 'Mã', {allowNull: false, unique: true}), text('name', 'Tên', {allowNull: false}),
    text('organizationId', 'Mã tổ chức', {allowNull: false}),
    {name: 'active', type: 'boolean', defaultValue: true}, ...fields]});
module.exports = {
  departments: base('latticeDepartments', 'Đơn vị / phòng ban', [
    many('employees', 'latticeEmployees', 'departmentId'), many('locations', 'latticeLocations', 'departmentId'),
    many('assets', 'latticeAssets', 'departmentId')]),
  employees: base('latticeEmployees', 'Nhân viên', [text('email', 'Email'), text('identitySubject', 'Identity subject'),
    relation('department', 'latticeDepartments', 'departmentId'), many('assets', 'latticeAssets', 'custodianId')]),
  locations: base('latticeLocations', 'Địa điểm', [text('kind', 'Loại địa điểm'), text('address', 'Địa chỉ'),
    relation('department', 'latticeDepartments', 'departmentId'), many('assets', 'latticeAssets', 'locationId')]),
  assets: base('latticeAssets', 'Tài sản', [text('kind', 'Loại tài sản'), text('status', 'Trạng thái', {defaultValue: 'available'}),
    relation('department', 'latticeDepartments', 'departmentId'), relation('location', 'latticeLocations', 'locationId'),
    relation('custodian', 'latticeEmployees', 'custodianId')]),
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
    relation('asset', 'latticeAssets', 'assetId')]),
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
    relation('asset', 'latticeAssets', 'assetId')]),
};

