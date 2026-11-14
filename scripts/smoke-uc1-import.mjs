/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const identity = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';

console.log('=== Step 5 Verification: UC1 Package Import & Full Workflow Run ===');

// 1. Verify Manifest and Tarball Integrity
console.log('--- 1. Verifying Package & Tarball Integrity ---');
const manifestFile = resolve(root, 'output/packages/uc1-package-manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));

const tarballPath = resolve(root, 'output/packages', manifest.tarball.filename);
const tarballBytes = await readFile(tarballPath);
const computedSha = createHash('sha256').update(tarballBytes).digest('hex');
assert.equal(computedSha, manifest.tarball.sha256, 'Tarball SHA-256 must match manifest');
assert.equal(tarballBytes.length, manifest.tarball.size, 'Tarball size must match manifest');
console.log(`✔ Tarball integrity verified (${manifest.tarball.filename}, SHA: ${computedSha.substring(0, 16)}...)`);

// Extract tarball to temporary folder to verify bundle extraction
const tempDir = await mkdtemp(join(tmpdir(), 'latticedx-uc1-import-'));
try {
  execFileSync('tar', ['-zxf', tarballPath, '-C', tempDir], { windowsHide: true });
  const extractedBundlePath = join(tempDir, 'package/manifests/workflow-bundle.json');
  const bundleContent = JSON.parse(await readFile(extractedBundlePath, 'utf8'));
  assert.equal(bundleContent.format, 'latticedx.workflow-bundle');
  assert.equal(bundleContent.definitions[0].id, 'procurement-bundle-v1');
  console.log('✔ Tarball successfully extracted and workflow-bundle.json parsed.');

  // 2. Obtain tokens for actors
  console.log('--- 2. Authenticating Actors via Keycloak ---');
  async function token(username, password) {
    const response = await fetch(`${identity}/realms/lattice/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'dx-local',
        username,
        password
      }),
      signal: AbortSignal.timeout(10000)
    });
    assert.equal(response.status, 200, `Login ${username} must succeed`);
    const data = await response.json();
    const sub = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url').toString()).sub;
    return { token: data.access_token, subject: sub };
  }

  const actors = {
    alice: await token('alice', 'local-alice-password'),
    manager: await token('manager', 'local-manager-password'),
    warehouse: await token('warehouse', 'local-warehouse-password'),
    receiver: await token('receiver', 'local-receiver-password')
  };
  console.log('✔ Actors authenticated (alice, manager, warehouse, receiver).');

  async function api(path, actor = 'alice', method = 'GET', body, expected = 200, extraHeaders = {}) {
    const headers = {
      authorization: `Bearer ${actors[actor].token}`,
      'content-type': 'application/json',
      ...extraHeaders
    };
    const options = {
      method,
      headers,
      signal: AbortSignal.timeout(30000)
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(`${gateway}${path}`, options);
    assert.equal(response.status, expected, `${actor} ${method} ${path}: expected ${expected}, got ${response.status}`);
    return response.json();
  }

  // 3. Validate Workflow Bundle via API
  console.log('--- 3. Validating Bundle via APISIX Gateway ---');
  const preview = await api('/v1/workflow-bundles/validate', 'alice', 'POST', { bundle: bundleContent });
  assert.equal(preview.workflowCount, 1);
  assert.equal(preview.definitions[0].id, 'procurement-bundle-v1');
  console.log(`✔ Bundle validated via Gateway API (${preview.definitions[0].title}).`);

  // 4. Import & Publish Definition
  console.log('--- 4. Importing & Publishing Workflow Definition ---');
  let draft;
  // Check if draft already exists
  const existingDraftRes = await fetch(`${gateway}/v1/workflow-drafts/procurement-bundle-v1`, {
    headers: { authorization: `Bearer ${actors.alice.token}` }
  });
  if (existingDraftRes.status === 200) {
    draft = await existingDraftRes.json();
    console.log(`ℹ Draft 'procurement-bundle-v1' already exists at revision ${draft.revision}.`);
  } else {
    const importRes = await api('/v1/workflow-bundles/import', 'alice', 'POST', { bundle: bundleContent }, 201);
    draft = importRes.items[0];
    console.log(`✔ Draft 'procurement-bundle-v1' imported (revision ${draft.revision}).`);
  }

  // Publish definition
  const published = await api(
    `/v1/workflow-drafts/${draft.id}/publish`,
    'alice',
    'POST',
    { expectedRevision: draft.revision }
  );
  assert.equal(published.id, 'procurement-bundle-v1');
  console.log(`✔ Definition '${published.id}' published at version ${published.version}.`);

  // Verify definition appears in workflow definitions list
  const defs = await api('/v1/workflow-definitions', 'alice');
  assert.ok(defs.items.some(d => d.id === 'procurement-bundle-v1'), 'Published definition must be in list');
  console.log('✔ Definition verified in available workflow definitions.');

  // 5. Execute Full Workflow Run on the Imported Definition
  console.log('--- 5. Executing Workflow Run on Imported Definition ---');
  const runKey = randomUUID();
  const runTitle = `Yêu cầu thiết bị UC1 Import - ${Date.now()}`;
  let run = await api('/v1/workflows', 'alice', 'POST', {
    definitionId: 'procurement-bundle-v1',
    title: runTitle,
    input: {}
  }, 201, { 'Idempotency-Key': runKey });
  assert.equal(run.state, 'draft');
  assert.equal(run.version, 1);
  console.log(`✔ Step A: Workflow run created (id: ${run.id}, state: ${run.state}).`);

  // Alice submits
  run = await api(`/v1/workflows/${run.id}/transitions`, 'alice', 'POST', {
    action: 'submit',
    expectedVersion: run.version,
    input: {}
  }, 200, { 'Idempotency-Key': randomUUID() });
  assert.equal(run.state, 'submitted');
  console.log(`✔ Step B: Submitted by employee (state: ${run.state}).`);

  // Manager approves
  const managerInbox = await api('/v1/workflows?inbox=true', 'manager');
  assert.ok(managerInbox.items.some(r => r.id === run.id), 'Must appear in manager inbox');

  run = await api(`/v1/workflows/${run.id}/transitions`, 'manager', 'POST', {
    action: 'approve',
    expectedVersion: run.version,
    input: {}
  }, 200, { 'Idempotency-Key': randomUUID() });
  assert.equal(run.state, 'approved');
  console.log(`✔ Step C: Approved by procurement manager (state: ${run.state}).`);

  // Warehouse uploads receipt file
  const uploadRes = await api('/v1/files', 'warehouse', 'POST', {
    filename: 'bien-ban-giao-hang.txt',
    contentBase64: Buffer.from('Biên bản giao hàng hợp lệ - mã thiết bị TS-2026-001').toString('base64')
  }, 201);
  assert.equal(uploadRes.scanStatus, 'clean');
  console.log(`✔ Uploaded clean delivery receipt (fileId: ${uploadRes.id}).`);

  // Warehouse receives goods
  run = await api(`/v1/workflows/${run.id}/transitions`, 'warehouse', 'POST', {
    action: 'receive',
    expectedVersion: run.version,
    input: { receiptAttachmentId: uploadRes.id }
  }, 200, { 'Idempotency-Key': randomUUID() });
  assert.equal(run.state, 'received');
  console.log(`✔ Step D: Received by warehouse (state: ${run.state}).`);

  // Warehouse accepts goods
  run = await api(`/v1/workflows/${run.id}/transitions`, 'warehouse', 'POST', {
    action: 'accept',
    expectedVersion: run.version,
    input: { acceptanceNote: 'Đã kiểm đếm đầy đủ số lượng và thông số kỹ thuật' }
  }, 200, { 'Idempotency-Key': randomUUID() });
  assert.equal(run.state, 'accepted');
  console.log(`✔ Step E: Accepted by warehouse (state: ${run.state}).`);

  // Warehouse handovers asset
  const handoverData = {
    assetId: `urn:ngsi-ld:Asset:TS-${Date.now()}`,
    recipientId: actors.receiver.subject,
    departmentId: 'warehouse',
    locationId: 'office-1',
    attachmentId: uploadRes.id
  };
  run = await api(`/v1/workflows/${run.id}/transitions`, 'warehouse', 'POST', {
    action: 'handover',
    expectedVersion: run.version,
    input: handoverData
  }, 200, { 'Idempotency-Key': randomUUID() });
  assert.equal(run.state, 'handed_over');
  console.log(`✔ Step F: Handed over asset to recipient (state: ${run.state}).`);

  // Verify sync status job
  const syncJobs = await api(`/v1/workflows/${run.id}/sync`, 'manager');
  assert.ok(syncJobs.items.length >= 1, 'Sync job must be created');
  console.log(`✔ Step G: Sync job registered (status: ${syncJobs.items[0].status}).`);

  // Verify audit history
  const audit = await api(`/v1/workflows/${run.id}/history`, 'alice');
  const expectedStates = ['draft', 'submitted', 'approved', 'received', 'accepted', 'handed_over'];
  assert.equal(audit.items.length, expectedStates.length);
  for (let i = 0; i < audit.items.length; i++) {
    assert.equal(audit.items[i].toState, expectedStates[i]);
  }
  console.log(`✔ Step H: Full audit history verified (${audit.items.length} transitions).`);

  console.log('================================================================');
  console.log('✔ SUCCESS: UC1 Package import & end-to-end lifecycle verified!  ');
  console.log('================================================================');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
