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
const { loadFoundationModule } = require('../wms-dmn-shared');
const { assertSafeLlmUrl, callConfiguredLlm, resolveActiveLlmService } = require('./llm-client');
const { stripUnsafeKeys, validateJsonAgainstSchema } = require('./json-schema-validator');
const {
  enqueueAgentHitlApproval,
  invokeResolvedTool,
  isMutatingTool,
  resolveAgentTools,
  toOpenAiToolSpecs,
} = require('./agent-tools-bridge');

const stripFence = (text) => {
  const t = String(text ?? '').trim();
  const m = t.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i);
  return m ? m[1].trim() : t;
};

function parseOutputContent(rawContent, hasOutputSchema) {
  const text = String(rawContent ?? '').trim();
  if (!text) return hasOutputSchema ? null : '';
  if (hasOutputSchema || text.startsWith('{') || text.startsWith('[') || text.startsWith('```')) {
    try {
      return { parsed: stripUnsafeKeys(JSON.parse(stripFence(text))), isJson: true };
    } catch {
      return { parsed: text, isJson: false };
    }
  }
  return { parsed: text, isJson: false };
}

function addUsage(acc, rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return;
  const p = Number(rawUsage.promptTokens ?? rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0);
  const c = Number(rawUsage.completionTokens ?? rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0);
  const t = Number(rawUsage.totalTokens ?? rawUsage.total_tokens ?? (p + c));
  if (Number.isFinite(p)) acc.promptTokens += Math.max(0, Math.trunc(p));
  if (Number.isFinite(c)) acc.completionTokens += Math.max(0, Math.trunc(c));
  if (Number.isFinite(t)) acc.totalTokens += Math.max(0, Math.trunc(t));
}

function createGenAiTracer(db, options, { orgId, runUid, agentName }) {
  const otel = options?.otelExporter || loadFoundationModule('otel-exporter');
  const traceId = crypto.randomBytes(16).toString('hex');
  const rootSpanId = crypto.randomBytes(8).toString('hex');

  const emit = async ({ operationName, spanId: explicitSpanId, parentSpanId, model, toolName, status = 'ok', startedMs, inputTokens = 0, outputTokens = 0, piiRedactedCount = 0, errorMessage = null, attributes = {} }) => {
    const durationMs = Math.max(0, Date.now() - startedMs);
    const spanId = explicitSpanId || crypto.randomBytes(8).toString('hex');
    const resolvedParent = parentSpanId === undefined ? rootSpanId : parentSpanId;
    const mergedAttrs = {
      'gen_ai.operation.name': operationName,
      'gen_ai.system': 'openai',
      ...(model ? { 'gen_ai.request.model': model } : {}),
      ...(agentName ? { 'gen_ai.agent.name': agentName } : {}),
      ...(toolName ? { 'gen_ai.tool.name': toolName } : {}),
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'dxos.pii.redacted_count': piiRedactedCount,
      ...attributes,
    };
    const spanRec = {
      uid: `tr_${crypto.randomUUID()}`,
      organizationId: orgId,
      traceId,
      spanId,
      parentSpanId: resolvedParent,
      runUid: runUid || null,
      operationName,
      genAiSystem: 'openai',
      model: model || '',
      agentName,
      toolName: toolName || '',
      status,
      durationMs,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      piiRedactedCount,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null,
      startedAt: new Date(startedMs),
      endedAt: new Date(),
      attributes: mergedAttrs,
      attributesJson: mergedAttrs,
    };
    try {
      if (typeof otel?.recordGenAiSpan === 'function') otel.recordGenAiSpan(spanRec);
      else if (typeof otel?.recordSpan === 'function') {
        otel.recordSpan({ name: `${operationName} ${toolName || agentName}`.trim(), traceId, spanId, ...(resolvedParent ? { parentSpanId: resolvedParent } : {}), attributes: spanRec.attributes, status: { code: status === 'error' ? 2 : 1 } });
      }
      if (typeof otel?.persistGenAiTrace === 'function') await otel.persistGenAiTrace(db, { ...spanRec, attributesJson: spanRec.attributes }).catch(() => {});
      else {
        const traceRepo = db?.getRepository?.('latticeAiTraces');
        if (traceRepo && typeof traceRepo.create === 'function') {
          await traceRepo.create({ values: { ...spanRec, attributesJson: spanRec.attributes } }).catch(() => {});
        }
      }
    } catch { /* never break flow execution on telemetry error */ }
  };

  return { traceId, rootSpanId, emit };
}

async function executeReactAgent({ cfg, evalCtx, input, context, db, app, options, interp, orgId, targetCollection, node }) {
  const env = options?.env || process.env;
  const maxTurns = Math.min(12, Math.max(1, Math.trunc(Number(cfg.maxTurns) || 5)));
  const agentName = String(cfg.aiEmployee || 'ops_triage').trim();

  if (options?.dryRun && typeof options?.fetchImpl !== 'function') {
    const svc = await resolveActiveLlmService(db, env);
    if (svc.configured) {
      const base = String(svc.baseURL || '').replace(/\/+$/, '');
      const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      await assertSafeLlmUrl(endpoint, { env, connectorVault: options?.connectorVault, lookupImpl: options?.lookupImpl, allowExplicitHost: svc.allowExplicitHost || null, skipDnsCheck: typeof options?.lookupImpl !== 'function' });
    }
    return { output: { mode: 'simulated', simulated: true, status: 'simulated', turnsUsed: 0, toolCalls: [] }, nextPort: 'main' };
  }

  const tracer = createGenAiTracer(db, options, { orgId, runUid: context?.runUid, agentName });
  const agentStarted = Date.now();
  const { allowedMap, memoryTools } = resolveAgentTools({ cfg, db, app, options, orgId, context });
  const toolSpecs = toOpenAiToolSpecs(allowedMap);
  const hasSchema = Boolean(cfg.outputSchema && typeof cfg.outputSchema === 'object' && !Array.isArray(cfg.outputSchema));

  const userGoal = cfg.prompt ? String(interp(cfg.prompt, evalCtx)) : String(interp(cfg.recommendation || 'Analyze context and respond.', evalCtx));
  let memorySnippet = '';
  if ((cfg.enableMemory === true || (cfg.memoryScope && cfg.memoryScope !== 'none')) && db?.getRepository?.('latticeAiMemory')) {
    const recalled = await memoryTools.memory_recall.execute({ query: userGoal.slice(0, 120), scope: cfg.memoryScope || 'org', limit: 3 }).catch(() => null);
    if (recalled?.items?.length) memorySnippet = `\n\nRecalled Organization Memory:\n${JSON.stringify(recalled.items)}`;
  }

  const sysParts = [
    cfg.systemPrompt ? String(interp(cfg.systemPrompt, evalCtx)) : 'You are an autonomous enterprise ReAct agent. Use tools carefully when needed and return concise, accurate results.',
    hasSchema ? `Final response MUST be valid JSON matching this JSON Schema: ${JSON.stringify(cfg.outputSchema)}` : '',
  ].filter(Boolean);

  const messages = [
    { role: 'system', content: sysParts.join('\n\n') },
    { role: 'user', content: `${userGoal}${memorySnippet}\n\nContext Data:\n${JSON.stringify({ event: evalCtx.event || null, data: evalCtx.data || input || {}, dmn: evalCtx.dmn || {} })}` },
  ];

  const toolTrace = [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let piiRedactedCount = 0;
  let repairsUsed = 0;
  let lastModel = cfg.model ? String(interp(cfg.model, evalCtx)).trim() : undefined;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const chatStart = Date.now();
    const llmRes = await callConfiguredLlm({
      db, env, messages, model: lastModel, temperature: cfg.temperature ?? 0.2, maxTokens: cfg.maxTokens ?? 1400,
      responseFormat: toolSpecs.length ? 'auto' : (hasSchema ? 'json' : 'text'),
      tools: toolSpecs, toolChoice: toolSpecs.length ? 'auto' : undefined,
      timeoutMs: cfg.timeoutMs ?? 20000, fetchImpl: options?.fetchImpl, lookupImpl: options?.lookupImpl, connectorVault: options?.connectorVault,
    });
    piiRedactedCount += Number(llmRes?.piiRedactedCount || 0);
    addUsage(usage, llmRes?.usage);
    if (llmRes?.model) lastModel = llmRes.model;

    await tracer.emit({
      operationName: 'chat', model: lastModel, status: llmRes?.ok ? 'ok' : 'error', startedMs: chatStart,
      inputTokens: Number(llmRes?.usage?.prompt_tokens ?? llmRes?.usage?.promptTokens ?? 0),
      outputTokens: Number(llmRes?.usage?.completion_tokens ?? llmRes?.usage?.completionTokens ?? 0),
      piiRedactedCount: Number(llmRes?.piiRedactedCount || 0),
      errorMessage: llmRes?.ok ? null : llmRes?.reason,
    });

    if (!llmRes?.ok) {
      await tracer.emit({ operationName: 'invoke_agent', spanId: tracer.rootSpanId, parentSpanId: null, model: lastModel, status: 'error', startedMs: agentStarted, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, piiRedactedCount, errorMessage: llmRes?.reason });
      return { output: { mode: llmRes?.mode || 'error', reason: llmRes?.reason || 'LLM request failed', turnsUsed: turn, toolCalls: toolTrace, usage, piiRedactedCount }, error: llmRes?.reason || 'LLM request failed', nextPort: 'error' };
    }

    const calls = Array.isArray(llmRes.toolCalls) ? llmRes.toolCalls : [];
    if (calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: llmRes.content || null,
        tool_calls: calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.argumentsRaw || JSON.stringify(tc.arguments || {}) } })),
      });

      for (const tc of calls) {
        const toolDef = allowedMap.get(tc.name);
        if (!toolDef) {
          const errMsg = `AGENT_TOOL_NOT_ALLOWED: Tool "${tc.name}" is not allowlisted`;
          await tracer.emit({ operationName: 'execute_tool', toolName: tc.name, status: 'error', startedMs: Date.now(), errorMessage: errMsg });
          await tracer.emit({ operationName: 'invoke_agent', spanId: tracer.rootSpanId, parentSpanId: null, model: lastModel, status: 'error', startedMs: agentStarted, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, piiRedactedCount, errorMessage: errMsg });
          return { output: { mode: 'react_llm', turnsUsed: turn, toolCalls: toolTrace, usage, piiRedactedCount, reason: errMsg }, error: errMsg, nextPort: 'error' };
        }

        if (isMutatingTool(tc.name, toolDef)) {
          if (options?.dryRun) {
            toolTrace.push({ name: tc.name, arguments: tc.arguments, status: 'simulated_hitl' });
            await tracer.emit({ operationName: 'execute_tool', toolName: tc.name, status: 'ok', startedMs: Date.now() });
            await tracer.emit({ operationName: 'invoke_agent', spanId: tracer.rootSpanId, parentSpanId: null, model: lastModel, status: 'ok', startedMs: agentStarted, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, piiRedactedCount });
            return { output: { mode: 'simulated', simulated: true, status: 'simulated_hitl', pendingApproval: false, toolName: tc.name, proposedArgs: tc.arguments, turnsUsed: turn, toolCalls: toolTrace, usage, piiRedactedCount }, nextPort: 'main' };
          }
          let hitl;
          try {
            hitl = await enqueueAgentHitlApproval({ db, orgId, cfg, context, toolName: tc.name, args: tc.arguments, targetCollection });
          } catch (err) {
            await tracer.emit({ operationName: 'invoke_agent', spanId: tracer.rootSpanId, parentSpanId: null, model: lastModel, status: 'error', startedMs: agentStarted, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, piiRedactedCount, errorMessage: err?.message || String(err) });
            throw err;
          }
          toolTrace.push({ name: tc.name, arguments: tc.arguments, status: 'pending_approval', approvalId: hitl.approvalId });
          await tracer.emit({ operationName: 'execute_tool', toolName: tc.name, status: 'suspended', startedMs: Date.now() });
          await tracer.emit({ operationName: 'invoke_agent', spanId: tracer.rootSpanId, parentSpanId: null, model: lastModel, status: 'suspended', startedMs: agentStarted, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, piiRedactedCount });
          return {
            suspend: { kind: 'approval', approvalId: hitl.approvalId, approverRole: hitl.approverRole, resumeAt: hitl.resumeAt, toolName: tc.name },
            output: { mode: 'react_llm', status: 'pending_approval', pendingApproval: true, approvalId: hitl.approvalId, approverRole: hitl.approverRole, toolName: tc.name, proposedArgs: tc.arguments, turnsUsed: turn, toolCalls: toolTrace, usage, piiRedactedCount },
          };
        }

        const tStart = Date.now();
        let toolResult;
        let toolErr = null;
        try {
          toolResult = await invokeResolvedTool(toolDef, tc.arguments, { db, app, context, cfg, orgId });
        } catch (err) {
          toolErr = err?.message || String(err);
          toolResult = { ok: false, error: toolErr };
        }
        await tracer.emit({ operationName: 'execute_tool', toolName: tc.name, status: toolErr ? 'error' : 'ok', startedMs: tStart, errorMessage: toolErr });
        toolTrace.push({ name: tc.name, arguments: tc.arguments, status: toolErr ? 'error' : 'completed', result: stripUnsafeKeys(toolResult) });
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: JSON.stringify(stripUnsafeKeys(toolResult) ?? {}) });
      }
      continue;
    }

    const parsed = parseOutputContent(llmRes.content, hasSchema);
    if (hasSchema) {
      const check = parsed.isJson ? validateJsonAgainstSchema(parsed.parsed, cfg.outputSchema) : { ok: false, errors: [{ path: '$', message: 'Response is not valid JSON' }] };
      if (!check.ok) {
        if (repairsUsed < 1 && turn < maxTurns) {
          repairsUsed += 1;
          messages.push({ role: 'assistant', content: llmRes.content || '' });
          messages.push({ role: 'user', content: `Output failed JSON schema validation: ${check.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}. Return ONLY valid JSON matching outputSchema.` });
          continue;
        }
        const errMsg = `AI_AGENT_SCHEMA_VALIDATION_FAILED: ${check.errors.map((e) => e.message).join('; ')}`;
        await tracer.emit({ operationName: 'invoke_agent', spanId: tracer.rootSpanId, parentSpanId: null, model: lastModel, status: 'error', startedMs: agentStarted, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, piiRedactedCount, errorMessage: errMsg });
        return { output: { mode: 'react_llm', validationErrors: check.errors, rawContent: llmRes.content, turnsUsed: turn, toolCalls: toolTrace, usage, piiRedactedCount }, error: errMsg, nextPort: 'error' };
      }
      await tracer.emit({ operationName: 'invoke_agent', spanId: tracer.rootSpanId, parentSpanId: null, model: lastModel, status: 'ok', startedMs: agentStarted, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, piiRedactedCount });
      return { output: { mode: 'react_llm', model: lastModel, content: llmRes.content, data: check.value, parsedJson: check.value, turnsUsed: turn, toolCalls: toolTrace, usage, tokenSource: 'provider', piiRedactedCount }, nextPort: 'main' };
    }

    const finalVal = parsed.isJson ? parsed.parsed : llmRes.content;
    await tracer.emit({ operationName: 'invoke_agent', spanId: tracer.rootSpanId, parentSpanId: null, model: lastModel, status: 'ok', startedMs: agentStarted, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, piiRedactedCount });
    return { output: { mode: 'react_llm', model: lastModel, content: llmRes.content, data: finalVal, parsedJson: parsed.isJson ? finalVal : null, turnsUsed: turn, toolCalls: toolTrace, usage, tokenSource: 'provider', piiRedactedCount }, nextPort: 'main' };
  }

  const maxErr = `AI_AGENT_MAX_TURNS_EXCEEDED: Reached maxTurns=${maxTurns} without final response`;
  await tracer.emit({ operationName: 'invoke_agent', spanId: tracer.rootSpanId, parentSpanId: null, model: lastModel, status: 'error', startedMs: agentStarted, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, piiRedactedCount, errorMessage: maxErr });
  return { output: { mode: 'react_llm', turnsUsed: maxTurns, toolCalls: toolTrace, usage, piiRedactedCount, reason: maxErr }, error: maxErr, nextPort: 'error' };
}

module.exports = { executeReactAgent };
