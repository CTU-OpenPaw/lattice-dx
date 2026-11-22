/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dockerContextArgs } from './lib/docker-context.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'http://localhost:8080';
const tokens = {};
for (const username of ['alice', 'warehouse', 'bob']) {
  const response = await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'dx-local', username, password: `local-${username}-password` }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `Login ${username}`);
  tokens[username] = (await response.json()).access_token;
}
async function call(path, method = 'POST', body, expected = 200, actor = 'alice') {
  const response = await fetch(base + path, {
    method, headers: { authorization: `Bearer ${tokens[actor]}`, 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${actor} ${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
const suffix = randomUUID().replaceAll('-', '');
function definition(id, title) {
  return { id, title, startRole: 'employee', initialState: 'draft', startFields: { request: 'text' }, readerRoles: [],
    transitions: [{ id: 'submit', from: 'draft', to: 'completed', role: 'employee', ownerOnly: true, fields: {} }] };
}
const originals = [definition('bundle-hr-' + suffix, 'Employee intake template'), definition('bundle-purchase-' + suffix, 'Purchase intake template')];
for (const item of originals) {
  await call('/v1/workflow-drafts', 'POST', { definition: item }, 201);
  await call(`/v1/workflow-drafts/${item.id}/publish`, 'POST', { expectedRevision: 1 });
}
await call(`/v1/workflow-drafts/${originals[0].id}`, 'PUT', {
  expectedRevision: 1, definition: { ...originals[0], title: 'Changed v2', startFields: { request: 'text', costCenter: 'text' } },
});
await call(`/v1/workflow-drafts/${originals[0].id}/publish`, 'POST', { expectedRevision: 2 });
const exported = await call('/v1/workflow-bundles/export', 'POST', { definitions: originals.map(d => ({ id: d.id, version: 1 })) });
assert.equal(exported.format, 'latticedx.workflow-bundle');
assert.equal(exported.formatVersion, 1);
assert.deepEqual(exported.definitions, originals);
assert.deepEqual(Object.keys(exported).sort(), ['definitions', 'format', 'formatVersion']);
assert.ok(exported.definitions.every(d => !Object.hasOwn(d, 'version') && !Object.hasOwn(d, 'organizationId')));
await call('/v1/workflow-bundles/export', 'POST', { definitions: [{ id: originals[0].id, version: 99 }] }, 404);
await call('/v1/workflow-bundles/validate', 'POST', { bundle: exported }, 403, 'warehouse');
await call('/v1/workflow-bundles/export', 'POST', { definitions: [{ id: originals[0].id, version: 1 }] }, 403, 'bob');
await call('/v1/workflow-bundles/import', 'POST', { bundle: exported, organizationId: 'org-b' }, 400);
const bundle = { ...exported, definitions: exported.definitions.map(d => ({ ...d, id: d.id + '-copy' })) };
const preview = await call('/v1/workflow-bundles/validate', 'POST', { bundle });
assert.equal(preview.workflowCount, 2);
assert.deepEqual(preview.definitions.map(d => d.id), bundle.definitions.map(d => d.id));
for (const item of bundle.definitions) await call(`/v1/workflow-drafts/${item.id}`, 'GET', undefined, 404);
const imported = await call('/v1/workflow-bundles/import', 'POST', { bundle }, 201);
assert.equal(imported.items.length, 2);
assert.ok(imported.items.every(d => d.revision === 1));
assert.ok(!(await call('/v1/workflow-definitions', 'GET')).items.some(d => d.id === bundle.definitions[0].id));
await call('/v1/workflows', 'POST', { definitionId: bundle.definitions[0].id, title: 'Cannot start draft', input: { request: 'Demo' } }, 400);
await call('/v1/workflow-bundles/import', 'POST', { bundle }, 409);
const fresh = definition('bundle-rollback-' + suffix, 'Must not survive collision');
await call('/v1/workflow-bundles/import', 'POST', { bundle: { ...bundle, definitions: [fresh, bundle.definitions[1]] } }, 409);
await call(`/v1/workflow-drafts/${fresh.id}`, 'GET', undefined, 404);
await call(`/v1/workflow-drafts/${bundle.definitions[0].id}/publish`, 'POST', { expectedRevision: 1 });
const run = await call('/v1/workflows', 'POST', { definitionId: bundle.definitions[0].id, title: 'Imported configuration runtime demo', input: { request: 'Reviewed by destination designer' } }, 201);
const completed = await call(`/v1/workflows/${run.id}/transitions`, 'POST', { action: 'submit', expectedVersion: 1, input: {} });
assert.equal(completed.state, 'completed');
assert.equal(completed.definitionVersion, 1);

// Real database atomicity and tenant isolation use only a generated private schema.
const sqlSource = `
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {definitionDatabase} from './src/workflows/registry-database.ts';
import {parseBundle} from './src/workflows/bundles.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='bundle_smoke_'+randomUUID().replaceAll('-','');
 let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});
  const registry=await definitionDatabase(pool);
  const a={subject:'source-designer',organizationId:'source-unit',roles:['workflow:design']};
  const b={subject:'destination-designer',organizationId:'destination-unit',roles:['workflow:design']};
  const first=${JSON.stringify(definition('intake-one', 'Original configuration'))};
  const second={...first,id:'intake-two'};
  await registry.create(first,a);await registry.publish(first.id,1,a);
  await assert.rejects(()=>registry.getDraft(first.id,b),e=>e.statusCode===404);
  assert.equal(await registry.get(b.organizationId,first.id,1),undefined);
  const published=await registry.get(a.organizationId,first.id,1);
  const {version,...configuration}=published;
  const bundle=parseBundle({format:'latticedx.workflow-bundle',formatVersion:1,definitions:[configuration,second]});
  const imported=await registry.createMany(bundle.definitions,b);
  assert.equal(imported.length,2);
  assert.ok(imported.every(d=>d.createdBy===b.subject&&d.updatedBy===b.subject&&d.revision===1));
  assert.equal(await registry.get(b.organizationId,first.id),undefined);
  assert.equal((await registry.publish(first.id,1,b)).version,1);
  await registry.updateDraft(first.id,1,{...first,title:'Changed destination'},b);
  assert.equal((await registry.getDraft(first.id,a)).definition.title,'Original configuration');
  assert.equal((await registry.getDraft(first.id,b)).definition.title,'Changed destination');
  await assert.rejects(()=>registry.createMany([{...first,id:'aaa-rollback'},second],b),e=>e.statusCode===409);
  await assert.rejects(()=>registry.getDraft('aaa-rollback',b),e=>e.statusCode===404);
  // Recreate a max-1 pool to verify persisted drafts, then use two connections for a real write race.
  await pool.end();
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});
  const singleConnection=await definitionDatabase(pool);
  assert.equal((await singleConnection.getDraft(first.id,b)).revision,2);
  await pool.end();
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:2,connectionTimeoutMillis:5000});
  const concurrentRegistry=await definitionDatabase(pool);
  const concurrent=[{...first,id:'race-one'},{...second,id:'race-two'}];
  const results=await Promise.allSettled([concurrentRegistry.createMany(concurrent,b),concurrentRegistry.createMany([...concurrent].reverse(),b)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);
  assert.equal((await concurrentRegistry.listDrafts(b,{limit:100,offset:0,q:''})).items.length,4);
  const reconnected=await definitionDatabase(pool);
  assert.equal((await reconnected.getDraft('race-one',b)).revision,1);
  console.log('Bundle SQL passed: destination actor/tenant, unpublished drafts, isolated edits, late collision rollback, reversed-order concurrent imports and reconnect with pool max 1.');
 }finally{
  await pool?.end();
  if(!/^bundle_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe smoke schema');
  await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
console.log(execFileSync('docker', [...dockerContextArgs(), 'compose', '-f', 'infra/compose/core.yml', 'exec', '-T', '-w', '/app/apps/api', 'api', 'pnpm', 'exec', 'tsx', '--eval', sqlSource], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 }).trim());
console.log('Workflow bundle smoke passed: explicit published version export, preview without writes, designer permissions, atomic draft import, conflicts and explicit publish before execution.');
console.log(JSON.stringify({ importedDefinitionIds: bundle.definitions.map(d => d.id), completedRun: completed.id, note: 'Retained local demo drafts and workflow' }));
