/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Explicit loopback-only fixtures. Adds membership/references; never removes data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const username of ['alice','bob','manager','warehouse','warehouse2','hr-demo','it-demo','administration','receiver']) {
  const login=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});
  assert.equal(login.status,200,`Fixture login ${username}; run local realm sync first`);
  const {access_token}=await login.json();
  const response=await fetch('http://localhost:8080/v1/workflow-members/me',{method:'POST',headers:{authorization:`Bearer ${access_token}`,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,`Self-registration ${username}`);
}
const sql=`INSERT INTO workflow_references(organization_id,kind,id,name) VALUES
('org-a','department','warehouse','Warehouse'),('org-a','department','it','IT'),
('org-a','department','hr','HR'),('org-a','department','administration','Administration'),
('org-a','location','office-1','Office 1'),('org-b','department','warehouse','Warehouse B'),
('org-b','location','office-1','Office B') ON CONFLICT DO NOTHING;`;
execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','postgres','psql','-U','lattice','-d','lattice','-v','ON_ERROR_STOP=1','-c',sql],{cwd:root,stdio:['ignore','pipe','pipe']});
console.log('Workflow demo members and scoped department/location references added; existing data retained.');
