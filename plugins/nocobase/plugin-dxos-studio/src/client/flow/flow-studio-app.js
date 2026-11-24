/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const vendor = require('./vendor-shims');
const { isObj, sanitizeSafeValue, safeJsonParse, parseDslText, serializeFlowDsl, nextCollisionFreeId, ruleToGraph, makeBlankFlow, deriveTriggerEventType, applyOpsLocal, getRunTraces, buildRunOverlay } = require('./flow-dsl');
const { createFlowCanvas } = require('./flow-canvas');
const { createNodePalette } = require('./node-palette');
const { createPlaybackBar } = require('./playback-bar');
const { createNodeInspector } = require('./node-inspector');
const { createArchitectDrawer } = require('./architect-drawer');

const DEFAULT_NODES = [
  ['trigger.event', 'trigger', 'Event Trigger', ['main'], { eventType: '*' }],
  ['trigger.manual', 'trigger', 'Manual Trigger', ['main'], {}],
  ['control.if', 'control', 'Conditional IF', ['true', 'false', 'error'], { condition: { field: 'data.severity', op: 'eq', value: 'high' } }],
  ['control.approval', 'control', 'Human Approval', ['approved', 'rejected', 'error'], { approverRole: 'ldx_manager', title: 'Review' }],
  ['data.create', 'data', 'Create Record', ['main', 'error'], { collection: 'latticeServiceTickets', values: {} }],
  ['logic.dmn', 'logic', 'DMN Decision', ['main', 'error'], { tableKey: 'cmms_priority_routing_v1' }],
  ['ai.llm', 'ai', 'LLM Prompt', ['main', 'error'], { userPrompt: '{{data}}' }],
  ['notify.send', 'integration', 'Send Notification', ['main', 'error'], { roleNames: ['ldx_operator'], title: 'Alert' }],
].map(([type, category, label, outputs, defaultConfig]) => ({ type, category, label, inputs: category === 'trigger' ? [] : ['in'], outputs, defaultConfig, inputSchema: { fields: [] } }));

const DEFAULT_BLUEPRINTS = [
  ['auto_cmms_on_coldchain_fault', 'Cold-Chain CMMS Emergency', 'cold-chain', 'trigger.event', { eventType: 'alarm.triggered' }, 'data.create', 'Create Work Order', { collection: 'latticeCustomWorkOrders' }],
  ['auto_mkt_quarantine_response', 'MKT Lot Quarantine', 'wms', 'trigger.event', { eventType: 'lot.held_mkt' }, 'data.create', 'Open Incident', { collection: 'latticeIncidentCases' }],
  ['auto_sla_breach_escalation', 'SLA Breach Escalation', 'sla', 'trigger.event', { eventType: 'sla.warning,sla.breached' }, 'data.create', 'Create SLA Ticket', { collection: 'latticeServiceTickets', values: { serviceType: 'facilities', priority: 'high' } }],
  ['auto_procurement_hitl_approval', 'Procurement HITL Approval', 'erp-procurement', 'trigger.record', { collection: 'latticeRequests', operation: 'create' }, 'control.approval', 'Director Approval', { approverRole: 'ldx_manager' }],
  ['auto_scheduled_ai_digest', 'Scheduled AI Ops Digest', 'ai-ops', 'trigger.schedule', { cron: '0 8 * * 1-5' }, 'ai.llm', 'AI Digest', { userPrompt: 'Summarize incidents' }],
  ['auto_partner_webhook_sync', 'Partner B2B Webhook Sync', 'b2b-integration', 'trigger.webhook', { webhookPath: 'partner-sync', authMode: 'hmac' }, 'integration.http', 'Sync Connector', { connectorKey: 'erp-webhook-sync', method: 'POST' }],
].map(([ruleKey, name, category, tType, tCfg, sType, sLabel, sCfg]) => ({
  blueprintKey: ruleKey, ruleKey, name, category, active: true, cooldownSec: 60, maxDepth: 8,
  graphJson: {
    version: 2, edges: [{ id: 'e_1', source: 'trig_1', sourceHandle: 'main', target: 'step_1', targetHandle: 'in' }],
    nodes: [{ id: 'trig_1', type: tType, label: 'Trigger', position: { x: 80, y: 180 }, config: tCfg }, { id: 'step_1', type: sType, label: sLabel, position: { x: 380, y: 180 }, config: sCfg }],
    settings: { errorPolicy: 'stop', cooldownSec: 60, maxDepth: 8, timeoutMs: 30000 },
  },
}));

const ROW = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
const INP = { padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 };
const unwrap = (r) => r?.data?.data ?? r?.data ?? {};
const errMsg = (e, fb) => e?.response?.data?.errors?.[0]?.message || e?.response?.data?.message || e?.message || fb;
const primaryEvt = (a, b) => String(a || b || 'manual.trigger').split(',')[0].trim() || 'manual.trigger';
const isPolicyRefusal = (e, msg) => ['AI_ASSIST_REFUSED', 'AUTOMATION_AI_REFUSED'].includes(e?.response?.data?.errors?.[0]?.code || e?.response?.data?.code || e?.code)
  || (Number(e?.response?.status ?? e?.status) === 400 && /refus|unsafe|inject|forbidden|proto/i.test(String(msg || '')));
const syncMeta = (s, cdVal, mdVal) => {
  const [cd, md] = [cdVal ?? s?.cooldownSec, mdVal ?? s?.maxDepth];
  return { ...(cd != null && cd !== '' && Number.isFinite(Number(cd)) ? { cooldownSec: Number(cd) } : {}), ...(md != null && md !== '' && Number.isFinite(Number(md)) ? { maxDepth: Number(md) } : {}) };
};
const btnS = (pri, dng, dis) => ({
  padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', cursor: dis ? 'not-allowed' : 'pointer',
  border: `1px solid ${dis ? '#cbd5e1' : dng ? '#dc2626' : pri ? '#1677ff' : '#cbd5e1'}`,
  background: dis ? '#e2e8f0' : dng ? '#dc2626' : pri ? '#1677ff' : '#ffffff', color: dis ? '#94a3b8' : (pri || dng) ? '#ffffff' : '#1e293b',
});

const freshDoc = (seed) => { const b = makeBlankFlow(seed); return { rule: b.rule, graph: b.graph, undo: [], redo: [], selId: b.graph.nodes[0]?.id || 'trig_1', preDragGraph: null }; };
const FRESH = { data: { rules: [], runs: [], catalog: null, regTypes: [], loading: false }, run: { selectedRun: null, idx: 0, playing: false, testOut: null, archRes: null }, ui: { archOpen: false, bpOpen: false, insertEdge: null, fb: null, busy: {} } };

function createFlowStudioApp(client, React, _antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const [FlowCanvas, NodePalette, PlaybackBar, NodeInspector, ArchitectDrawer] = [createFlowCanvas(React, vendor), createNodePalette(React), createPlaybackBar(React), createNodeInspector(React), createArchitectDrawer(React)];

  return function FlowStudioApp(props = {}) {
    const api = props.api || useApi();
    const [urlInit] = React.useState(() => {
      try { const p = new URLSearchParams(window?.location?.search || ''); return { org: p.get('organizationId') || '', ruleKey: p.get('ruleKey') || '' }; } catch { return { org: '', ruleKey: '' }; }
    });
    const [discoveredOrgs, setDiscoveredOrgs] = React.useState([]);
    const [orgOverride, setOrgOverride] = React.useState(null);
    React.useEffect(() => { setOrgOverride(null); }, [props.selectedOrg]);
    const orgList = Array.isArray(props.organizations) && props.organizations.length ? props.organizations : discoveredOrgs;
    const effectiveOrg = String(orgOverride !== null ? orgOverride : (props.selectedOrg || urlInit.org || orgList[0] || '')).trim();
    const orgPayload = effectiveOrg ? { organizationId: effectiveOrg } : {};
    const [doc, setDoc] = React.useState(() => freshDoc(effectiveOrg || 1));
    const [data, setData] = React.useState(FRESH.data);
    const [runUi, setRunUi] = React.useState(FRESH.run);
    const [ui, setUi] = React.useState(FRESH.ui);
    const [dsl, setDsl] = React.useState({ open: false, format: 'json', text: '', error: null });
    const [refs] = React.useState(() => ({ loadSeq: 0, actionEpoch: 0, activeOrg: effectiveOrg, latestOrg: effectiveOrg, api, idSeq: 1, initDone: false }));
    refs.api = api;
    refs.latestOrg = effectiveOrg;

    const reportFb = (fb) => (typeof props.setFeedback === 'function' ? (props.setFeedback(fb), setUi((u) => ({ ...u, fb: null }))) : setUi((u) => ({ ...u, fb })));
    const nextId = (pfx, g = doc.graph) => nextCollisionFreeId(pfx, g);
    const setRunWithIdx = (r) => setRunUi((s) => ({ ...s, playing: false, selectedRun: r, idx: Math.max(0, getRunTraces(r).length - 1) }));
    const applyRule = React.useCallback((r) => {
      const g = ruleToGraph(r); refs.initDone = true;
      setDoc({ rule: { ...r, cooldownSec: g.settings.cooldownSec, maxDepth: g.settings.maxDepth }, graph: g, undo: [], redo: [], selId: g.nodes[0]?.id || null, preDragGraph: null });
      setRunUi((s) => ({ ...s, testOut: null })); setUi((u) => ({ ...u, insertEdge: null }));
    }, []);

    React.useEffect(() => {
      Object.assign(refs, { activeOrg: effectiveOrg, actionEpoch: refs.actionEpoch + 1, loadSeq: refs.loadSeq + 1, initDone: false });
      setDoc(freshDoc(effectiveOrg || 1));
      setData(FRESH.data);
      setRunUi(FRESH.run);
      setUi(FRESH.ui);
      setDsl((m) => ({ ...m, open: false, text: '', error: null }));
    }, [effectiveOrg]);

    const loadAll = React.useCallback(() => {
      const cApi = refs.api;
      if (!cApi?.request) return;
      const [seq, reqOrg, reqEpoch] = [(refs.loadSeq += 1), effectiveOrg, refs.actionEpoch];
      const isFresh = () => seq === refs.loadSeq && reqOrg === refs.activeOrg && reqOrg === refs.latestOrg && reqEpoch === refs.actionEpoch;
      const patchD = (p) => setData((s) => ({ ...s, ...p }));
      const get = (u, ok, err, fin) => cApi.request({ url: u, method: 'get', ...(u.endsWith('listEmployees') ? {} : { params: { ...orgPayload } }), skipNotify: true })
        .then((res) => isFresh() && ok(unwrap(res))).catch((e) => isFresh() && err?.(e)).finally(() => isFresh() && fin?.());
      patchD({ loading: true });
      if (!props.selectedOrg && !props.organizations?.length && !discoveredOrgs.length) get('dxosStudio:listEmployees', (d) => Array.isArray(d.organizations) && setDiscoveredOrgs(d.organizations));
      get('dxosAutomations:builderCatalog', (d) => patchD({ catalog: d || null }), () => patchD({ catalog: null }));
      get('dxosAutomations:nodeRegistry', (d) => Array.isArray(d.nodeTypes) && patchD({ regTypes: d.nodeTypes }));
      get('dxosAutomations:listRules', (d) => {
        const items = Array.isArray(d.items) ? d.items : [];
        patchD({ rules: items });
        if (!refs.initDone) { refs.initDone = true; const w = props.ruleKey || urlInit.ruleKey; if (items.length) applyRule((w && items.find((x) => x.ruleKey === w)) || items[0]); }
      }, (err) => reportFb({ type: 'error', text: errMsg(err, 'Không tải được danh sách Flow.') }), () => patchD({ loading: false }));
      get('dxosAutomations:listRuns', (d) => {
        const nextRuns = Array.isArray(d.items) ? d.items : [];
        patchD({ runs: nextRuns });
        if (nextRuns.length) setRunUi((s) => (s.selectedRun ? { ...s, selectedRun: nextRuns.find((r) => r.runUid && r.runUid === s.selectedRun.runUid) || s.selectedRun } : { ...s, selectedRun: nextRuns[0], idx: Math.max(0, getRunTraces(nextRuns[0]).length - 1) }));
      });
    }, [effectiveOrg, Boolean(api?.request)]);

    React.useEffect(() => { loadAll(); }, [loadAll]);
    React.useEffect(() => {
      if (!runUi.playing) return undefined;
      const tr = getRunTraces(runUi.selectedRun);
      if (!tr.length || runUi.idx >= tr.length - 1) { setRunUi((s) => ({ ...s, playing: false })); return undefined; }
      const id = setInterval(() => setRunUi((s) => (s.idx >= tr.length - 1 ? { ...s, playing: false } : { ...s, idx: s.idx + 1 })), 700);
      return () => clearInterval(id);
    }, [runUi.playing, runUi.selectedRun, runUi.idx]);

    const nodeTypes = React.useMemo(() => (data.regTypes.length ? data.regTypes : (data.catalog?.nodeTypes?.length ? data.catalog.nodeTypes : DEFAULT_NODES)), [data.regTypes, data.catalog]);
    const blueprints = React.useMemo(() => (data.catalog?.blueprints?.length ? data.catalog.blueprints : DEFAULT_BLUEPRINTS), [data.catalog]);
    const catalog = React.useMemo(() => ({ ...(data.catalog || {}), nodeTypes, blueprints }), [data.catalog, nodeTypes, blueprints]);
    const selectedNode = React.useMemo(() => (doc.graph.nodes || []).find((n) => n.id === doc.selId) || null, [doc.graph.nodes, doc.selId]);
    const selectedSchema = React.useMemo(() => (selectedNode ? nodeTypes.find((t) => t.type === selectedNode.type) || null : null), [nodeTypes, selectedNode]);
    const activeTrace = React.useMemo(() => (!runUi.selectedRun || !doc.selId ? null : [...getRunTraces(runUi.selectedRun)].reverse().find((t) => t.nodeId === doc.selId) || runUi.selectedRun.nodeStatesJson?.[doc.selId] || null), [runUi.selectedRun, doc.selId]);
    const runOverlay = React.useMemo(() => buildRunOverlay(runUi.selectedRun, runUi.idx, doc.graph), [runUi.selectedRun, runUi.idx, doc.graph]);

    const commitGraph = (nextG, nextSel, rulePatch, opts = {}) => setDoc((d) => {
      const g = typeof nextG === 'function' ? nextG(d.graph) : nextG;
      const selId = nextSel !== undefined ? nextSel : (g.nodes.some((n) => n.id === d.selId) ? d.selId : (g.nodes[0]?.id || null));
      const patch = rulePatch ? { rule: { ...d.rule, ...rulePatch } } : {};
      if (opts.skipUndo) return { ...d, preDragGraph: d.preDragGraph || d.graph, graph: g, selId, ...patch };
      return { ...d, preDragGraph: null, undo: [...d.undo.slice(-39), d.preDragGraph || d.graph], redo: [], graph: g, selId, ...patch };
    });
    const handleNodesChangeGraph = (nextArg, meta) => commitGraph(
      Array.isArray(nextArg) ? (g) => ({ ...g, nodes: nextArg }) : nextArg, undefined, null, { skipUndo: Boolean(meta && !Array.isArray(meta) && meta.skipUndo === true) },
    );
    const makeNode = (schema, pos) => ({
      id: nextId(String(schema.type || 'node').split('.').pop() || 'node', doc.graph), type: schema.type, label: schema.label || schema.type, continueOnFail: false,
      position: pos || { x: 120 + (doc.graph.nodes.length % 5) * 240, y: 160 + Math.floor(doc.graph.nodes.length / 5) * 140 }, config: sanitizeSafeValue(schema.defaultConfig || {}),
    });
    const addNodeOnly = (schema, pos) => {
      const n = makeNode(schema, pos);
      setUi((u) => (u.insertEdge ? { ...u, insertEdge: null } : u));
      return commitGraph({ ...doc.graph, nodes: [...doc.graph.nodes, n] }, n.id);
    };
    const insertBetweenEdge = (schema) => {
      const e = ui.insertEdge;
      if (!e) return addNodeOnly(schema);
      const [srcN, dstN] = [doc.graph.nodes.find((x) => x.id === e.source), doc.graph.nodes.find((x) => x.id === e.target)];
      const pos = srcN && dstN ? { x: Math.round(((srcN.position?.x || 0) + (dstN.position?.x || 240)) / 2), y: Math.round(((srcN.position?.y || 160) + (dstN.position?.y || 160)) / 2) } : null;
      const n = makeNode(schema, pos);
      const outPort = schema.outputs?.[0] || (schema.type === 'control.if' ? 'true' : schema.type === 'control.approval' ? 'approved' : 'main');
      const e1 = { id: nextId('edge', doc.graph), source: e.source, sourceHandle: e.sourceHandle || 'main', target: n.id, targetHandle: 'in', label: e.label || null };
      const e2 = { id: nextId('edge', { nodes: [...doc.graph.nodes, n], edges: [...doc.graph.edges, e1] }), source: n.id, sourceHandle: outPort, target: e.target, targetHandle: e.targetHandle || 'in', label: null };
      setUi((u) => ({ ...u, insertEdge: null }));
      return commitGraph({ ...doc.graph, nodes: [...doc.graph.nodes, n], edges: [...doc.graph.edges.filter((x) => x.id !== e.id), e1, e2] }, n.id);
    };
    const handleConnect = (p) => {
      if (!p?.source || !p?.target || p.source === p.target) return;
      const [sh, th] = [p.sourceHandle || 'main', p.targetHandle || 'in'];
      if (!doc.graph.edges.some((e) => e.source === p.source && (e.sourceHandle || 'main') === sh && e.target === p.target && (e.targetHandle || 'in') === th)) {
        commitGraph({ ...doc.graph, edges: [...doc.graph.edges, { id: nextId('edge', doc.graph), source: p.source, sourceHandle: sh, target: p.target, targetHandle: th, label: p.label || null }] });
      }
    };

    const buildSavePayload = () => ({
      ...orgPayload, ruleKey: String(doc.rule.ruleKey || '').trim(), name: String(doc.rule.name || '').trim(), description: doc.rule.description || null,
      triggerEventType: deriveTriggerEventType(doc.graph, doc.rule), filterJson: doc.rule.filterJson ?? null, dmnTableKey: doc.rule.dmnTableKey || null,
      cooldownSec: Number(doc.rule.cooldownSec ?? doc.graph.settings?.cooldownSec ?? 0), maxDepth: Number(doc.rule.maxDepth ?? doc.graph.settings?.maxDepth ?? 8),
      active: doc.rule.active !== false, schemaVersion: 2, graphJson: doc.graph,
    });
    async function runAction(key, url, body, onOk, onErr) {
      if (!refs.api?.request || ui.busy[key]) return;
      const [reqOrg, reqEpoch] = [effectiveOrg, refs.actionEpoch];
      const isFresh = () => reqOrg === refs.activeOrg && reqOrg === refs.latestOrg && reqEpoch === refs.actionEpoch;
      setUi((u) => ({ ...u, busy: { ...u.busy, [key]: true } }));
      try {
        const res = await refs.api.request({ url, method: 'post', data: body });
        if (isFresh()) await onOk(unwrap(res));
      } catch (err) {
        if (isFresh()) { if (onErr) onErr(err); else reportFb({ type: 'error', text: errMsg(err, 'Thao tác thất bại.') }); }
      } finally { if (isFresh()) setUi((u) => ({ ...u, busy: { ...u.busy, [key]: false } })); }
    }
    const doneRun = (msg) => (d) => { const r = d.run || d; setRunWithIdx(r); reportFb({ type: 'success', text: `${msg} (${r?.status || 'completed'}).` }); loadAll(); };
    const sampleEvt = (p) => doc.rule.sampleEvent || { type: primaryEvt(p.triggerEventType, doc.rule.triggerEventType), data: {} };
    const handleSave = () => {
      const p = buildSavePayload();
      if (!p.ruleKey || !p.name) return reportFb({ type: 'error', text: 'Rule Key và Rule Name không được để trống.' });
      return runAction('save', 'dxosAutomations:saveRule', p, (d) => { if (d.rule) setDoc((s) => ({ ...s, rule: { ...s.rule, ...d.rule } })); reportFb({ type: 'success', text: `Đã lưu & publish "${p.ruleKey}".` }); loadAll(); });
    };
    const handleDryRun = () => {
      setRunUi((s) => ({ ...s, playing: false }));
      const p = buildSavePayload();
      return runAction('dryRun', 'dxosAutomations:testRule', { ...orgPayload, rule: p, sampleEvent: sampleEvt(p), useDraft: true }, (d) => setRunWithIdx(d.simulation || d.run || d));
    };
    const handleRunNow = () => runAction('runNow', 'dxosAutomations:runNow', { ...orgPayload, ruleKey: doc.rule.ruleKey, sampleEvent: sampleEvt(buildSavePayload()) }, doneRun(`Đã chạy "${doc.rule.ruleKey}"`));
    const handleTestNode = (nodeId, pinnedInputs) => runAction('testNode', 'dxosAutomations:testNode', { ...orgPayload, ruleKey: doc.rule.ruleKey, graph: doc.graph, nodeId, pinnedInputs },
      (d) => setRunUi((s) => ({ ...s, testOut: d.result || d })), (err) => setRunUi((s) => ({ ...s, testOut: { nodeId, status: 'failed', error: errMsg(err, 'Test node failed') } })));
    const handleResume = (runUid, decision) => runAction('resume', 'dxosAutomations:resumeRun', { ...orgPayload, runUid, decision }, doneRun(`HITL ${decision} hoàn tất`));
    const handleArchitect = (req) => runAction('architect', 'dxosAutomations:aiAssist', {
      ...orgPayload, mode: req.mode, prompt: req.prompt, ruleKey: req.ruleKey || undefined, rule: doc.rule, graph: req.graph,
      targetNodeId: req.targetNodeId || undefined, runUid: req.runUid && !req.runTrace?.simulated ? req.runUid : undefined, runTrace: req.runTrace || undefined,
    }, (d) => setRunUi((s) => ({ ...s, archRes: d })), (err) => { const m = errMsg(err, 'Flow Architect error'); setRunUi((s) => ({ ...s, archRes: { ok: false, refused: isPolicyRefusal(err, m), error: m } })); });
    const handleApplyArch = (res) => {
      if (res?.draftGraph) {
        const g = ruleToGraph({ graphJson: res.draftGraph, cooldownSec: res?.draftRule?.cooldownSec ?? doc.rule.cooldownSec, maxDepth: res?.draftRule?.maxDepth ?? doc.rule.maxDepth });
        commitGraph(g, g.nodes?.[0]?.id || null, { ...(res.draftRule ? sanitizeSafeValue(res.draftRule) : {}), ...(res.sampleEvent ? { sampleEvent: sanitizeSafeValue(res.sampleEvent) } : {}) });
      } else if (Array.isArray(res?.operations)) {
        const g = applyOpsLocal(doc.graph, res.operations), sMeta = syncMeta(g.settings);
        commitGraph(g, undefined, Object.keys(sMeta).length ? sMeta : null);
      }
      reportFb({ type: 'success', text: 'Đã áp dụng kết quả DX-OS Flow Architect lên Canvas.' });
    };
    const handleImportDsl = () => {
      const parsed = parseDslText(dsl.text);
      if (!parsed.ok) return setDsl((m) => ({ ...m, error: parsed.error }));
      const d = parsed.value, gRaw = isObj(d?.graphJson) ? d.graphJson : (Array.isArray(d?.nodes) ? d : null);
      if (!gRaw || !Array.isArray(gRaw.nodes)) return setDsl((m) => ({ ...m, error: 'DSL phải chứa graphJson.nodes hoặc nodes[].' }));
      const nextG = ruleToGraph({ graphJson: gRaw, cooldownSec: d.cooldownSec ?? gRaw.settings?.cooldownSec ?? doc.rule.cooldownSec, maxDepth: d.maxDepth ?? gRaw.settings?.maxDepth ?? doc.rule.maxDepth });
      const sMeta = syncMeta(nextG.settings, d.cooldownSec, d.maxDepth);
      const syncedG = Object.keys(sMeta).length ? { ...nextG, settings: { ...(nextG.settings || {}), ...sMeta } } : nextG;
      const meta = { ...(isObj(d?.graphJson) ? { ...(d.ruleKey ? { ruleKey: String(d.ruleKey) } : {}), ...(d.name ? { name: String(d.name) } : {}) } : {}), ...sMeta };
      commitGraph(syncedG, syncedG.nodes[0]?.id || null, Object.keys(meta).length ? meta : null);
      return setDsl({ open: false, format: dsl.format, text: '', error: null });
    };
    const undoRedo = (dir) => setDoc((d) => {
      const src = dir < 0 ? d.undo : d.redo;
      if (!src.length) return d;
      const target = src[src.length - 1], sMeta = syncMeta(target.settings);
      return { ...d, preDragGraph: null, rule: Object.keys(sMeta).length ? { ...d.rule, ...sMeta } : d.rule, graph: target, selId: target.nodes.some((n) => n.id === d.selId) ? d.selId : (target.nodes[0]?.id || null), undo: dir < 0 ? d.undo.slice(0, -1) : [...d.undo, d.graph], redo: dir < 0 ? [...d.redo, d.graph] : d.redo.slice(0, -1) };
    });
    const handleNewFlow = () => { setDoc(freshDoc((refs.idSeq += 1))); setRunUi((s) => ({ ...s, playing: false, selectedRun: null, idx: 0, testOut: null, archRes: null })); setUi((u) => (u.insertEdge ? { ...u, insertEdge: null } : u)); };
    const handleRuleMeta = (meta) => setDoc((d) => {
      const hasS = meta.cooldownSec !== undefined || meta.maxDepth !== undefined;
      const nextS = hasS ? { ...(d.graph.settings || {}), ...(meta.cooldownSec !== undefined ? { cooldownSec: meta.cooldownSec } : {}), ...(meta.maxDepth !== undefined ? { maxDepth: meta.maxDepth } : {}) } : d.graph.settings;
      return { ...d, rule: { ...d.rule, ...meta }, graph: hasS ? { ...d.graph, settings: nextS } : d.graph };
    });

    const dslObj = () => ({ ruleKey: doc.rule.ruleKey, name: doc.rule.name, cooldownSec: doc.rule.cooldownSec ?? 0, maxDepth: doc.rule.maxDepth ?? 8, graphJson: doc.graph });
    const tracesLen = getRunTraces(runUi.selectedRun).length;
    const activeFb = props.setFeedback ? null : ui.fb;
    const tools = [
      ['dxos-flow-toolbar-autolayout-btn', 'Auto-Layout', () => commitGraph(vendor.autoLayoutGraph(doc.graph))],
      ['dxos-flow-undo-btn', 'Undo', () => undoRedo(-1), !doc.undo.length], ['dxos-flow-redo-btn', 'Redo', () => undoRedo(1), !doc.redo.length],
      ['dxos-flow-dsl-btn', 'JSON / YAML', () => setDsl({ open: true, format: 'json', text: serializeFlowDsl(dslObj(), 'json'), error: null })],
      ['dxos-flow-open-architect-btn', 'Open Architect', () => setUi((u) => ({ ...u, archOpen: !u.archOpen })), false, ui.archOpen],
      ['dxos-flow-toolbar-dryrun-btn', 'Dry-Run', handleDryRun, Boolean(ui.busy.dryRun)],
      ['dxos-flow-save-btn', 'Publish / Save', handleSave, data.loading || Boolean(ui.busy.save), true],
      ['dxos-flow-run-now-btn', 'Run Now', handleRunNow, Boolean(ui.busy.runNow)],
    ];

    return h('div', { 'data-testid': 'dxos-flow-studio-app', style: { height: props.embedded ? 640 : 'calc(100vh - 110px)', minHeight: 580, display: 'flex', flexDirection: 'column', background: '#f8fafc', overflow: 'hidden', position: 'relative' } },
      h('header', { 'data-testid': 'dxos-flow-toolbar', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: '8px 14px', borderBottom: '1px solid #cbd5e1', background: '#ffffff' } },
        h('div', { style: ROW },
          h('strong', { style: { fontSize: 14, color: '#0f172a' } }, 'DX-OS Flow Studio'),
          (!props.selectedOrg || orgList.length > 1) ? h('input', { 'data-testid': 'dxos-flow-org-input', type: 'text', list: 'dxos-flow-org-list', value: effectiveOrg, placeholder: 'Org ID', onChange: (e) => setOrgOverride(e?.target?.value ?? ''), style: { ...INP, width: 120 } }) : null,
          orgList.length ? h('datalist', { id: 'dxos-flow-org-list' }, orgList.map((o) => h('option', { key: o, value: o }, o))) : null,
          h('select', {
            'data-testid': 'dxos-flow-rule-selector', value: data.rules.some((r) => r.ruleKey === doc.rule.ruleKey) ? doc.rule.ruleKey : '',
            onChange: (e) => { const f = data.rules.find((r) => r.ruleKey === e?.target?.value); if (f) applyRule(f); }, style: { ...INP, minWidth: 180 },
          }, h('option', { value: '' }, '-- Chọn Flow Rule --'), data.rules.map((r) => h('option', { key: r.ruleKey, value: r.ruleKey }, `${r.name || r.ruleKey} (${r.ruleKey})`))),
          h('button', { 'data-testid': 'dxos-flow-new-btn', type: 'button', onClick: handleNewFlow, style: btnS() }, '+ New Flow'),
          h('button', { 'data-testid': 'dxos-flow-blueprints-btn', type: 'button', onClick: () => setUi((u) => ({ ...u, bpOpen: !u.bpOpen })), style: btnS(ui.bpOpen) }, `Blueprints (${blueprints.length})`),
        ),
        h('div', { style: ROW }, tools.map(([tid, lbl, onClick, dis = false, pri = false]) => h('button', { key: tid, 'data-testid': tid, type: 'button', disabled: dis, onClick, style: btnS(pri, false, dis) }, lbl))),
      ),
      activeFb ? h('div', {
        'data-testid': 'dxos-flow-feedback', role: 'status',
        style: { padding: '6px 14px', fontSize: 12, background: activeFb.type === 'error' ? '#fef2f2' : '#f0fdf4', color: activeFb.type === 'error' ? '#991b1b' : '#166534', borderBottom: '1px solid #e2e8f0' },
      }, activeFb.text) : null,
      ui.bpOpen ? h('div', { 'data-testid': 'dxos-flow-blueprints-gallery', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, padding: 10, background: '#f1f5f9', borderBottom: '1px solid #cbd5e1', maxHeight: 220, overflowY: 'auto' } },
        blueprints.map((bp) => h('div', { key: bp.blueprintKey || bp.ruleKey, style: { padding: 8, borderRadius: 8, background: '#ffffff', border: '1px solid #cbd5e1', display: 'grid', gap: 4 } },
          h('strong', { style: { fontSize: 12, color: '#0f172a' } }, bp.name),
          h('span', { style: { fontSize: 11, color: '#64748b' } }, `${bp.category || 'flow'} · ${bp.graphJson?.nodes?.length || 0} nodes`),
          h('button', { 'data-testid': `dxos-flow-blueprint-load-${bp.blueprintKey || bp.ruleKey}`, type: 'button', onClick: () => { applyRule(bp); setUi((u) => ({ ...u, bpOpen: false })); }, style: btnS(true) }, 'Load Blueprint'),
        ))) : null,
      ui.insertEdge ? h('div', { 'data-testid': 'dxos-flow-insert-picker', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 14px', background: '#eff6ff', borderBottom: '1px solid #bfdbfe', fontSize: 12 } },
        h('strong', null, `Chèn node giữa ${ui.insertEdge.source} → ${ui.insertEdge.target}:`),
        nodeTypes.filter((t) => !t.type.startsWith('trigger.')).map((t) => h('button', { key: t.type, type: 'button', 'data-testid': `dxos-flow-insert-node-${t.type}`, onClick: () => insertBetweenEdge(t), style: btnS() }, t.label || t.type)),
        h('button', { 'data-testid': 'dxos-flow-insert-cancel-btn', type: 'button', onClick: () => setUi((u) => ({ ...u, insertEdge: null })), style: btnS(false, true) }, 'Hủy'),
      ) : null,
      h('div', { style: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' } },
        h(NodePalette, { nodeTypes, onAddNode: addNodeOnly }),
        h(FlowCanvas, {
          graph: doc.graph, nodeTypes, selectedNodeId: doc.selId, onSelectNode: (id) => setDoc((d) => ({ ...d, selId: id })),
          onConnectNodes: handleConnect, onNodesChangeGraph: handleNodesChangeGraph, onInsertBetweenEdge: (e) => setUi((u) => ({ ...u, insertEdge: e })),
          runOverlay, onAutoLayout: (nextG) => commitGraph(nextG), onAddNode: addNodeOnly, onDropNode: addNodeOnly, xyflowOverride: props.xyflowOverride,
        }),
        h(NodeInspector, {
          rule: doc.rule, graph: doc.graph, selectedNode, nodeSchema: selectedSchema, catalog, activeTrace, testOutput: runUi.testOut, testBusy: Boolean(ui.busy.testNode), onTestNode: handleTestNode, onUpdateRuleMeta: handleRuleMeta,
          onUpdateNode: (id, pt) => commitGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...pt } : n)) })),
          onDeleteNode: (id) => commitGraph((g) => ({ ...g, nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.source !== id && e.target !== id) })),
        }),
        h(ArchitectDrawer, {
          open: ui.archOpen, onClose: () => setUi((u) => ({ ...u, archOpen: false })), rule: doc.rule, graph: doc.graph, selectedNode,
          selectedRun: runUi.selectedRun, catalog, onRunArchitect: handleArchitect, architectBusy: Boolean(ui.busy.architect), result: runUi.archRes, onApplyResult: handleApplyArch,
        }),
      ),
      h(PlaybackBar, {
        runs: data.runs, selectedRun: runUi.selectedRun, onSelectRun: setRunWithIdx, playbackIndex: runUi.idx, onStepChange: (idx) => setRunUi((s) => ({ ...s, playing: false, idx })), playing: runUi.playing,
        onTogglePlay: () => setRunUi((s) => ({ ...s, idx: !s.playing && s.idx >= tracesLen - 1 ? 0 : s.idx, playing: !s.playing })), onDryRun: handleDryRun, onResumeApproval: handleResume, resumeBusy: Boolean(ui.busy.resume), dryRunBusy: Boolean(ui.busy.dryRun),
      }),
      dsl.open ? h('div', { 'data-testid': 'dxos-flow-dsl-modal', style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 } },
        h('div', { style: { width: 680, maxWidth: '100%', background: '#ffffff', borderRadius: 12, padding: 16, display: 'grid', gap: 10, boxShadow: '0 12px 32px rgba(15,23,42,0.2)' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('strong', { style: { fontSize: 14 } }, 'Flow DSL Export / Import (JSON / YAML)'),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('select', { 'data-testid': 'dxos-flow-dsl-format-select', value: dsl.format, style: INP, onChange: (e) => { const fmt = e?.target?.value === 'yaml' ? 'yaml' : 'json'; setDsl((m) => ({ ...m, format: fmt, text: serializeFlowDsl(dslObj(), fmt), error: null })); } },
                h('option', { value: 'json' }, 'JSON'), h('option', { value: 'yaml' }, 'YAML')),
              h('button', { 'data-testid': 'dxos-flow-dsl-close-btn', type: 'button', onClick: () => setDsl({ open: false, format: dsl.format, text: '', error: null }), style: btnS() }, 'Close'))),
          h('textarea', {
            'data-testid': 'dxos-flow-dsl-textarea', rows: 14, value: dsl.text, onChange: (e) => setDsl((m) => ({ ...m, text: e?.target?.value ?? '', error: null })),
            style: { width: '100%', fontFamily: 'monospace', fontSize: 11, padding: 8, borderRadius: 6, border: '1px solid #cbd5e1', boxSizing: 'border-box' },
          }),
          dsl.error ? h('div', { 'data-testid': 'dxos-flow-dsl-error', style: { color: '#b91c1c', fontSize: 12 } }, dsl.error) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, h('button', { 'data-testid': 'dxos-flow-dsl-import-btn', type: 'button', onClick: handleImportDsl, style: btnS(true) }, 'Import to Canvas')),
        )) : null,
    );
  };
}

module.exports = { createFlowStudioApp, parseDsl: parseDslText, parseDslText, serializeDsl: serializeFlowDsl, serializeFlowDsl, safeJsonParse, nextCollisionFreeId, ruleToGraph, makeBlankFlow, buildRunOverlay, deriveTriggerEventType };
