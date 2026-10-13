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
};
