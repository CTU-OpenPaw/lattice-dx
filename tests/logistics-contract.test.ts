// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { validateLogistics, logisticsFixture } from '../solutions/logistics/contract.js';
describe('logistics relationship contract', () => {
  it('accepts the cross-department fixture', () => expect(validateLogistics(logisticsFixture)).toEqual([]));
  it('rejects missing references', () => {
    const f = structuredClone(logisticsFixture); f.shipments[0].orderId = 'missing';
    expect(validateLogistics(f)).toContain('shipment-1: missing order');
  });
  it('rejects cross-organization relationships', () => {
    const f = structuredClone(logisticsFixture); f.vehicles[0].organizationId = 'org-b';
    expect(validateLogistics(f)).toContain('shipment-1: vehicle organization mismatch');
  });
  it('rejects duplicate entity IDs', () => {
    const f = structuredClone(logisticsFixture); f.vehicles[0].id = 'warehouse-1';
    expect(validateLogistics(f)).toContain('warehouse-1: duplicate id');
  });
  it('rejects unsupported states', () => {
    const f = structuredClone(logisticsFixture); f.orders[0].state = 'magic';
    expect(validateLogistics(f)).toContain('order-1: invalid state');
  });
});
