// SPDX-License-Identifier: Apache-2.0
const units = [
  {code: 'DEMO-UNIT-01', organizationId: 'demo-organization-01', name: 'Đơn vị mẫu 1', suffix: '01'},
  {code: 'DEMO-UNIT-02', organizationId: 'demo-organization-02', name: 'Đơn vị mẫu 2', suffix: '02'},
];
async function ensure(db, collection, values, transaction) {
  const repo = db.getRepository(collection);
  const existing = await repo.findOne({filter: {code: values.code}, transaction});
  if (existing) {
    if (existing.get('organizationId') !== values.organizationId) throw new Error(`Seed identity conflict: ${collection}/${values.code}`);
    return existing;
  }
  return repo.create({values, transaction});
}
async function seedFoundation(db, transaction) {
  for (const unit of units) {
    const {suffix, ...values} = unit;
    const department = await ensure(db, 'latticeDepartments', values, transaction);
    const scope = {organizationId: unit.organizationId, departmentId: department.get('id')};
    const employee = await ensure(db, 'latticeEmployees', {
      ...scope, code: `DEMO-EMP-${suffix}`, name: `Nhân viên mẫu ${suffix}`, email: `employee${suffix}@example.invalid`,
    }, transaction);
    const location = await ensure(db, 'latticeLocations', {
      ...scope, code: `DEMO-LOC-${suffix}`, name: `Kho mẫu ${suffix}`, kind: 'warehouse', address: 'Địa chỉ minh họa',
    }, transaction);
    await ensure(db, 'latticeAssets', {
      ...scope, code: `DEMO-ASSET-${suffix}`, name: `Tài sản mẫu ${suffix}`, kind: 'equipment', status: 'available',
      locationId: location.get('id'), custodianId: employee.get('id'),
    }, transaction);
  }
}
module.exports = {seedFoundation};
