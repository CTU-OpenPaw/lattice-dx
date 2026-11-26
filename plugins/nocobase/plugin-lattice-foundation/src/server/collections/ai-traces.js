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
  name: 'latticeAiTraces',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'uid', type: 'string', allowNull: false },
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'traceId', type: 'string', allowNull: false },
    { name: 'spanId', type: 'string', allowNull: false },
    { name: 'parentSpanId', type: 'string' },
    { name: 'runUid', type: 'string' },
    { name: 'operationName', type: 'string', allowNull: false, defaultValue: 'chat' },
    { name: 'genAiSystem', type: 'string', defaultValue: 'latticedx' },
    { name: 'model', type: 'string' },
    { name: 'agentName', type: 'string' },
    { name: 'toolName', type: 'string' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'ok' },
    { name: 'durationMs', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'inputTokens', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'outputTokens', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'totalTokens', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'piiRedactedCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'attributesJson', type: 'jsonb', defaultValue: {} },
    { name: 'startedAt', type: 'date', allowNull: false },
    { name: 'endedAt', type: 'date' },
    { name: 'errorMessage', type: 'text' },
  ],
  indexes: [
    { name: 'uidx_lattice_ai_traces_org_uid', fields: ['organizationId', 'uid'], unique: true },
    { name: 'idx_lattice_ai_traces_org_started', fields: ['organizationId', 'startedAt'] },
    { name: 'idx_lattice_ai_traces_org_trace', fields: ['organizationId', 'traceId', 'startedAt'] },
    { name: 'idx_lattice_ai_traces_org_run', fields: ['organizationId', 'runUid', 'startedAt'] },
    { name: 'idx_lattice_ai_traces_org_op_status', fields: ['organizationId', 'operationName', 'status'] },
  ],
});
