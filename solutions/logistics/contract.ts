/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Planning/fixture contract only. These are not deployed business API models.
type Entity = { id: string; organizationId: string };
export type LogisticsFixture = {
  warehouses: (Entity & { name: string; locationId: string })[];
  vehicles: (Entity & { registration: string; assetId: string })[];
  orders: (Entity & { warehouseId: string; recordId: string; requestedBy: string; state: string })[];
  shipments: (Entity & { orderId: string; vehicleId?: string; state: string })[];
};
export const orderTransitions = [
  { from: 'draft', to: 'submitted', role: 'logistics:sales', action: 'submit' },
  { from: 'submitted', to: 'approved', role: 'logistics:manager', action: 'approve' },
  { from: 'submitted', to: 'rejected', role: 'logistics:manager', action: 'reject' },
  { from: 'approved', to: 'preparing', role: 'logistics:warehouse', action: 'prepare' },
  { from: 'preparing', to: 'ready', role: 'logistics:warehouse', action: 'confirm-ready' },
  { from: 'ready', to: 'fulfilled', role: 'logistics:dispatch', action: 'confirm-all-delivered' },
  { from: 'fulfilled', to: 'reconciled', role: 'logistics:finance', action: 'reconcile' },
] as const;
export const shipmentTransitions = [
  { from: 'planned', to: 'assigned', role: 'logistics:dispatch', action: 'assign-vehicle' },
  { from: 'assigned', to: 'in_transit', role: 'logistics:driver', action: 'depart' },
  { from: 'in_transit', to: 'delivered', role: 'logistics:driver', action: 'confirm-delivery' },
  { from: 'in_transit', to: 'exception', role: 'logistics:driver', action: 'report-exception' },
  { from: 'exception', to: 'assigned', role: 'logistics:dispatch', action: 'reassign' },
] as const;
export function validateLogistics(f: LogisticsFixture): string[] {
  const errors: string[] = [], seen = new Set<string>();
  for (const e of [...f.warehouses, ...f.vehicles, ...f.orders, ...f.shipments]) {
    if (seen.has(e.id)) errors.push(`${e.id}: duplicate id`);
    seen.add(e.id);
    if (!e.id.trim() || !e.organizationId.trim()) errors.push(`${e.id}: missing identity/scope`);
  }
  function reference(e: Entity, id: string, targets: Entity[], name: string) {
    const target = targets.find(x => x.id === id);
    if (!target) errors.push(`${e.id}: missing ${name}`);
    else if (target.organizationId !== e.organizationId) errors.push(`${e.id}: ${name} organization mismatch`);
  }
  const orderStates = new Set<string>(orderTransitions.flatMap(t => [t.from, t.to]));
  const shipmentStates = new Set<string>(shipmentTransitions.flatMap(t => [t.from, t.to]));
  for (const e of f.orders) {
    reference(e, e.warehouseId, f.warehouses, 'warehouse');
    if (!orderStates.has(e.state)) errors.push(`${e.id}: invalid state`);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(e.recordId)) errors.push(`${e.id}: invalid recordId`);
  }
  for (const e of f.shipments) {
    reference(e, e.orderId, f.orders, 'order');
    if (e.vehicleId) reference(e, e.vehicleId, f.vehicles, 'vehicle');
    if (!shipmentStates.has(e.state)) errors.push(`${e.id}: invalid state`);
    if (e.state !== 'planned' && !e.vehicleId) errors.push(`${e.id}: vehicle required after planning`);
  }
  return errors;
}
export const logisticsFixture: LogisticsFixture = {
  warehouses: [{id:'warehouse-1',organizationId:'org-a',name:'Kho Cần Thơ',locationId:'location-1'}],
  vehicles: [{id:'vehicle-1',organizationId:'org-a',registration:'DEMO-001',assetId:'asset-1'}],
  orders: [{id:'order-1',organizationId:'org-a',warehouseId:'warehouse-1',recordId:'11111111-1111-4111-8111-111111111111',requestedBy:'demo-sales-subject',state:'ready'}],
  shipments: [{id:'shipment-1',organizationId:'org-a',orderId:'order-1',vehicleId:'vehicle-1',state:'assigned'}],
};
