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

const { isPlainObject, sanitizePlainObject, interpolateTemplate, buildEvalContext, resolveOrgId, pickHelper } = flowHelpers;

const aiNodes = [
  {
    type: 'ai.llm',
    category: 'ai',
    label: 'LLM Completion',
    description: 'Calls the active configured OpenAI-compatible llmServices provider with PII redaction and SSRF protection.',
    icon: 'RobotOutlined',
    color: '#722ed1',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { systemPrompt: '', userPrompt: '', responseFormat: 'json', temperature: 0.2, maxTokens: 1600, model: '', fallbackOutput: null },
    inputSchema: {
      fields: [
        { name: 'systemPrompt', label: 'System Prompt', type: 'textarea' },
        { name: 'userPrompt', label: 'User Prompt', type: 'textarea', required: true },
        { name: 'responseFormat', label: 'Response Format', type: 'select', options: ['json', 'text'] },
        { name: 'temperature', label: 'Temperature', type: 'number' },
        { name: 'maxTokens', label: 'Max Tokens', type: 'number' },
        { name: 'model', label: 'Model Override', type: 'string' },
        { name: 'fallbackOutput', label: 'Offline Fallback Output (JSON)', type: 'json' },
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
    label: 'AI Triage Proposal',
    description: 'Creates a governed AI proposal or HITL triage item scoped to an allowlisted business collection.',
    icon: 'AuditOutlined',
    color: '#722ed1',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { targetCollection: 'latticeAssets', targetRecordId: 0, severity: 'medium', recommendation: '', evidence: null, aiEmployee: 'ops_triage', toolName: 'triage_flow_event' },
    inputSchema: {
      fields: [
        { name: 'targetCollection', label: 'Target Collection', type: 'collection', required: true },
        { name: 'targetRecordId', label: 'Target Record ID', type: 'string' },
        { name: 'severity', label: 'Severity', type: 'select', options: ['low', 'medium', 'high', 'critical'] },
        { name: 'recommendation', label: 'Recommendation', type: 'textarea', required: true },
        { name: 'evidence', label: 'Evidence (JSON)', type: 'json' },
      ],
    },
    async execute({ node, config, input, context, db, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const san = pickHelper(helpers, 'sanitizePlainObject', sanitizePlainObject);
      const targetCollection = String(interp(cfg.targetCollection || 'latticeAssets', evalCtx)).trim();
      const orgId = resolveOrgId(context, input, options, cfg);
      const allowed = typeof helpers?.isAllowlistedTargetCollection === 'function' ? helpers.isAllowlistedTargetCollection(targetCollection) : isAllowlistedTargetCollection(targetCollection);
      if (isForbiddenCollection(targetCollection) || !allowed) {
        throw fail('TARGET_COLLECTION_FORBIDDEN', 403, `TARGET_COLLECTION_FORBIDDEN: ${targetCollection || '(empty)'}`);
      }
      if (!orgId) throw fail('AI_AGENT_ORG_REQUIRED', 400, 'Valid organizationId is required for ai.agent');

      const rawRecId = interp(cfg.targetRecordId ?? evalCtx.data?.recordId ?? 0, evalCtx);
      const targetRecordId = Number.isFinite(Number(rawRecId)) ? Number(rawRecId) : 0;
      const recommendation = String(interp(cfg.recommendation || cfg.summary || `AI triage recommendation (${node?.id || 'ai.agent'})`, evalCtx));
      const severity = String(interp(cfg.severity || 'medium', evalCtx));
      const evidence = san(interp(cfg.evidence ?? { eventType: evalCtx.event?.type || null, data: evalCtx.data, dmn: evalCtx.dmn || {} }, evalCtx));

      if (options?.dryRun) {
        return { output: { target: 'latticeAgentProposals', targetCollection, targetRecordId, severity, recommendation, state: 'simulated', simulated: true }, nextPort: 'main' };
      }
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
        return { output: { target: 'latticeAgentProposals', id: val(created, 'id') ?? null, receiptKey, state: 'proposed' }, nextPort: 'main' };
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
        return { output: { target: 'latticeAiApprovalQueue', id: val(created, 'id') ?? null, status: 'pending' }, nextPort: 'main' };
      }
      throw fail('AGENT_PROPOSAL_REPO_UNAVAILABLE', 503, 'No proposal repository (latticeAgentProposals or latticeAiApprovalQueue) available');
    },
  },
];

module.exports = { aiNodes };
