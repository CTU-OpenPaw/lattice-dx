/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupWorkspaceDemo} from '../setup-native-workspace-demo.mjs';

const report = {origin:'http://localhost:13007', pageUrl:'http://localhost:13007/admin/lab'};
const setupId = async () => '08fc5b0f-1c14-46f6-b9ab-3c9db1ae1fa9';

test('a failed marker write resumes the same native demo without creating a second form', async () => {
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
  assert.equal(grants.size, 0);
  assert.equal(routes[1].options, undefined);
  const result = await setupWorkspaceDemo(api, report, setupId);
  assert.equal(result.formUrl, report.origin + '/admin/form');
  assert.deepEqual(await setupWorkspaceDemo(api, report, setupId), result);
  assert.equal(creates, 1);
  assert.equal(routes[1].title, 'Yêu cầu nội bộ');
  assert.deepEqual([...grants.values()], [[2,3,4],[2,3,4],[2,3,4]]);
});

test('a matching user-created application is preserved', async () => {
  const routes = [{id:1, title:'Native UI Lab', schemaUid:'lab'}, {id:2, type:'group', title:'Yêu cầu nội bộ'}];
  const api = async path => {
    assert.match(path, /^desktopRoutes:list/);
    return routes;
  };
  await assert.rejects(setupWorkspaceDemo(api, report, setupId), /configuration was preserved/);
});
