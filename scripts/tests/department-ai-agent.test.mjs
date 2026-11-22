/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_EMPLOYEE_USERNAME,
  DEFAULT_LLM_NAME,
  DEFAULT_WORKFLOW_TITLE,
  buildCreateTicketNodePayload,
  buildDepartmentAgentPayload,
  buildMaintenanceWorkflowPayload,
  parseDepartmentAgentArgs,
  resolveDepartmentTarget,
  setupDepartmentAiAgent,
} from '../setup-department-ai-agent.mjs';

test('parseDepartmentAgentArgs enforces valid lab origins and flags', () => {
  assert.throws(() => parseDepartmentAgentArgs([]), /Usage:/);
  assert.throws(() => parseDepartmentAgentArgs(['--origin=http://localhost:13014', '--unknown']), /Unknown option/);
  assert.throws(() => parseDepartmentAgentArgs(['--origin=http://localhost:13014', '--llm-url=not-a-url']), /Invalid --llm-url/);

  const parsed = parseDepartmentAgentArgs([
    '--origin=http://localhost:13014',
    '--workflow-only',
    '--skip-llm',
    '--model=ag/gemini-3.8-flash',
    '--org=acme-vn',
  ]);
  assert.equal(parsed.origin, 'http://localhost:13014');
  assert.equal(parsed.workflowOnly, true);
  assert.equal(parsed.skipLlm, true);
  assert.equal(parsed.model, 'ag/gemini-3.8-flash');
  assert.equal(parsed.organizationId, 'acme-vn');
});

test('resolveDepartmentTarget validates clean-install report format and port safety', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dept-agent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reportFile = join(dir, 'report.json');
  await writeFile(reportFile, JSON.stringify({
    format: 'latticedx.native-clean-install',
    complete: true,
    origin: 'http://localhost:13014/',
  }), 'utf8');

  const resolved = await resolveDepartmentTarget([reportFile]);
  assert.equal(resolved.origin, 'http://localhost:13014');
  await assert.rejects(
    () => resolveDepartmentTarget(['--origin=http://localhost:13000']),
    /Unsafe lab port/,
  );
});

test('workflow, node, and AI employee payload builders encode root $context bindings and autoCall workflow tool', () => {
  const wf = buildMaintenanceWorkflowPayload({ organizationId: 'org-a' });
  assert.equal(wf.type, 'ai-employee');
  assert.equal(wf.sync, true);
  const priorityParam = wf.config.parameters.find((p) => p.name === 'priority');
  assert.deepEqual(priorityParam.enumOptions, ['low', 'medium', 'high']);
  assert.equal(priorityParam.options.length, 3);

  const node = buildCreateTicketNodePayload({ organizationId: 'org-a' });
  assert.equal(node.config.collection, 'latticeServiceTickets');
  assert.equal(node.config.params.values.organizationId, 'org-a');
  assert.equal(node.config.params.values.code, '{{$context.code}}');

  const emp = buildDepartmentAgentPayload({ toolName: 'workflowCaller-abc123', model: 'ag/gemini-3.8-flash' });
  assert.equal(emp.username, DEFAULT_EMPLOYEE_USERNAME);
  assert.equal(emp.modelSettings.models[0].model, 'ag/gemini-3.8-flash');
  assert.deepEqual(emp.skillSettings.tools, [{ name: 'workflowCaller-abc123', autoCall: true }]);
});

test('setupDepartmentAiAgent provisions workflow, nodes, sync, and AI employee idempotently without storing secrets', async () => {
  const workflows = [];
  const tools = [];
  const employees = [];
  const llmServices = [];
  const apiCalls = [];

  async function mockApi(path, { method = 'GET', values } = {}) {
    apiCalls.push({ path, method });
    if (path.startsWith('workflows:list')) return workflows;
    if (path === 'workflows:create' && method === 'POST') {
      const wf = { id: 101, key: 'wfkey01', ...values };
      workflows.push(wf);
      return wf;
    }
    if (path === 'workflows/101/nodes:create' && method === 'POST') {
      return { id: values.key === 'createTicket' ? 201 : 202, ...values };
    }
    if (path === 'workflows:update?filterByTk=101' && method === 'POST') {
      Object.assign(workflows[0], values);
      return workflows[0];
    }
    if (path === 'workflows:sync?filterByTk=101' && method === 'POST') {
      tools.push({ from: 'workflow', definition: { name: 'workflowCaller-wfkey01' } });
      return { ok: true };
    }
    if (path.startsWith('aiTools:list')) return tools;
    if (path.startsWith('llmServices:list')) return llmServices;
    if (path.startsWith('aiEmployees:list')) return employees;
    if (path === 'aiEmployees:create' && method === 'POST') {
      employees.push(values);
      return values;
    }
    if (path.startsWith('aiEmployees:update') && method === 'POST') {
      Object.assign(employees[0], values);
      return employees[0];
    }
    throw new Error(`Unexpected API call: ${method} ${path}`);
  }

  const first = await setupDepartmentAiAgent(mockApi, { skipLlm: true, model: 'ag/gemini-3.8-flash' });
  assert.equal(first.result, 'PASS');
  assert.equal(first.workflow.created, true);
  assert.equal(first.workflow.toolName, 'workflowCaller-wfkey01');
  assert.equal(first.employee.created, true);
  assert.equal(employees.length, 1);

  const second = await setupDepartmentAiAgent(mockApi, { skipLlm: true, model: 'ag/gemini-3.8-flash' });
  assert.equal(second.workflow.created, false);
  assert.equal(second.employee.created, false);
  assert.equal(workflows.length, 1);
  assert.equal(employees.length, 1);
  assert.equal(llmServices.length, 0);
  assert.equal(DEFAULT_WORKFLOW_TITLE, 'Tạo Phiếu Bảo trì Kho lạnh');
  assert.equal(DEFAULT_LLM_NAME, 'local-9router');
});
