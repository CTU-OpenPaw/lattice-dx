/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
const base = process.env.NOCOBASE_URL ?? 'http://localhost:13000';
let response;
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    response = await fetch(`${base}/api/app:getLang`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) break;
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(response, 'NocoBase did not respond before readiness deadline');
assert.equal(response.status, 200, 'NocoBase public metadata API must respond');
assert.match(response.headers.get('content-type') ?? '', /json/);
await response.json();
const page = await fetch(base, { signal: AbortSignal.timeout(10000) });
assert.equal(page.status, 200, 'NocoBase frontend must be served');
assert.match(await page.text(), /<html/i);
console.log('NocoBase smoke passed: metadata API and frontend. No SSO/plugin assertion.');
