/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '../../../..');

test('all plugin migrations have unique timestamps and implement both up() and down()', () => {
  const pluginsDir = join(REPO_ROOT, 'plugins/nocobase');
  const entries = readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const seenTimestamps = new Map();
  let totalMigrations = 0;

  for (const dir of entries) {
    const migDir = join(pluginsDir, dir.name, 'src/server/migrations');
    let files = [];
    try {
      files = readdirSync(migDir).filter((f) => f.endsWith('.js')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      totalMigrations += 1;
      const match = file.match(/^(\d{14})-/);
      assert.ok(match, `Migration missing 14-digit timestamp prefix: ${dir.name}/${file}`);
      const ts = match[1];
      assert.equal(
        seenTimestamps.has(ts),
        false,
        `Duplicate migration timestamp ${ts}: ${file} vs ${seenTimestamps.get(ts)}`,
      );
      seenTimestamps.set(ts, `${dir.name}/${file}`);

      const content = readFileSync(join(migDir, file), 'utf8');
      assert.match(content, /\bup\s*\(/, `Migration missing up(): ${dir.name}/${file}`);
      assert.match(content, /\bdown\s*\(/, `Migration missing reversible down(): ${dir.name}/${file}`);
    }
  }
  assert.ok(totalMigrations >= 19, `Expected >= 19 plugin migrations (15 existing + 4 Wave 3), found ${totalMigrations}`);
});

test('tenant-scoped collections replace global code unique with composite (organizationId, code) and declare >=45 composite indexes', () => {
  const foundationSchemas = require('../src/server/schema');
  const integrationSchemas = require('../src/server/integration-schema');
  const paraSchema = require('../../plugin-dxos-para/src/server/schema');
  const studioSchema = require('../../plugin-dxos-studio/src/server/service-schema');
  const aiSchemas = require('../../plugin-dxos-ai/src/server/ai-schemas');

  const tenantCodeCollections = [
    ...Object.values(foundationSchemas),
    paraSchema.paraDocuments,
    studioSchema.serviceTickets,
  ];
  assert.equal(tenantCodeCollections.length, 10);

  for (const schema of tenantCodeCollections) {
    const codeField = schema.fields.find((f) => f.name === 'code');
    assert.ok(codeField, `${schema.name} missing code field`);
    assert.notEqual(codeField.unique, true, `${schema.name}.code must NOT be globally unique:true`);
    const hasCompositeCode = Array.isArray(schema.indexes) && schema.indexes.some(
      (idx) => idx.unique === true && Array.isArray(idx.fields) && idx.fields.join(',') === 'organizationId,code',
    );
    assert.equal(hasCompositeCode, true, `${schema.name} missing composite unique(organizationId, code) index`);
  }

  for (const versioned of [
    foundationSchemas.requests,
    foundationSchemas.orders,
    foundationSchemas.assets,
    paraSchema.paraDocuments,
    studioSchema.serviceTickets,
  ]) {
    assert.ok(versioned.fields.some((f) => f.name === 'version'), `${versioned.name} missing version column`);
  }

  const allSchemas = [
    ...tenantCodeCollections,
    ...Object.values(integrationSchemas),
    aiSchemas.aiProfiles,
    aiSchemas.aiAuditLogs,
    aiSchemas.uiSnapshots,
  ];
  const totalIndexes = allSchemas.reduce((sum, s) => sum + (Array.isArray(s.indexes) ? s.indexes.length : 0), 0);
  assert.ok(totalIndexes >= 42, `Expected >=42 declared indexes across schemas (plus context-outbox & uploads = >=45), got ${totalIndexes}`);

  const seenIndexNames = new Set();
  for (const schema of allSchemas) {
    for (const idx of schema.indexes || []) {
      assert.equal(typeof idx.name, 'string', `${schema.name} index [${idx.fields.join(',')}] missing explicit short name`);
      assert.match(idx.name, /^u?idx_lattice_[a-z0-9_]+$/, `Index ${idx.name} must use canonical u?idx_lattice_* naming`);
      assert.ok(idx.name.length <= 55, `Index name ${idx.name} (${idx.name.length} chars) risks Postgres 63-byte truncation`);
      assert.equal(seenIndexNames.has(idx.name), false, `Duplicate explicit index name: ${idx.name}`);
      seenIndexNames.add(idx.name);
    }
  }

  const outboxSrc = readFileSync(join(REPO_ROOT, 'plugins/nocobase/plugin-lattice-foundation/src/server/collections/context-outbox.js'), 'utf8');
  for (const idxName of ['idx_lattice_outbox_entity_id', 'idx_lattice_outbox_state_next_id', 'idx_lattice_outbox_org_state_created']) {
    assert.ok(outboxSrc.includes(idxName), `context-outbox.js missing explicit index name ${idxName}`);
    assert.ok(idxName.length <= 55);
  }

  const chatterSrc = readFileSync(join(REPO_ROOT, 'plugins/nocobase/plugin-lattice-foundation/src/server/collections/record-chatter.js'), 'utf8');
  for (const idxName of ['idx_lattice_chatter_org_target', 'idx_lattice_chatter_org_type', 'idx_lattice_chatter_org_author']) {
    assert.ok(chatterSrc.includes(idxName), `record-chatter.js missing explicit index name ${idxName}`);
    assert.ok(idxName.length <= 55);
  }
});
