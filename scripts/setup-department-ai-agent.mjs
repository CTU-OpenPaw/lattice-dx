/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeLabOrigin,
  createRootApiClient,
} from './setup-native-multi-portal-demo.mjs';

export const DEFAULT_WORKFLOW_TITLE = 'Tạo Phiếu Bảo trì Kho lạnh';
export const DEFAULT_ORG_ID = 'native-ui-lab';
export const DEFAULT_LLM_NAME = 'local-9router';
export const DEFAULT_LLM_BASE_URL = 'http://host.docker.internal:20128/v1';
export const DEFAULT_LLM_MODEL = 'combo';
export const DEFAULT_EMPLOYEE_USERNAME = 'kho-lanh-ops';

export function parseDepartmentAgentArgs(argv) {
  let reportPath = null;
  let origin = null;
  let llmBaseUrl = DEFAULT_LLM_BASE_URL;
  let model = DEFAULT_LLM_MODEL;
  let organizationId = DEFAULT_ORG_ID;
  let workflowOnly = false;
  let skipLlm = false;

  for (const arg of argv) {
    if (arg === '--workflow-only') workflowOnly = true;
    else if (arg === '--skip-llm') skipLlm = true;
    else if (arg.startsWith('--origin=')) {
      if (origin !== null) throw new Error('Duplicate --origin argument');
      origin = arg.slice('--origin='.length);
    } else if (arg.startsWith('--llm-url=')) {
      llmBaseUrl = arg.slice('--llm-url='.length);
    } else if (arg.startsWith('--model=')) {
      model = arg.slice('--model='.length);
    } else if (arg.startsWith('--org=')) {
      organizationId = arg.slice('--org='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      if (reportPath !== null) throw new Error('Multiple report paths provided');
      reportPath = arg;
    }
  }

  if (!reportPath && !origin) {
    throw new Error(
      'Usage: node scripts/setup-department-ai-agent.mjs <clean-install report.json> | --origin=http://localhost:13014 [--workflow-only] [--skip-llm] [--llm-url=http://host.docker.internal:20128/v1] [--model=combo] [--org=native-ui-lab]',
    );
  }
  if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(llmBaseUrl)) {
    throw new Error(`Invalid --llm-url "${llmBaseUrl}"`);
  }
  if (!organizationId.trim()) {
    throw new Error('Organization ID (--org) cannot be empty');
  }
  if (!model.trim()) {
    throw new Error('Model name (--model) cannot be empty');
  }

  return {
    reportPath,
    origin,
    llmBaseUrl,
    model: model.trim(),
    organizationId: organizationId.trim(),
    workflowOnly,
    skipLlm,
  };
}

export async function resolveDepartmentTarget(argv) {
  const opts = parseDepartmentAgentArgs(argv);
  let targetOrigin = opts.origin;
  if (opts.reportPath) {
    const report = JSON.parse(await readFile(resolve(opts.reportPath), 'utf8'));
    if (report?.format !== 'latticedx.native-clean-install' || report?.complete !== true) {
      throw new Error('Invalid clean-install report: expected format "latticedx.native-clean-install" with complete === true');
    }
    const reportOrigin = assertSafeLabOrigin(report.origin);
    if (targetOrigin && assertSafeLabOrigin(targetOrigin) !== reportOrigin) {
      throw new Error('Supplied --origin does not match clean-install report origin');
    }
    targetOrigin = reportOrigin;
  }
  return { ...opts, origin: assertSafeLabOrigin(targetOrigin) };
}

export function buildMaintenanceWorkflowPayload({
  title = DEFAULT_WORKFLOW_TITLE,
  organizationId = DEFAULT_ORG_ID,
} = {}) {
  return {
    title,
    description: `Tạo mới một phiếu bảo trì thiết bị kho lạnh trong bảng latticeServiceTickets cho tổ chức ${organizationId}.`,
    type: 'ai-employee',
    sync: true,
    current: true,
    enabled: false,
    config: {
      parameters: [
        { name: 'code', type: 'string', description: 'Mã phiếu bảo trì, ví dụ SRV-AI-2026-01', required: true },
        { name: 'name', type: 'string', description: 'Tiêu đề ngắn mô tả công việc kiểm tra bảo trì', required: true },
        {
          name: 'priority',
          type: 'enum',
          description: 'Độ ưu tiên: low, medium hoặc high',
          enumOptions: ['low', 'medium', 'high'],
          options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
          required: true,
        },
        { name: 'description', type: 'string', description: 'Mô tả chi tiết bổ sung (tùy chọn)', required: false },
      ],
    },
  };
}

export function buildCreateTicketNodePayload({ organizationId = DEFAULT_ORG_ID } = {}) {
  // AIEmployeeTrigger exposes tool arguments at the root of execution.context ($context.<param>).
  return {
    type: 'create',
    key: 'createTicket',
    title: 'Tạo bản ghi Phiếu dịch vụ',
    config: {
      collection: 'latticeServiceTickets',
      params: {
        values: {
          organizationId,
          serviceType: 'facilities',
          status: 'open',
          code: '{{$context.code}}',
          name: '{{$context.name}}',
          priority: '{{$context.priority}}',
          description: '{{$context.description}}',
        },
      },
    },
  };
}

export function buildDepartmentAgentPayload({
  toolName,
  workflowTitle = DEFAULT_WORKFLOW_TITLE,
  organizationId = DEFAULT_ORG_ID,
  llmService = DEFAULT_LLM_NAME,
  model = DEFAULT_LLM_MODEL,
} = {}) {
  if (!toolName) throw new Error('toolName is required to build AI employee payload');
  return {
    username: DEFAULT_EMPLOYEE_USERNAME,
    nickname: 'Chuyên viên Kho lạnh AI',
    position: 'Kỹ sư AI Phòng Kho lạnh',
    avatar: 'nocobase-001-male',
    enabled: true,
    category: 'business',
    bio: 'Trợ lý AI chuyên trách vận hành kho lạnh, tra cứu hồ sơ dịch vụ và lập phiếu bảo trì trực tiếp vào CSDL.',
    greeting: 'Xin chào! Tôi là Chuyên viên Kho lạnh AI. Hãy giao nhiệm vụ kiểm tra hoặc tạo phiếu bảo trì kho lạnh cho tôi.',
    about: [
      `Bạn là Chuyên viên Kho lạnh AI của LatticeDX (tổ chức ${organizationId}).`,
      'Khi được yêu cầu kiểm tra phiếu dịch vụ hoặc lập phiếu bảo trì kho lạnh:',
      '1. Gọi tool getSkill(skillName="data-query") hoặc dataSourceQuery để kiểm tra bảng latticeServiceTickets (dataSource: "main") nếu cần.',
      `2. Khi được yêu cầu tạo phiếu bảo trì mới, hãy gọi tool workflowCaller tương ứng '${workflowTitle}' với đầy đủ tham số code, name, priority (low/medium/high), và description.`,
      '3. Trả lời bằng tiếng Việt ngắn gọn kèm mã phiếu và ID bản ghi trả về từ tool.',
    ].join('\n'),
    modelSettings: {
      enabled: true,
      models: [{ llmService, model }],
    },
    skillSettings: {
      skills: ['data-metadata', 'data-query'],
      tools: [{ name: toolName, autoCall: true }],
    },
  };
}

function normalizeRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  return Array.isArray(data?.items) ? data.items : [];
}

export async function ensureMaintenanceAiWorkflow(api, {
  title = DEFAULT_WORKFLOW_TITLE,
  organizationId = DEFAULT_ORG_ID,
} = {}) {
  const workflows = normalizeRows(await api('workflows:list?pageSize=100'));
  const existing = workflows.find(
    (w) => w.title === title && w.type === 'ai-employee' && w.sync === true,
  );
  if (existing) {
    if (!existing.enabled) {
      await api(`workflows:update?filterByTk=${existing.id}`, {
        method: 'POST',
        values: { enabled: true },
      });
    }
    try {
      await api(`workflows:sync?filterByTk=${existing.id}`, { method: 'POST', values: {} });
    } catch {
      // Older minor builds may auto-sync without an explicit workflows:sync action.
    }
    return {
      workflowId: existing.id,
      workflowKey: existing.key,
      toolName: `workflowCaller-${existing.key}`,
      created: false,
    };
  }

  const createdWf = await api('workflows:create', {
    method: 'POST',
    values: buildMaintenanceWorkflowPayload({ title, organizationId }),
  });
  const node1 = await api(`workflows/${createdWf.id}/nodes:create`, {
    method: 'POST',
    values: buildCreateTicketNodePayload({ organizationId }),
  });
  await api(`workflows/${createdWf.id}/nodes:create`, {
    method: 'POST',
    values: {
      type: 'output',
      key: 'outputTicket',
      title: 'Trả kết quả phiếu vừa tạo',
      upstreamId: node1.id,
      config: { value: '{{$jobsMapByNodeKey.createTicket}}' },
    },
  });
  await api(`workflows:update?filterByTk=${createdWf.id}`, {
    method: 'POST',
    values: { enabled: true },
  });
  try {
    await api(`workflows:sync?filterByTk=${createdWf.id}`, { method: 'POST', values: {} });
  } catch {
    // Non-fatal if host already registered the enabled workflow synchronously.
  }

  const toolName = `workflowCaller-${createdWf.key}`;
  const tools = normalizeRows(await api('aiTools:list?pageSize=200'));
  const registered = tools.some((t) => t.from === 'workflow' && t.definition?.name === toolName);
  if (!registered) {
    throw new Error(`Expected ${toolName} to appear in aiTools:list after enabling AI workflow`);
  }
  return {
    workflowId: createdWf.id,
    workflowKey: createdWf.key,
    toolName,
    created: true,
  };
}

export async function ensureLocalLlmService(api, {
  baseURL = DEFAULT_LLM_BASE_URL,
  model = DEFAULT_LLM_MODEL,
  apiKey = process.env.AGENT_API_KEY || '',
} = {}) {
  const services = normalizeRows(await api('llmServices:list?pageSize=50'));
  const existing = services.find((s) => s.name === DEFAULT_LLM_NAME);
  if (!apiKey && !existing) {
    return {
      configured: false,
      skipped: true,
      reason: 'AGENT_API_KEY env var not set; configure LLM service credentials via AI employees -> LLM services.',
    };
  }

  const models = [
    { label: 'combo (9router auto-route)', value: 'combo' },
    { label: 'ag/gemini-3.8-flash (9router)', value: 'ag/gemini-3.8-flash' },
  ];
  if (!models.some((m) => m.value === model)) {
    models.push({ label: `${model} (9router)`, value: model });
  }

  const values = {
    name: DEFAULT_LLM_NAME,
    title: 'Local 9router (OpenAI-compatible)',
    provider: 'openai-completions',
    options: {
      baseURL,
      ...(apiKey ? { apiKey } : {}),
    },
    enabledModels: { mode: 'custom', models },
    enabled: true,
  };

  if (existing) {
    if (!apiKey && existing.options) {
      // Preserve existing stored credentials when running without AGENT_API_KEY override.
      delete values.options;
    }
    await api(`llmServices:update?filterByTk=${DEFAULT_LLM_NAME}`, {
      method: 'POST',
      values,
    });
  } else {
    await api('llmServices:create', { method: 'POST', values });
  }

  return { configured: true, skipped: false, serviceName: DEFAULT_LLM_NAME, baseURL, model };
}

export async function setupDepartmentAiAgent(api, opts = {}) {
  const organizationId = opts.organizationId || DEFAULT_ORG_ID;
  const model = opts.model || DEFAULT_LLM_MODEL;

  const workflow = await ensureMaintenanceAiWorkflow(api, { organizationId });
  const llm = opts.skipLlm
    ? { configured: false, skipped: true, reason: 'Skipped via --skip-llm' }
    : await ensureLocalLlmService(api, { baseURL: opts.llmBaseUrl, model });

  if (opts.workflowOnly) {
    return { result: 'PASS', mode: 'workflow-only', workflow, llm, employee: null };
  }

  const employees = normalizeRows(await api('aiEmployees:list?pageSize=100'));
  const existingEmp = employees.find((e) => e.username === DEFAULT_EMPLOYEE_USERNAME);
  const payload = buildDepartmentAgentPayload({
    toolName: workflow.toolName,
    organizationId,
    llmService: DEFAULT_LLM_NAME,
    model,
  });

  if (existingEmp) {
    await api(`aiEmployees:update?filterByTk=${DEFAULT_EMPLOYEE_USERNAME}`, {
      method: 'POST',
      values: payload,
    });
  } else {
    await api('aiEmployees:create', {
      method: 'POST',
      values: payload,
    });
  }

  return {
    result: 'PASS',
    mode: 'full',
    workflow,
    llm,
    employee: {
      username: DEFAULT_EMPLOYEE_USERNAME,
      nickname: payload.nickname,
      model,
      toolName: workflow.toolName,
      created: !existingEmp,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resolveDepartmentTarget(process.argv.slice(2))
    .then(async (opts) => {
      const api = await createRootApiClient(opts.origin);
      const summary = await setupDepartmentAiAgent(api, opts);
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(JSON.stringify({ result: 'FAIL', error: error.message }));
      process.exitCode = 1;
    });
}
