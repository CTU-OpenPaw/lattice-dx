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
  name: 'latticeAiMemory',
  title: 'Bộ nhớ Ngữ cảnh AI & Tổ chức DX-OS',
  titleField: 'memoryKey',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: false,
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', interface: 'input', allowNull: false, index: true },
    { name: 'agentId', type: 'string', interface: 'input', allowNull: true, index: true },
    { name: 'scope', type: 'string', interface: 'input', allowNull: false, defaultValue: 'org', index: true },
    { name: 'userId', type: 'string', interface: 'input', allowNull: true, index: true },
    { name: 'sessionId', type: 'string', interface: 'input', allowNull: true, index: true },
    { name: 'memoryKey', type: 'string', interface: 'input', allowNull: false, index: true },
    { name: 'content', type: 'text', interface: 'textarea', allowNull: false },
    { name: 'tagsJson', type: 'jsonb', defaultValue: [] },
    { name: 'metadataJson', type: 'jsonb', defaultValue: {} },
    { name: 'importance', type: 'float', interface: 'number', allowNull: false, defaultValue: 0.5 },
    { name: 'source', type: 'string', interface: 'input', defaultValue: 'agent' },
    { name: 'expiresAt', type: 'date', interface: 'datetime', allowNull: true },
    { name: 'createdById', type: 'string', interface: 'input', allowNull: true },
    { name: 'lastAccessedAt', type: 'date', interface: 'datetime', allowNull: true },
    { name: 'accessCount', type: 'integer', interface: 'integer', allowNull: false, defaultValue: 0 },
  ],
  indexes: [
    { name: 'idx_lattice_ai_memory_org_scope', fields: ['organizationId', 'scope'] },
    { name: 'idx_lattice_ai_memory_org_agent_scope', fields: ['organizationId', 'agentId', 'scope'] },
    { name: 'idx_lattice_ai_memory_org_user_scope', fields: ['organizationId', 'userId', 'scope'] },
    { name: 'idx_lattice_ai_memory_org_session_scope', fields: ['organizationId', 'sessionId', 'scope'] },
    { name: 'idx_lattice_ai_memory_org_key', fields: ['organizationId', 'memoryKey'] },
    { name: 'idx_lattice_ai_memory_expires', fields: ['expiresAt'] },
  ],
});
