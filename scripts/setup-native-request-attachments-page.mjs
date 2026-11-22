/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const origin = new URL(process.env.NOCOBASE_URL ?? 'http://localhost:13001');
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Local setup only');
const token = process.env.NOCOBASE_TOKEN;
assert(token, 'Set NOCOBASE_TOKEN to the root token for this lab');
const organization = process.env.DX_NATIVE_ATTACHMENT_SUBMIT_ORGANIZATION ?? 'native-attachment-submit-lab';
assert(/^[A-Za-z0-9_-]{1,80}$/.test(organization), 'Invalid lab organization');
const source = await readFile(new URL('./fixtures/native-request-attachments-form.jsx', import.meta.url), 'utf8');
const code = 'const attachmentOrganization = ' + JSON.stringify(organization) + ';\n' + source;

async function api(path, body) {
  const response = await fetch(new URL('/api/' + path, origin), {
    headers: { Authorization: 'Bearer ' + token, 'X-Role': 'root', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  assert(response.ok, `${path} HTTP ${response.status}: ${JSON.stringify(result.errors)}`);
  return result.data ?? result;
}

if (process.env.DX_ATTACHMENT_FORM_BLOCK_UID) {
  await api('flowSurfaces:configure', { target: { uid: process.env.DX_ATTACHMENT_FORM_BLOCK_UID }, changes: { code } });
  console.log(JSON.stringify({ updatedBlock: process.env.DX_ATTACHMENT_FORM_BLOCK_UID }));
} else {
  const title = 'Yêu cầu có đính kèm';
  const filter = encodeURIComponent(JSON.stringify({ title }));
  const existing = await api('desktopRoutes:list?filter=' + filter);
  assert.equal(existing.length, 0, 'Page already exists. Use DX_ATTACHMENT_FORM_BLOCK_UID to update its block.');
  const page = await api('flowSurfaces:applyBlueprint', {
    version: '1', mode: 'create',
    navigation: { item: { title, icon: 'FileTextOutlined' } },
    page: { title, displayTitle: true, enableTabs: false },
    tabs: [{ title: 'Yêu cầu', blocks: [{ key: 'request-attachments', type: 'jsBlock', title: 'Yêu cầu và tệp', script: 'attachments' }] }],
    assets: { scripts: { attachments: { code } } },
  });
  const routeId = page.surface.tree.props.routeId;
  const tabId = page.surface.tree.subModels.tabs[0].props.route.id;
  for (const role of ['ldx_employee', 'ldx_manager', 'ldx_warehouse']) {
    await api('roles/' + role + '/desktopRoutes:add', { tk: [routeId, tabId] });
  }
  console.log(JSON.stringify({ pageUid: page.target.pageSchemaUid, routeId, tabId }));
}
