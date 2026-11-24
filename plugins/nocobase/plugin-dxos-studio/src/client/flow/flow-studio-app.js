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
const { isObj, sanitizeSafeValue, safeJsonParse, parseDslText, serializeFlowDsl, nextCollisionFreeId, ruleToGraph, makeBlankFlow, deriveTriggerEventType, getRunTraces, buildRunOverlay } = require('./flow-dsl');
const { createFlowCanvas } = require('./flow-canvas');
const { createNodePalette } = require('./node-palette');
const { createPlaybackBar } = require('./playback-bar');
const { createNodeInspector } = require('./node-inspector');
const { createFlowListView } = require('./flow-list-view');

const DEFAULT_NODES = [
  ['trigger.event', 'trigger', 'Event Trigger', ['main'], { eventType: '*' }], ['trigger.manual', 'trigger', 'Manual Trigger', ['main'], {}],
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
  graphJson: { version: 2, edges: [{ id: 'e_1', source: 'trig_1', sourceHandle: 'main', target: 'step_1', targetHandle: 'in' }], nodes: [{ id: 'trig_1', type: tType, label: 'Trigger', position: { x: 80, y: 180 }, config: tCfg }, { id: 'step_1', type: sType, label: sLabel, position: { x: 380, y: 180 }, config: sCfg }], settings: { errorPolicy: 'stop', cooldownSec: 60, maxDepth: 8, timeoutMs: 30000 } },
}));

const ROW = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const INP = { padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#ffffff', color: '#0f172a', width: '100%', boxSizing: 'border-box' };
const unwrap = (r) => r?.data?.data ?? r?.data ?? {};
const errMsg = (e, fb) => e?.response?.data?.errors?.[0]?.message || e?.response?.data?.message || e?.message || fb;
const primaryEvt = (a, b) => String(a || b || 'manual.trigger').split(',')[0].trim() || 'manual.trigger';
const cleanCtx = (v, max = 80) => String(v || '').replace(/[\r\n\t\0<>[\]{}`#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const syncMeta = (s, cdVal, mdVal) => {
  const [cd, md] = [cdVal ?? s?.cooldownSec, mdVal ?? s?.maxDepth];
  return { ...(cd != null && cd !== '' && Number.isFinite(Number(cd)) ? { cooldownSec: Number(cd) } : {}), ...(md != null && md !== '' && Number.isFinite(Number(md)) ? { maxDepth: Number(md) } : {}) };
};
const btnS = (tone = 'ghost', dis = false) => {
  const m = { pri: ['#2563EB', '#ffffff', '#2563EB'], ai: ['#0F172A', '#ffffff', '#0F172A'], act: ['#EFF6FF', '#1D4ED8', '#93C5FD'], run: ['#0F766E', '#ffffff', '#0F766E'], ghost: ['#ffffff', '#0f172a', '#cbd5e1'] }[tone] || ['#ffffff', '#0f172a', '#cbd5e1'];
  return { padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', cursor: dis ? 'not-allowed' : 'pointer', border: `1px solid ${dis ? '#cbd5e1' : m[2]}`, background: dis ? '#e2e8f0' : m[0], color: dis ? '#94a3b8' : m[1] };
};
const freshDoc = (seed) => { const b = makeBlankFlow(seed); return { rule: b.rule, graph: b.graph, undo: [], redo: [], selId: null, preDragGraph: null }; };
const FRESH_DATA = { rules: [], runs: [], catalog: null, regTypes: [], loading: false };
const FRESH_RUN = { selectedRun: null, idx: 0, playing: false, testOut: null, autoExpandSeq: 0 };
const makeFreshUi = (view) => ({ view, settingsOpen: false, bpOpen: false, paletteOpen: false, insertEdge: null, fb: null, busy: {}, inspTab: null, inspTabSeq: 0 });

function createFlowStudioApp(client, React, _antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const [FlowCanvas, NodePalette, PlaybackBar, NodeInspector, FlowListView] = [createFlowCanvas(React, vendor), createNodePalette(React), createPlaybackBar(React), createNodeInspector(React), createFlowListView(React)];

  return function FlowStudioApp(props = {}) {
    const api = props.api || useApi();
    const [urlInit] = React.useState(() => { try { const p = new URLSearchParams(window?.location?.search || ''); return { org: p.get('organizationId') || '', ruleKey: p.get('ruleKey') || '' }; } catch { return { org: '', ruleKey: '' }; } });
    const defaultView = (props.ruleKey || urlInit.ruleKey || props.initialView === 'editor') ? 'editor' : 'list';
    const [discoveredOrgs, setDiscoveredOrgs] = React.useState([]);
    const [orgProbeDone, setOrgProbeDone] = React.useState(false);
    const [orgOverride, setOrgOverride] = React.useState(null);
    React.useEffect(() => { setOrgOverride(null); }, [props.selectedOrg]);
    const orgList = Array.isArray(props.organizations) && props.organizations.length ? props.organizations : discoveredOrgs;
    const effectiveOrg = String(orgOverride !== null ? orgOverride : (props.selectedOrg || urlInit.org || orgList[0] || '')).trim();
    const waitOrgProbe = !effectiveOrg && orgOverride === null && !props.selectedOrg && !(Array.isArray(props.organizations) && props.organizations.length) && !orgProbeDone;
    const orgPayload = effectiveOrg ? { organizationId: effectiveOrg } : {};
    const [doc, setDoc] = React.useState(() => freshDoc(effectiveOrg || 1));
    const [data, setData] = React.useState(FRESH_DATA);
    const [runUi, setRunUi] = React.useState(FRESH_RUN);
    const [ui, setUi] = React.useState(() => makeFreshUi(defaultView));
    const [dsl, setDsl] = React.useState({ open: false, format: 'json', text: '', error: null });
    const [refs] = React.useState(() => ({ loadSeq: 0, actionEpoch: 0, activeOrg: effectiveOrg, latestOrg: effectiveOrg, api, idSeq: 1, initDone: false }));
    refs.api = api; refs.latestOrg = effectiveOrg;

    const reportFb = (fb) => (typeof props.setFeedback === 'function' ? (props.setFeedback(fb), setUi((u) => ({ ...u, fb: null }))) : setUi((u) => ({ ...u, fb })));
    const nextId = (pfx, g = doc.graph) => nextCollisionFreeId(pfx, g);
    const setRunWithIdx = (r, expand = false) => setRunUi((s) => ({ ...s, playing: false, selectedRun: r, idx: Math.max(0, getRunTraces(r).length - 1), autoExpandSeq: expand ? (s.autoExpandSeq || 0) + 1 : s.autoExpandSeq }));
    const applyRule = React.useCallback((r) => {
      const g = ruleToGraph(r); refs.initDone = true; refs.docRule = r;
      setDoc({ rule: { ...r, cooldownSec: g.settings.cooldownSec, maxDepth: g.settings.maxDepth }, graph: g, undo: [], redo: [], selId: null, preDragGraph: null });
      setRunUi((s) => ({ ...s, testOut: null, selectedRun: (s.selectedRun && r?.ruleKey && s.selectedRun.ruleKey && s.selectedRun.ruleKey !== r.ruleKey) ? null : s.selectedRun }));
      setUi((u) => ({ ...u, insertEdge: null, settingsOpen: false, bpOpen: false }));
    }, []);

    React.useEffect(() => {
      Object.assign(refs, { activeOrg: effectiveOrg, actionEpoch: refs.actionEpoch + 1, loadSeq: refs.loadSeq + 1, initDone: false, docRule: null });
      setDoc(freshDoc(effectiveOrg || 1)); setData(FRESH_DATA); setRunUi(FRESH_RUN);
      setUi(makeFreshUi((props.ruleKey || urlInit.ruleKey || props.initialView === 'editor') ? 'editor' : 'list'));
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
      if (!props.selectedOrg && !props.organizations?.length && !discoveredOrgs.length) get('dxosStudio:listEmployees', (d) => Array.isArray(d?.organizations) && d.organizations.length && setDiscoveredOrgs(d.organizations), null, () => setOrgProbeDone(true));
      if (waitOrgProbe) return;
      get('dxosAutomations:builderCatalog', (d) => patchD({ catalog: d || null }), () => patchD({ catalog: null }));
      get('dxosAutomations:nodeRegistry', (d) => Array.isArray(d.nodeTypes) && patchD({ regTypes: d.nodeTypes }));
      get('dxosAutomations:listRules', (d) => {
        const items = Array.isArray(d.items) ? d.items : [];
        patchD({ rules: items });
        if (!refs.initDone) { refs.initDone = true; const w = props.ruleKey || urlInit.ruleKey; if (items.length && (w || props.initialView === 'editor')) applyRule((w && items.find((x) => x.ruleKey === w)) || items[0]); }
      }, (err) => reportFb({ type: 'error', text: errMsg(err, 'Không tải được danh sách Flow.') }), () => patchD({ loading: false }));
      get('dxosAutomations:listRuns', (d) => {
        const nextRuns = Array.isArray(d.items) ? d.items : [];
        patchD({ runs: nextRuns });
        if (nextRuns.length) setRunUi((s) => {
          if (s.selectedRun) return { ...s, selectedRun: nextRuns.find((r) => r.runUid && r.runUid === s.selectedRun.runUid) || s.selectedRun };
          const pick = nextRuns.find((r) => r.ruleKey && r.ruleKey === refs.docRule?.ruleKey) || (!refs.docRule?.ruleKey ? nextRuns[0] : null);
          return pick ? { ...s, selectedRun: pick, idx: Math.max(0, getRunTraces(pick).length - 1) } : s;
        });
      });
    }, [effectiveOrg, waitOrgProbe, Boolean(api?.request)]);

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
      const selId = nextSel !== undefined ? nextSel : (d.selId && g.nodes.some((n) => n.id === d.selId) ? d.selId : null);
      const patch = rulePatch ? { rule: { ...d.rule, ...rulePatch } } : {};
      if (opts.skipUndo) return { ...d, preDragGraph: d.preDragGraph || d.graph, graph: g, selId, ...patch };
      return { ...d, preDragGraph: null, undo: [...d.undo.slice(-39), d.preDragGraph || d.graph], redo: [], graph: g, selId, ...patch };
    });
    const handleRuleMeta = (meta) => setDoc((d) => {
      const hasS = meta.cooldownSec !== undefined || meta.maxDepth !== undefined;
      const nextS = hasS ? { ...(d.graph.settings || {}), ...(meta.cooldownSec !== undefined ? { cooldownSec: meta.cooldownSec } : {}), ...(meta.maxDepth !== undefined ? { maxDepth: meta.maxDepth } : {}) } : d.graph.settings;
      return { ...d, rule: { ...d.rule, ...meta }, graph: hasS ? { ...d.graph, settings: nextS } : d.graph };
    });

    React.useEffect(() => {
      if (typeof window === 'undefined') return undefined;
      window.__LATTICEDX_FLOW_CONTEXT__ = {
        organizationId: effectiveOrg, view: ui.view, ruleKey: doc.rule.ruleKey || '', ruleName: doc.rule.name || '',
        selectedNodeId: doc.selId || '', selectedNodeType: selectedNode?.type || '', selectedNodeLabel: selectedNode?.label || '',
        selectedRunUid: runUi.selectedRun?.runUid || '', selectedRunStatus: runUi.selectedRun?.status || '',
        nodeCount: Array.isArray(doc.graph?.nodes) ? doc.graph.nodes.length : 0,
        nodeSummary: (doc.graph?.nodes || []).slice(0, 20).map((n) => ({ id: n.id, type: n.type, label: n.label || '' })),
      };
      return () => { if (typeof window !== 'undefined') delete window.__LATTICEDX_FLOW_CONTEXT__; };
    }, [effectiveOrg, ui.view, doc.rule.ruleKey, doc.rule.name, doc.selId, doc.graph.nodes, runUi.selectedRun]);

    Object.assign(refs, { commitGraph, handleRuleMeta, loadAll, reportFb, setRunWithIdx, docRule: doc.rule });
    React.useEffect(() => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
      const onFlowUpdated = (evt) => {
        const d = evt?.detail;
        if (!d || typeof d !== 'object') return;
        if (d.organizationId && refs.latestOrg && String(d.organizationId) !== refs.latestOrg) return;
        const nextRaw = d.draftGraph || d.draftRule?.graphJson;
        if (nextRaw && Array.isArray(nextRaw.nodes)) {
          const g = ruleToGraph({ graphJson: nextRaw, cooldownSec: d.draftRule?.cooldownSec ?? refs.docRule?.cooldownSec, maxDepth: d.draftRule?.maxDepth ?? refs.docRule?.maxDepth });
          const cleanMeta = d.draftRule ? sanitizeSafeValue({ ...d.draftRule, graphJson: undefined }) : {};
          if (d.ruleKey && !cleanMeta.ruleKey) cleanMeta.ruleKey = String(d.ruleKey);
          refs.commitGraph(g, null, { ...cleanMeta, cooldownSec: g.settings.cooldownSec, maxDepth: g.settings.maxDepth });
          setUi((u) => (u.view === 'list' ? { ...u, view: 'editor' } : u));
        } else if (d.draftRule) { refs.handleRuleMeta(sanitizeSafeValue(d.draftRule)); setUi((u) => (u.view === 'list' ? { ...u, view: 'editor' } : u)); }
        if (d.simulation || d.run) refs.setRunWithIdx(sanitizeSafeValue(d.simulation || d.run), true);
        if (d.message) refs.reportFb({ type: 'success', text: String(d.message) });
        if (d.applied === true) refs.loadAll?.();
      };
      window.addEventListener('latticedx:flow-updated', onFlowUpdated);
      return () => window.removeEventListener?.('latticedx:flow-updated', onFlowUpdated);
    }, []);

    const makeNode = (schema, pos) => ({ id: nextId(String(schema.type || 'node').split('.').pop() || 'node', doc.graph), type: schema.type, label: schema.label || schema.type, continueOnFail: false, position: pos || { x: 120 + (doc.graph.nodes.length % 5) * 240, y: 160 + Math.floor(doc.graph.nodes.length / 5) * 140 }, config: sanitizeSafeValue(schema.defaultConfig || {}) });
    const addNodeOnly = (schema, pos) => { const n = makeNode(schema, pos); setUi((u) => (u.insertEdge ? { ...u, insertEdge: null } : u)); return commitGraph({ ...doc.graph, nodes: [...doc.graph.nodes, n] }, n.id); };
    const insertBetweenEdge = (schema) => {
      const e = ui.insertEdge; if (!e) return addNodeOnly(schema);
      const [srcN, dstN] = [doc.graph.nodes.find((x) => x.id === e.source), doc.graph.nodes.find((x) => x.id === e.target)];
      const pos = srcN && dstN ? { x: Math.round(((srcN.position?.x || 0) + (dstN.position?.x || 240)) / 2), y: Math.round(((srcN.position?.y || 160) + (dstN.position?.y || 160)) / 2) } : null;
      const n = makeNode(schema, pos), outPort = schema.outputs?.[0] || (schema.type === 'control.if' ? 'true' : schema.type === 'control.approval' ? 'approved' : 'main');
      const e1 = { id: nextId('edge', doc.graph), source: e.source, sourceHandle: e.sourceHandle || 'main', target: n.id, targetHandle: 'in', label: e.label || null };
      const e2 = { id: nextId('edge', { nodes: [...doc.graph.nodes, n], edges: [...doc.graph.edges, e1] }), source: n.id, sourceHandle: outPort, target: e.target, targetHandle: e.targetHandle || 'in', label: null };
      setUi((u) => ({ ...u, insertEdge: null }));
      return commitGraph({ ...doc.graph, nodes: [...doc.graph.nodes, n], edges: [...doc.graph.edges.filter((x) => x.id !== e.id), e1, e2] }, n.id);
    };
    const handleConnect = (p) => {
      if (!p?.source || !p?.target || p.source === p.target) return;
      const [sh, th] = [p.sourceHandle || 'main', p.targetHandle || 'in'];
      if (!doc.graph.edges.some((e) => e.source === p.source && (e.sourceHandle || 'main') === sh && e.target === p.target && (e.targetHandle || 'in') === th)) commitGraph({ ...doc.graph, edges: [...doc.graph.edges, { id: nextId('edge', doc.graph), source: p.source, sourceHandle: sh, target: p.target, targetHandle: th, label: p.label || null }] });
    };
    const handleDuplicateNode = (nodeId) => {
      const src = doc.graph.nodes.find((n) => n.id === nodeId); if (!src) return;
      const copy = { ...src, id: nextId(String(src.type || 'node').split('.').pop() || 'node', doc.graph), label: `${src.label || src.type} (Copy)`, position: { x: Number(src.position?.x || 120) + 40, y: Number(src.position?.y || 160) + 40 }, config: sanitizeSafeValue(src.config || {}) };
      commitGraph({ ...doc.graph, nodes: [...doc.graph.nodes, copy] }, copy.id);
    };
    const handleDeleteNode = (nodeId) => commitGraph((g) => ({ ...g, nodes: g.nodes.filter((n) => n.id !== nodeId), edges: g.edges.filter((e) => e.source !== nodeId && e.target !== nodeId) }), null);

    const buildSavePayload = () => ({ ...orgPayload, ruleKey: String(doc.rule.ruleKey || '').trim(), name: String(doc.rule.name || '').trim(), description: doc.rule.description || null, triggerEventType: deriveTriggerEventType(doc.graph, doc.rule), filterJson: doc.rule.filterJson ?? null, dmnTableKey: doc.rule.dmnTableKey || null, cooldownSec: Number(doc.rule.cooldownSec ?? doc.graph.settings?.cooldownSec ?? 0), maxDepth: Number(doc.rule.maxDepth ?? doc.graph.settings?.maxDepth ?? 8), active: doc.rule.active !== false, schemaVersion: 2, graphJson: doc.graph });
    async function runAction(key, url, body, onOk, onErr) {
      if (!refs.api?.request || ui.busy[key]) return;
      const [reqOrg, reqEpoch] = [effectiveOrg, refs.actionEpoch];
      const isFresh = () => reqOrg === refs.activeOrg && reqOrg === refs.latestOrg && reqEpoch === refs.actionEpoch;
      setUi((u) => ({ ...u, busy: { ...u.busy, [key]: true } }));
      try { const res = await refs.api.request({ url, method: 'post', data: body }); if (isFresh()) await onOk(unwrap(res)); }
      catch (err) { if (isFresh()) { if (onErr) onErr(err); else reportFb({ type: 'error', text: errMsg(err, 'Thao tác thất bại.') }); } }
      finally { if (isFresh()) setUi((u) => ({ ...u, busy: { ...u.busy, [key]: false } })); }
    }
    const doneRun = (msg) => (d) => { const r = d.run || d; setRunWithIdx(r, true); reportFb({ type: 'success', text: `${msg} (${r?.status || 'completed'}).` }); loadAll(); };
    const sampleEvt = (p) => doc.rule.sampleEvent || { type: primaryEvt(p.triggerEventType, doc.rule.triggerEventType), data: {} };
    const handleSave = () => { const p = buildSavePayload(); if (!p.ruleKey || !p.name) return reportFb({ type: 'error', text: 'Rule Key và Rule Name không được để trống.' }); return runAction('save', 'dxosAutomations:saveRule', p, (d) => { if (d.rule) setDoc((s) => ({ ...s, rule: { ...s.rule, ...d.rule } })); reportFb({ type: 'success', text: `Đã lưu & publish "${p.ruleKey}".` }); loadAll(); }); };
    const handleDryRun = () => { setRunUi((s) => ({ ...s, playing: false })); const p = buildSavePayload(); return runAction('dryRun', 'dxosAutomations:testRule', { ...orgPayload, rule: p, sampleEvent: sampleEvt(p), useDraft: true }, (d) => setRunWithIdx(d.simulation || d.run || d, true)); };
    const handleRunNow = (targetRule) => { const r = targetRule || doc.rule; const ev = r.sampleEvent || { type: primaryEvt(targetRule ? r.triggerEventType : deriveTriggerEventType(doc.graph, r), r.triggerEventType), data: {} }; return runAction('runNow', 'dxosAutomations:runNow', { ...orgPayload, ruleKey: r.ruleKey, sampleEvent: ev }, doneRun(`Đã chạy "${r.ruleKey}"`)); };
    const handleTestNode = (nodeId, pinnedInputs) => runAction('testNode', 'dxosAutomations:testNode', { ...orgPayload, ruleKey: doc.rule.ruleKey, graph: doc.graph, nodeId, pinnedInputs }, (d) => setRunUi((s) => ({ ...s, testOut: d.result || d })), (err) => setRunUi((s) => ({ ...s, testOut: { nodeId, status: 'failed', error: errMsg(err, 'Test node failed') } })));
    const handleQuickTestNode = (nodeId) => { const ev = sampleEvt(buildSavePayload()); setDoc((d) => ({ ...d, selId: nodeId })); setUi((u) => ({ ...u, inspTab: 'output', inspTabSeq: (u.inspTabSeq || 0) + 1 })); return handleTestNode(nodeId, { event: ev, data: ev.data || {}, dmn: {}, steps: {} }); };
    const handleResume = (runUid, decision) => runAction('resume', 'dxosAutomations:resumeRun', { ...orgPayload, runUid, decision }, doneRun(`HITL ${decision} hoàn tất`));
    const openRoute = (path) => { if (app?.router?.navigate) app.router.navigate(path); else if (typeof window !== 'undefined' && window.location) window.location.assign(app?.getRouteUrl?.(path) || path); };
    const openAiArchitect = () => {
      const aiCtx = app?.flowEngine?.context?.ai || app?.context?.ai;
      const fallback = () => reportFb({ type: 'info', text: 'Hãy mở trợ lý DX-OS Architect ở góc dưới bên phải màn hình để tạo hoặc sửa workflow.' });
      if (!aiCtx || typeof aiCtx.triggerTask !== 'function') return fallback();
      const sysCtx = `[Ngữ cảnh Workflow Automation: organizationId="${cleanCtx(effectiveOrg, 64)}", view="${ui.view}", ruleKey="${cleanCtx(doc.rule.ruleKey, 64)}", ruleName="${cleanCtx(doc.rule.name, 80)}", nodeCount=${(doc.graph.nodes || []).length}${selectedNode ? `, selectedNodeId="${cleanCtx(selectedNode.id, 64)}", selectedNodeType="${cleanCtx(selectedNode.type, 48)}"` : ''}${runUi.selectedRun?.runUid ? `, selectedRunUid="${cleanCtx(runUi.selectedRun.runUid, 64)}", selectedRunStatus="${cleanCtx(runUi.selectedRun.status, 32)}"` : ''}]\nHãy giao tiếp bằng tiếng Việt tự nhiên, sử dụng công cụ dxos_configure_workflow để dựng bản nháp, chỉnh sửa node, chạy thử Dry-Run hoặc lưu quy trình trực tiếp lên Canvas.`;
      return Promise.resolve(aiCtx.triggerTask({ aiEmployee: 'dxos-architect', auto: true, open: true, tasks: [{ autoSend: false, message: { system: sysCtx } }] })).catch(fallback);
    };
    const handleImportDsl = () => {
      const parsed = parseDslText(dsl.text); if (!parsed.ok) return setDsl((m) => ({ ...m, error: parsed.error }));
      const d = parsed.value, gRaw = isObj(d?.graphJson) ? d.graphJson : (Array.isArray(d?.nodes) ? d : null);
      if (!gRaw || !Array.isArray(gRaw.nodes)) return setDsl((m) => ({ ...m, error: 'DSL phải chứa graphJson.nodes hoặc nodes[].' }));
      const nextG = ruleToGraph({ graphJson: gRaw, cooldownSec: d.cooldownSec ?? gRaw.settings?.cooldownSec ?? doc.rule.cooldownSec, maxDepth: d.maxDepth ?? gRaw.settings?.maxDepth ?? doc.rule.maxDepth });
      const sMeta = syncMeta(nextG.settings, d.cooldownSec, d.maxDepth);
      const syncedG = Object.keys(sMeta).length ? { ...nextG, settings: { ...(nextG.settings || {}), ...sMeta } } : nextG;
      const meta = { ...(isObj(d?.graphJson) ? { ...(d.ruleKey ? { ruleKey: String(d.ruleKey) } : {}), ...(d.name ? { name: String(d.name) } : {}) } : {}), ...sMeta };
      commitGraph(syncedG, null, Object.keys(meta).length ? meta : null);
      return setDsl({ open: false, format: dsl.format, text: '', error: null });
    };
    const undoRedo = (dir) => setDoc((d) => {
      const src = dir < 0 ? d.undo : d.redo; if (!src.length) return d;
      const target = src[src.length - 1], sMeta = syncMeta(target.settings);
      return { ...d, preDragGraph: null, rule: Object.keys(sMeta).length ? { ...d.rule, ...sMeta } : d.rule, graph: target, selId: d.selId && target.nodes.some((n) => n.id === d.selId) ? d.selId : null, undo: dir < 0 ? d.undo.slice(0, -1) : [...d.undo, d.graph], redo: dir < 0 ? [...d.redo, d.graph] : d.redo.slice(0, -1) };
    });
    const openRuleInEditor = (ruleOrKey) => {
      const found = typeof ruleOrKey === 'string' ? data.rules.find((r) => r.ruleKey === ruleOrKey) : ruleOrKey;
      if (found) {
        applyRule(found);
        const mr = data.runs.find((x) => x.ruleKey === found.ruleKey && x.status === 'suspended') || data.runs.find((x) => x.ruleKey === found.ruleKey);
        if (mr) setRunWithIdx(mr, mr.status === 'suspended'); else setRunUi(FRESH_RUN);
      }
      setUi((u) => ({ ...u, view: 'editor', bpOpen: false, settingsOpen: false }));
    };
    const handleNewFlow = () => { const f = freshDoc((refs.idSeq += 1)); refs.docRule = f.rule; setDoc(f); setRunUi(FRESH_RUN); setUi((u) => ({ ...u, view: 'editor', insertEdge: null, bpOpen: false, settingsOpen: false })); };
    const loadBlueprint = (bp) => { applyRule(bp); setRunUi(FRESH_RUN); setUi((u) => ({ ...u, view: 'editor', bpOpen: false, settingsOpen: false })); };

    const dslObj = () => ({ ruleKey: doc.rule.ruleKey, name: doc.rule.name, cooldownSec: doc.rule.cooldownSec ?? 0, maxDepth: doc.rule.maxDepth ?? 8, graphJson: doc.graph });
    const tracesLen = getRunTraces(runUi.selectedRun).length;
    const activeFb = props.setFeedback ? null : ui.fb;
    const fbBar = activeFb ? h('div', { 'data-testid': 'dxos-flow-feedback', role: 'status', style: { padding: '6px 14px', fontSize: 12, background: activeFb.type === 'error' ? '#fef2f2' : activeFb.type === 'info' ? '#eff6ff' : '#f0fdf4', color: activeFb.type === 'error' ? '#991b1b' : activeFb.type === 'info' ? '#1e40af' : '#166534', borderBottom: '1px solid #e2e8f0' } }, activeFb.text) : null;
    const settingFields = [
      ['Rule Key', 'dxos-flow-rule-key-input', 'text', doc.rule.ruleKey ?? '', (v) => handleRuleMeta({ ruleKey: v })],
      ['Rule Name', 'dxos-flow-rule-name-input', 'text', doc.rule.name ?? '', (v) => handleRuleMeta({ name: v })],
      ['Cooldown (sec)', 'dxos-flow-rule-cooldown-input', 'number', doc.rule.cooldownSec ?? doc.graph.settings?.cooldownSec ?? 0, (v) => handleRuleMeta({ cooldownSec: Math.max(0, Math.floor(Number(v) || 0)) }), { min: 0 }],
      ['Max Depth (1..8)', 'dxos-flow-rule-maxdepth-input', 'number', doc.rule.maxDepth ?? doc.graph.settings?.maxDepth ?? 8, (v) => handleRuleMeta({ maxDepth: Math.min(8, Math.max(1, Math.floor(Number(v) || 8))) }), { min: 1, max: 8 }],
    ];
    const tools = [
      ['dxos-flow-dsl-btn', '{ } DSL', () => setDsl({ open: true, format: 'json', text: serializeFlowDsl(dslObj(), 'json'), error: null }), 'ghost', false],
      ['dxos-flow-open-architect-btn', '✦ AI Architect', openAiArchitect, 'ai', false],
      ['dxos-flow-dryrun-btn', '▶ Chạy thử', handleDryRun, 'act', Boolean(ui.busy.dryRun)],
      ['dxos-flow-save-btn', 'Lưu', handleSave, 'pri', data.loading || Boolean(ui.busy.save)],
      ['dxos-flow-run-now-btn', '⚡ Chạy ngay', () => handleRunNow(), 'run', Boolean(ui.busy.runNow)],
    ];

    return h('div', { 'data-testid': 'dxos-flow-studio-app', style: { height: props.embedded ? 640 : 'calc(100vh - 110px)', minHeight: 580, display: 'flex', flexDirection: 'column', background: '#f8fafc', overflow: 'hidden', position: 'relative' } },
      ui.view === 'list' ? h(React.Fragment, null, fbBar, h(FlowListView, { rules: data.rules, runs: data.runs, blueprints, loading: data.loading, runBusy: Boolean(ui.busy.runNow), effectiveOrg, orgList, onOrgChange: setOrgOverride, bpOpen: ui.bpOpen, onToggleBlueprints: (force) => setUi((u) => ({ ...u, bpOpen: typeof force === 'boolean' ? force : !u.bpOpen })), onLoadBlueprint: loadBlueprint, onOpenRule: openRuleInEditor, onRunNow: handleRunNow, onNewFlow: handleNewFlow, onOpenAiArchitect: openAiArchitect, onOpenRoute: openRoute }))
        : h(React.Fragment, null,
          h('header', { 'data-testid': 'dxos-flow-toolbar', style: { minHeight: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: '6px 14px', borderBottom: '1px solid #e2e8f0', background: '#ffffff', boxSizing: 'border-box' } },
            h('div', { style: ROW },
              h('button', { 'data-testid': 'dxos-flow-back-to-list-btn', type: 'button', onClick: () => setUi((u) => ({ ...u, view: 'list', settingsOpen: false, bpOpen: false })), style: btnS('ghost') }, '← Danh sách'),
              h('strong', { style: { fontSize: 14, color: '#0f172a' } }, doc.rule.name || doc.rule.ruleKey || 'Workflow'),
              h('span', { style: { fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: doc.rule.active === false ? '#f1f5f9' : '#ecfdf5', color: doc.rule.active === false ? '#475569' : '#047857' } }, doc.rule.active === false ? 'Tạm dừng' : 'Đang bật'),
              effectiveOrg ? h('code', { style: { fontSize: 11, color: '#475569', background: '#f1f5f9', padding: '2px 6px', borderRadius: 6 } }, effectiveOrg) : null,
              h('button', { 'data-testid': 'dxos-flow-settings-btn', type: 'button', onClick: () => setUi((u) => ({ ...u, settingsOpen: !u.settingsOpen })), style: btnS(ui.settingsOpen ? 'act' : 'ghost') }, '⚙️ Cài đặt'),
            ),
            h('div', { style: ROW }, tools.map(([tid, lbl, onClick, tone, dis]) => h('button', { key: tid, 'data-testid': tid, type: 'button', disabled: dis, onClick, style: btnS(tone, dis) }, lbl))),
          ),
          fbBar,
          ui.settingsOpen ? h('div', { 'data-testid': 'dxos-flow-settings-popover', style: { position: 'absolute', top: 54, left: 14, zIndex: 35, width: 340, maxWidth: 'calc(100% - 28px)', padding: 14, borderRadius: 12, border: '1px solid #cbd5e1', background: '#ffffff', boxShadow: '0 14px 34px rgba(15,23,42,0.16)', display: 'grid', gap: 10 } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('strong', { style: { fontSize: 13, color: '#0f172a' } }, 'Cài đặt Workflow'), h('button', { type: 'button', 'data-testid': 'dxos-flow-settings-close-btn', onClick: () => setUi((u) => ({ ...u, settingsOpen: false })), style: btnS('ghost') }, '×')),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } }, settingFields.map(([lbl, tid, type, val, onVal, extra = {}]) => h('div', { key: tid }, h('label', { style: { fontSize: 11, fontWeight: 600 } }, lbl), h('input', { 'data-testid': tid, type, value: val, ...extra, onChange: (e) => onVal(e?.target?.value ?? ''), style: INP })))),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 } }, h('input', { 'data-testid': 'dxos-flow-rule-active-checkbox', type: 'checkbox', checked: doc.rule.active !== false, onChange: (e) => handleRuleMeta({ active: Boolean(e?.target?.checked) }) }), 'Kích hoạt Rule'),
              h('button', { 'data-testid': 'dxos-flow-blueprints-btn', type: 'button', onClick: () => setUi((u) => ({ ...u, bpOpen: !u.bpOpen, settingsOpen: false })), style: btnS('act') }, `Mẫu sẵn có (${blueprints.length})`),
            ),
          ) : null,
          ui.bpOpen ? h('div', { 'data-testid': 'dxos-flow-blueprints-gallery', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, padding: 10, background: '#f1f5f9', borderBottom: '1px solid #cbd5e1', maxHeight: 220, overflowY: 'auto' } },
            blueprints.map((bp) => h('div', { key: bp.blueprintKey || bp.ruleKey, style: { padding: 8, borderRadius: 8, background: '#ffffff', border: '1px solid #cbd5e1', display: 'grid', gap: 4 } },
              h('strong', { style: { fontSize: 12, color: '#0f172a' } }, bp.name),
              h('span', { style: { fontSize: 11, color: '#64748b' } }, `${bp.category || 'flow'} · ${bp.graphJson?.nodes?.length || 0} nodes`),
              h('button', { 'data-testid': `dxos-flow-blueprint-load-${bp.blueprintKey || bp.ruleKey}`, type: 'button', onClick: () => loadBlueprint(bp), style: btnS('pri') }, 'Load Blueprint'),
            ))) : null,
          h('div', { style: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden', position: 'relative' } },
            h(FlowCanvas, {
              graph: doc.graph, nodeTypes, selectedNodeId: doc.selId, onSelectNode: (id) => setDoc((d) => ({ ...d, selId: id })),
              onConnectNodes: handleConnect, onNodesChangeGraph: (nextArg, meta) => commitGraph(Array.isArray(nextArg) ? (g) => ({ ...g, nodes: nextArg }) : nextArg, undefined, null, { skipUndo: Boolean(meta && !Array.isArray(meta) && meta.skipUndo === true) }),
              onInsertBetweenEdge: (e) => setUi((u) => ({ ...u, insertEdge: e })), runOverlay, onAutoLayout: (nextG) => commitGraph(nextG),
              onAddNode: addNodeOnly, onDropNode: addNodeOnly, onQuickTestNode: handleQuickTestNode, onDuplicateNode: handleDuplicateNode, onDeleteNode: handleDeleteNode,
              canUndo: doc.undo.length > 0, canRedo: doc.redo.length > 0, onUndo: () => undoRedo(-1), onRedo: () => undoRedo(1), xyflowOverride: props.xyflowOverride,
            }),
            h(NodePalette, { nodeTypes, onAddNode: addNodeOnly, insertEdge: ui.insertEdge, onInsertNode: insertBetweenEdge, onCancelInsert: () => setUi((u) => ({ ...u, insertEdge: null })), open: ui.paletteOpen, onToggleOpen: (next) => setUi((u) => ({ ...u, paletteOpen: Boolean(next) })) }),
            h(NodeInspector, { rule: doc.rule, graph: doc.graph, selectedNode, nodeSchema: selectedSchema, catalog, activeTrace, testOutput: runUi.testOut, testBusy: Boolean(ui.busy.testNode), onTestNode: handleTestNode, onCloseInspector: () => setDoc((d) => ({ ...d, selId: null })), onUpdateNode: (id, pt) => commitGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...pt } : n)) })), onDeleteNode: handleDeleteNode, externalTab: ui.inspTab, externalTabSeq: ui.inspTabSeq }),
          ),
          h(PlaybackBar, { runs: data.runs, selectedRun: runUi.selectedRun, onSelectRun: (r) => setRunWithIdx(r, false), playbackIndex: runUi.idx, onStepChange: (idx) => setRunUi((s) => ({ ...s, playing: false, idx })), playing: runUi.playing, onTogglePlay: () => setRunUi((s) => ({ ...s, idx: !s.playing && s.idx >= tracesLen - 1 ? 0 : s.idx, playing: !s.playing })), onResumeApproval: handleResume, resumeBusy: Boolean(ui.busy.resume), autoExpandSeq: runUi.autoExpandSeq }),
        ),
      dsl.open ? h('div', { 'data-testid': 'dxos-flow-dsl-modal', style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 } },
        h('div', { style: { width: 680, maxWidth: '100%', background: '#ffffff', borderRadius: 12, padding: 16, display: 'grid', gap: 10, boxShadow: '0 12px 32px rgba(15,23,42,0.2)' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('strong', { style: { fontSize: 14 } }, 'Flow DSL Export / Import (JSON / YAML)'),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('select', { 'data-testid': 'dxos-flow-dsl-format-select', value: dsl.format, style: { ...INP, width: 'auto' }, onChange: (e) => { const fmt = e?.target?.value === 'yaml' ? 'yaml' : 'json'; setDsl((m) => ({ ...m, format: fmt, text: serializeFlowDsl(dslObj(), fmt), error: null })); } }, h('option', { value: 'json' }, 'JSON'), h('option', { value: 'yaml' }, 'YAML')),
              h('button', { 'data-testid': 'dxos-flow-dsl-close-btn', type: 'button', onClick: () => setDsl({ open: false, format: dsl.format, text: '', error: null }), style: btnS('ghost') }, 'Close'))),
          h('textarea', { 'data-testid': 'dxos-flow-dsl-textarea', rows: 14, value: dsl.text, onChange: (e) => setDsl((m) => ({ ...m, text: e?.target?.value ?? '', error: null })), style: { width: '100%', fontFamily: 'monospace', fontSize: 11, padding: 8, borderRadius: 6, border: '1px solid #cbd5e1', boxSizing: 'border-box' } }),
          dsl.error ? h('div', { 'data-testid': 'dxos-flow-dsl-error', style: { color: '#b91c1c', fontSize: 12 } }, dsl.error) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, h('button', { 'data-testid': 'dxos-flow-dsl-import-btn', type: 'button', onClick: handleImportDsl, style: btnS('pri') }, 'Import to Canvas')),
        )) : null,
    );
  };
}

module.exports = { createFlowStudioApp, parseDsl: parseDslText, parseDslText, serializeDsl: serializeFlowDsl, serializeFlowDsl, safeJsonParse, nextCollisionFreeId, ruleToGraph, makeBlankFlow, buildRunOverlay, deriveTriggerEventType };
