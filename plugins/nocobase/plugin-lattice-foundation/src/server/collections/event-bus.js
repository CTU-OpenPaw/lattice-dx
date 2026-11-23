/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

module.exports = require('@nocobase/database').defineCollection({
  name: 'latticeEventBus',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'eventId', type: 'string', allowNull: false },
    { name: 'eventType', type: 'string', allowNull: false },
    { name: 'source', type: 'string', allowNull: false },
    { name: 'subject', type: 'string' },
    { name: 'specVersion', type: 'string', allowNull: false, defaultValue: '1.0' },
    { name: 'correlationId', type: 'string' },
    { name: 'causationId', type: 'string' },
    { name: 'depth', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'payloadJson', type: 'jsonb', allowNull: false },
    { name: 'occurredAt', type: 'date', allowNull: false },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'queued' },
  ],
  indexes: [
    { name: 'uidx_lattice_events_event_id', fields: ['eventId'], unique: true },
    { name: 'idx_lattice_events_org_occurred', fields: ['organizationId', 'occurredAt'] },
    { name: 'idx_lattice_events_org_type', fields: ['organizationId', 'eventType', 'occurredAt'] },
  ],
});
