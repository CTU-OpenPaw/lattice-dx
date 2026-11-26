/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('node:crypto');
const { fail, val } = require('../../wms-dmn-shared');
const { assertSafeLlmUrl, callConfiguredLlm, resolveActiveLlmService } = require('../llm-client');
const { isAllowlistedTargetCollection, isForbiddenCollection } = require('./data');
const { flowHelpers } = require('./triggers');
const { executeReactAgent } = require('../react-agent');

const { isPlainObject, sanitizePlainObject, interpolateTemplate, buildEvalContext, resolveOrgId, pickHelper } = flowHelpers;
const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const estTokens = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s ? Math.max(1, Math.ceil(s.length / 3.2)) : 1; };

function normalizeLlmUsage(rawUsage, promptPayload = '', responsePayload = '') {
  const pRaw = rawUsage?.promptTokens ?? rawUsage?.prompt_tokens ?? rawUsage?.input_tokens;
  const cRaw = rawUsage?.completionTokens ?? rawUsage?.completion_tokens ?? rawUsage?.output_tokens;
  const tRaw = rawUsage?.totalTokens ?? rawUsage?.total_tokens;
  const hasProvider = Boolean(rawUsage && (Number.isFinite(Number(pRaw)) || Number.isFinite(Number(cRaw)) || Number.isFinite(Number(tRaw))));
  if (hasProvider) {
    const promptTokens = Math.max(0, Math.trunc(Number(pRaw) || 0));
    const completionTokens = Math.max(0, Math.trunc(Number(cRaw) || 0));
    const totalTokens = Number.isFinite(Number(tRaw)) ? Math.max(promptTokens + completionTokens, Math.trunc(Number(tRaw))) : (promptTokens + completionTokens);
    return { usage: { promptTokens, completionTokens, totalTokens }, tokenSource: 'provider' };
  }
  const promptTokens = estTokens(promptPayload);
  const completionTokens = estTokens(responsePayload);
  return { usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }, tokenSource: 'estimated' };
}

async function callLlmJson({ db, env = process.env, systemPrompt = '', userPayload = {}, model, temperature = 0.2, maxTokens = 1200, timeoutMs = 15000, fetchImpl, lookupImpl, connectorVault } = {}) {
  const messages = [...(systemPrompt ? [{ role: 'system', content: String(systemPrompt) }] : []), { role: 'user', content: userPayload ?? {} }];
  const res = await callConfiguredLlm({ db, env, messages, model, temperature, maxTokens, responseFormat: 'json', timeoutMs, fetchImpl, lookupImpl, connectorVault });
  if (res.ok && isPlainObject(res.parsedJson)) {
    return { ok: true, mode: 'llm', data: res.parsedJson, model: res.model || null, piiRedactedCount: res.piiRedactedCount || 0, ...normalizeLlmUsage(res.usage, userPayload, res.content) };
  }
  return { ok: false, mode: 'offline_fallback', data: null, reason: res?.reason || 'LLM unavailable or non-JSON response', piiRedactedCount: res?.piiRedactedCount || 0, ...normalizeLlmUsage(null, userPayload, '') };
}

const aiNodes = [
  {
    type: 'ai.llm',
    category: 'ai',
    label: 'Xử lý LLM',
    description: 'Gọi nhà cung cấp llmServices tương thích OpenAI đang cấu hình với ẩn danh PII và bảo vệ SSRF.',
    icon: 'RobotOutlined',
    color: '#722ed1',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { systemPrompt: '', userPrompt: '', responseFormat: 'json', temperature: 0.2, maxTokens: 1600, model: '', fallbackOutput: null },
    inputSchema: {
      fields: [
        { name: 'systemPrompt', label: 'Chỉ dẫn Hệ thống', type: 'textarea' },
        { name: 'userPrompt', label: 'Lệnh Người dùng', type: 'textarea', required: true },
        { name: 'responseFormat', label: 'Định dạng Phản hồi', type: 'select', options: ['json', 'text'] },
        { name: 'temperature', label: 'Nhiệt độ (Temperature)', type: 'number' },
        { name: 'maxTokens', label: 'Số Token Tối đa', type: 'number' },
        { name: 'model', label: 'Ghi đè Model', type: 'string' },
        { name: 'fallbackOutput', label: 'Đầu ra Dự phòng (JSON)', type: 'json' },
      ],
    },
    async execute({ node, config, input, context, db, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const env = options?.env || process.env;
      const systemPrompt = cfg.systemPrompt ? String(interp(cfg.systemPrompt, evalCtx)) : '';
      const rawUser = cfg.userPrompt ? interp(cfg.userPrompt, evalCtx) : (input ?? evalCtx.data ?? {});
      const messages = [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: rawUser ?? '' }];
      const responseFormat = cfg.responseFormat === 'text' ? 'text' : 'json';

      if (options?.dryRun && typeof options?.fetchImpl !== 'function') {
        const svc = await resolveActiveLlmService(db, env);
        if (svc.configured) {
          const base = String(svc.baseURL || '').replace(/\/+$/, '');
          const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
          await assertSafeLlmUrl(endpoint, { env, connectorVault: options?.connectorVault, lookupImpl: options?.lookupImpl, allowExplicitHost: svc.allowExplicitHost || null, skipDnsCheck: typeof options?.lookupImpl !== 'function' });
        }
        const simData = cfg.fallbackOutput != null ? interp(cfg.fallbackOutput, evalCtx) : { simulated: true };
        return { output: { mode: 'simulated', simulated: true, content: typeof simData === 'string' ? simData : JSON.stringify(simData), parsedJson: isPlainObject(simData) ? simData : null, data: simData, piiRedactedCount: 0 }, nextPort: 'main' };
      }

      const res = await callConfiguredLlm({
        db, env, messages, model: cfg.model ? String(interp(cfg.model, evalCtx)).trim() : undefined,
        temperature: cfg.temperature ?? 0.2, maxTokens: cfg.maxTokens ?? 1600, responseFormat,
        timeoutMs: cfg.timeoutMs ?? 15000, fetchImpl: options?.fetchImpl, lookupImpl: options?.lookupImpl, connectorVault: options?.connectorVault,
      });

      if (res.ok) {
        return {
          output: { mode: res.mode, model: res.model, content: res.content, parsedJson: res.parsedJson, data: res.parsedJson ?? res.content, usage: res.usage, piiRedactedCount: res.piiRedactedCount },
          nextPort: 'main',
        };
      }
      if (res.mode === 'unconfigured') {
        if (cfg.fallbackOutput !== undefined && cfg.fallbackOutput !== null) {
          const fb = interp(cfg.fallbackOutput, evalCtx);
          return {
            output: { mode: 'offline-fallback', content: typeof fb === 'string' ? fb : JSON.stringify(fb), parsedJson: isPlainObject(fb) || Array.isArray(fb) ? fb : null, data: fb, reason: res.reason },
            nextPort: 'main',
          };
        }
        return { output: { mode: 'unconfigured', reason: res.reason }, error: res.reason, nextPort: 'error' };
      }
      return { output: { mode: 'error', code: res.code, reason: res.reason }, error: res.reason, nextPort: 'error' };
    },
  },
  {
    type: 'ai.agent',
    category: 'ai',
    label: 'Đề xuất Phân loại AI',
    description: 'Tạo đề xuất AI có kiểm soát hoặc mục phân loại HITL gắn với bảng dữ liệu được phép.',
    icon: 'AuditOutlined',
    color: '#722ed1',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: {
      mode: 'single', enableReact: false, maxTurns: 5, tools: [], outputSchema: null, memoryScope: 'org', enableMemory: false, systemPrompt: '',
      targetCollection: 'latticeAssets', targetRecordId: 0, severity: 'medium', recommendation: '', prompt: '', evidence: null, aiEmployee: 'ops_triage', toolName: 'triage_flow_event', model: '', temperature: 0.2, maxTokens: 1000,
    },
    inputSchema: {
      fields: [
        { name: 'mode', label: 'Chế độ suy luận', type: 'select', options: ['single', 'react'] },
        { name: 'aiEmployee', label: 'Nhân viên AI (Persona)', type: 'string', placeholder: 'ops_triage' },
        { name: 'model', label: 'Ghi đè Model', type: 'string', placeholder: 'ag/gemini-3.8-flash' },
        { name: 'temperature', label: 'Nhiệt độ (Temperature)', type: 'number', placeholder: '0.2' },
        { name: 'maxTokens', label: 'Số Token Tối đa', type: 'number', placeholder: '1000' },
        { name: 'enableMemory', label: 'Bật bộ nhớ dài hạn', type: 'boolean' },
        { name: 'maxTurns', label: 'Số vòng tối đa', type: 'number' },
        { name: 'tools', label: 'Công cụ được phép', type: 'json' },
        { name: 'outputSchema', label: 'Schema JSON đầu ra', type: 'json' },
        { name: 'memoryScope', label: 'Phạm vi bộ nhớ', type: 'select', options: ['org', 'agent', 'user', 'none'] },
        { name: 'systemPrompt', label: 'Chỉ dẫn hệ thống', type: 'textarea' },
        { name: 'targetCollection', label: 'Bảng dữ liệu đích', type: 'collection', required: true },
        { name: 'targetRecordId', label: 'ID bản ghi đích', type: 'string' },
        { name: 'severity', label: 'Mức độ nghiêm trọng', type: 'select', options: ['low', 'medium', 'high', 'critical'] },
        { name: 'recommendation', label: 'Đề xuất mặc định', type: 'textarea', required: false },
        { name: 'prompt', label: 'Lệnh phân tích AI', type: 'textarea' },
        { name: 'evidence', label: 'Bằng chứng đính kèm (JSON)', type: 'json' },
        { name: 'toolName', label: 'Tên công cụ HITL', type: 'string', placeholder: 'triage_flow_event' },
      ],
    },
    async execute({ node, config, input, context, db, app, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const san = pickHelper(helpers, 'sanitizePlainObject', sanitizePlainObject);
      const env = options?.env || process.env;
      const targetCollection = String(interp(cfg.targetCollection || 'latticeAssets', evalCtx)).trim();
      const orgId = resolveOrgId(context, input, options, cfg);
      const allowed = typeof helpers?.isAllowlistedTargetCollection === 'function' ? helpers.isAllowlistedTargetCollection(targetCollection) : isAllowlistedTargetCollection(targetCollection);
      if (isForbiddenCollection(targetCollection) || !allowed) {
        throw fail('TARGET_COLLECTION_FORBIDDEN', 403, `TARGET_COLLECTION_FORBIDDEN: ${targetCollection || '(empty)'}`);
      }
      if (!orgId) throw fail('AI_AGENT_ORG_REQUIRED', 400, 'Valid organizationId is required for ai.agent');

      const useReact = cfg.mode === 'react' || cfg.enableReact === true || (Array.isArray(cfg.tools) && cfg.tools.length > 0);
      if (useReact) {
        return executeReactAgent({ cfg, evalCtx, input, context, db, app: app || db?.app, options, interp, orgId, targetCollection, node });
      }

      const rawRecId = interp(cfg.targetRecordId ?? evalCtx.data?.recordId ?? 0, evalCtx);
      const targetRecordId = Number.isFinite(Number(rawRecId)) ? Number(rawRecId) : 0;
      const baseRec = String(interp(cfg.recommendation || cfg.summary || `AI triage recommendation (${node?.id || 'ai.agent'})`, evalCtx));
      const rawSev = String(interp(cfg.severity || 'medium', evalCtx)).toLowerCase();
      const baseSeverity = VALID_SEVERITIES.has(rawSev) ? rawSev : 'medium';
      const baseEvidence = san(interp(cfg.evidence ?? { eventType: evalCtx.event?.type || null, data: evalCtx.data, dmn: evalCtx.dmn || {} }, evalCtx));

      if (options?.dryRun && typeof options?.fetchImpl !== 'function' && typeof options?.callLlmJson !== 'function') {
        const svc = await resolveActiveLlmService(db, env);
        if (svc.configured) {
          const base = String(svc.baseURL || '').replace(/\/+$/, '');
          const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
          await assertSafeLlmUrl(endpoint, { env, connectorVault: options?.connectorVault, lookupImpl: options?.lookupImpl, allowExplicitHost: svc.allowExplicitHost || null, skipDnsCheck: typeof options?.lookupImpl !== 'function' });
        }
        return { output: { target: 'latticeAgentProposals', targetCollection, targetRecordId, severity: baseSeverity, recommendation: baseRec, mode: 'simulated', state: 'simulated', simulated: true }, nextPort: 'main' };
      }

      const userPayload = { instruction: cfg.prompt ? String(interp(cfg.prompt, evalCtx)) : baseRec, targetCollection, targetRecordId, defaultSeverity: baseSeverity, event: evalCtx.event || null, data: evalCtx.data || {}, dmn: evalCtx.dmn || {} };
      const llmCaller = typeof options?.callLlmJson === 'function' ? options.callLlmJson : callLlmJson;
      const llmRes = await llmCaller({
        db, env, systemPrompt: 'You are an enterprise operations triage agent. Respond ONLY with strict JSON matching schema: {"severity":"low"|"medium"|"high"|"critical","recommendation":string,"summary"?:string,"evidence"?:object}.',
        userPayload, model: cfg.model ? String(interp(cfg.model, evalCtx)).trim() : undefined,
        temperature: cfg.temperature ?? 0.2, maxTokens: cfg.maxTokens ?? 1000, timeoutMs: cfg.timeoutMs ?? 15000,
        fetchImpl: options?.fetchImpl, lookupImpl: options?.lookupImpl, connectorVault: options?.connectorVault,
      });

      const useLlm = Boolean(llmRes?.ok && isPlainObject(llmRes.data));
      const llmSev = useLlm ? String(llmRes.data.severity || '').trim().toLowerCase() : '';
      const severity = VALID_SEVERITIES.has(llmSev) ? llmSev : baseSeverity;
      const llmRec = useLlm && typeof llmRes.data.recommendation === 'string' ? llmRes.data.recommendation.trim().slice(0, 2000) : '';
      const recommendation = llmRec || baseRec;
      const llmSum = useLlm && typeof llmRes.data.summary === 'string' ? llmRes.data.summary.trim().slice(0, 500) : '';
      const evidence = useLlm && (isPlainObject(llmRes.data.evidence) || llmSum)
        ? san({ ...(isPlainObject(baseEvidence) ? baseEvidence : {}), ...(isPlainObject(llmRes.data.evidence) ? llmRes.data.evidence : {}), ...(llmSum ? { summary: llmSum } : {}) })
        : baseEvidence;
      const mode = useLlm ? 'llm' : 'offline_fallback';
      const { usage, tokenSource } = useLlm
        ? normalizeLlmUsage(llmRes.usage, userPayload, llmRes.data)
        : normalizeLlmUsage(null, userPayload, { severity, recommendation });
      const meta = { mode, severity, recommendation, usage, tokenSource, piiRedactedCount: llmRes?.piiRedactedCount || 0, ...(useLlm && llmRes.model ? { model: llmRes.model } : {}) };

      const eventId = String(evalCtx.event?.id || context?.runUid || crypto.randomUUID());
      const proposalRepo = db?.getRepository?.('latticeAgentProposals');
      if (typeof proposalRepo?.create === 'function') {
        const receiptKey = `flow-${orgId}-${node?.id || 'ai'}-${eventId}`.slice(0, 120);
        const fp = crypto.createHash('sha256').update(JSON.stringify({ orgId, targetCollection, targetRecordId, eventId })).digest('hex');
        const created = await proposalRepo.create({
          values: {
            receiptKey, contentHash: fp, eventId, organizationId: orgId,
            sourceUserId: Number(context?.actor?.id || context?.actor?.userId || 0),
            sourceEmployeeId: Number(context?.actor?.employeeId || 0),
            targetCollection, targetRecordId, recordFingerprint: fp.slice(0, 32), recommendation, evidence, state: 'proposed',
          },
        });
        return { output: { target: 'latticeAgentProposals', id: val(created, 'id') ?? null, receiptKey, state: 'proposed', ...meta }, nextPort: 'main' };
      }
      const queueRepo = db?.getRepository?.('latticeAiApprovalQueue');
      if (typeof queueRepo?.create === 'function') {
        const created = await queueRepo.create({
          values: {
            organizationId: orgId, requesterUserId: Number(context?.actor?.id || context?.actor?.userId || 0),
            requesterUsername: String(context?.actor?.username || 'flow:ai-agent'),
            aiEmployee: String(cfg.aiEmployee || 'ops_triage'), toolName: String(cfg.toolName || 'triage_flow_event'),
            targetCollection, targetRecordId: String(targetRecordId), operation: 'triage',
            proposedArgs: evidence, diffPreview: recommendation, riskLevel: severity, status: 'pending',
          },
        });
        return { output: { target: 'latticeAiApprovalQueue', id: val(created, 'id') ?? null, status: 'pending', ...meta }, nextPort: 'main' };
      }
      throw fail('AGENT_PROPOSAL_REPO_UNAVAILABLE', 503, 'No proposal repository (latticeAgentProposals or latticeAiApprovalQueue) available');
    },
  },
];

module.exports = { aiNodes, callLlmJson, normalizeLlmUsage };
