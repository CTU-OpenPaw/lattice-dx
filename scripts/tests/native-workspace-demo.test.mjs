// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {readOrCreateSetupId, setupWorkspaceDemo} from '../setup-native-workspace-demo.mjs';

const report = {origin:'http://localhost:13007', pageUrl:'http://localhost:13007/admin/lab'};
async function tempSetupPath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-demo-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  return join(directory, 'report.json.workspace-demo');
}

test('concurrent ID creation preserves one complete UUID and removes temporary writes', async t => {
  const path = await tempSetupPath(t);
  const ids = await Promise.all(Array.from({length:8}, () => readOrCreateSetupId(path)));
  assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(ids.every(id => id === ids[0]));
  assert.equal(await readFile(path, 'utf8'), ids[0]);
  assert.equal(await readOrCreateSetupId(path), ids[0]);
  assert.deepEqual(await readdir(join(path, '..')), ['report.json.workspace-demo']);
});

test('invalid IDs already on disk are preserved for investigation', async t => {
  const path = await tempSetupPath(t);
  for (const original of ['', '08fc5b0f-1c14', '-'.repeat(36)]) {
    await writeFile(path, original);
    await assert.rejects(readOrCreateSetupId(path), /Invalid demo setup identifier/);
    assert.equal(await readFile(path, 'utf8'), original);
  }
});

test('a failed marker write resumes the same native demo without creating a second form', async t => {
  const path = await tempSetupPath(t);
  const abandoned = path + '.interrupted.tmp';
  await writeFile(abandoned, '08fc5b0f-1c14');
  const setupId = () => readOrCreateSetupId(path);
  const routes = [{id:1, title:'Native UI Lab', schemaUid:'lab'}];
  const grants = new Map();
  let creates = 0;
  let failUpdate = true;
  async function api(path, values) {
    if (path.startsWith('desktopRoutes:list')) return structuredClone(routes);
    if (path === 'flowSurfaces:applyBlueprint') {
      creates++;
      routes.push({id:2, type:'group', title:values.navigation.group.title},
        {id:3, parentId:2, type:'flowPage', schemaUid:'form', title:values.page.title},
        {id:4, parentId:3, type:'tabs'});
      return {target:{pageSchemaUid:'form'}};
    }
    if (path === 'desktopRoutes:update?filterByTk=2') {
      if (failUpdate) {
        failUpdate = false;
        throw Error('HTTP 503');
      }
      Object.assign(routes[1], values);
      return;
    }
    assert.match(path, /^roles\/ldx_(employee|manager|warehouse)\/desktopRoutes:add$/);
    grants.set(path, values.tk);
  }
  await assert.rejects(setupWorkspaceDemo(api, report, setupId), /HTTP 503/);
  const persistedId = await readFile(path, 'utf8');
  assert.ok(routes[1].title.endsWith(persistedId));
  assert.equal(await readFile(abandoned, 'utf8'), '08fc5b0f-1c14');
  assert.equal(grants.size, 0);
  assert.equal(routes[1].options, undefined);
  const result = await setupWorkspaceDemo(api, report, setupId);
  assert.equal(result.formUrl, report.origin + '/admin/form');
  assert.deepEqual(await setupWorkspaceDemo(api, report, setupId), result);
  assert.equal(creates, 1);
  assert.equal(await readFile(path, 'utf8'), persistedId);
  assert.equal(routes[1].title, 'Yêu cầu nội bộ');
  assert.deepEqual([...grants.values()], [[2,3,4],[2,3,4],[2,3,4]]);
});

test('a matching user-created application is preserved', async () => {
  const routes = [{id:1, title:'Native UI Lab', schemaUid:'lab'}, {id:2, type:'group', title:'Yêu cầu nội bộ'}];
  const api = async path => {
    assert.match(path, /^desktopRoutes:list/);
    return routes;
  };
  await assert.rejects(setupWorkspaceDemo(api, report, () => assert.fail('The existing group must not create an ID')),
    /configuration was preserved/);
});
