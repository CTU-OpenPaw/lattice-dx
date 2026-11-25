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
const {
  DEFAULT_NODES, DEFAULT_BLUEPRINTS, ROW, INP, unwrap, errMsg, primaryEvt, cleanCtx,
  syncMeta, btnS, freshDoc: makeFreshDoc, FRESH_DATA, FRESH_RUN, makeFreshUi, buildRuleSavePayload, dispatchFlowKeyDown,
  renderValidationPopover, renderSettingsPopover, renderBlueprintsGallery, renderDslModal, renderUnsavedGuard,
  renderSseDiffBanner,
} = require('./flow-studio-helpers');
const { validateFlowClient, buildUpstreamPinnedInputs, computeGraphDiffSummary } = require('./flow-validation');
const { createFlowTestRunner } = require('./flow-test-runner');
const { createFlowCanvas } = require('./flow-canvas');
const { createNodePalette } = require('./node-palette');
const { createPlaybackBar } = require('./playback-bar');
const { createNodeInspector } = require('./node-inspector');
const { createFlowListView } = require('./flow-list-view');
const { createN8nSetupModal } = require('./n8n-setup-modal');

const freshDoc = (seed) => makeFreshDoc(seed, makeBlankFlow);

function createFlowStudioApp(client, React, _antd, app, opts = {}) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const [FlowCanvas, NodePalette, PlaybackBar, NodeInspector, FlowListView, FlowTestRunner, N8nSetupModal] = [
    createFlowCanvas(React, vendor), createNodePalette(React), createPlaybackBar(React),
    createNodeInspector(React), createFlowListView(React), createFlowTestRunner(React), createN8nSetupModal(React),
  ];

  return function FlowStudioApp(props = {}) {
    const api = props.api || useApi();
    const pinStorage = props.pinStorage || opts.pinStorage || null;
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
    const [focus, setFocus] = React.useState({ nodeId: null, seq: 0 });
    const [dsl, setDsl] = React.useState({ open: false, format: 'json', text: '', error: null });
    const [sseDiff, setSseDiff] = React.useState(null);
    const [refs] = React.useState(() => ({ loadSeq: 0, actionEpoch: 0, activeOrg: effectiveOrg, latestOrg: effectiveOrg, api, idSeq: 1, initDone: false }));
    refs.api = api; refs.latestOrg = effectiveOrg;

    const focusNode = (nodeId) => nodeId && setFocus((f) => ({ nodeId, seq: f.seq + 1 }));
    const reportFb = (fb) => (typeof props.setFeedback === 'function' ? (props.setFeedback(fb), setUi((u) => ({ ...u, fb: null }))) : setUi((u) => ({ ...u, fb })));
    const nextId = (pfx, g = doc.graph) => nextCollisionFreeId(pfx, g);
    const setRunWithIdx = (r, expand = false) => setRunUi((s) => ({ ...s, playing: false, selectedRun: r, idx: Math.max(0, getRunTraces(r).length - 1), autoExpandSeq: expand ? (s.autoExpandSeq || 0) + 1 : s.autoExpandSeq }));
    const applyRule = React.useCallback((r, opts = {}) => {
      const g = ruleToGraph(r); refs.initDone = true; refs.docRule = r;
      setDoc({ rule: { ...r, cooldownSec: g.settings.cooldownSec, maxDepth: g.settings.maxDepth }, graph: g, undo: [], redo: [], selId: null, preDragGraph: null, dirty: Boolean(opts.dirty) });
      setRunUi((s) => ({ ...s, testOut: null, selectedRun: (s.selectedRun && r?.ruleKey && s.selectedRun.ruleKey && s.selectedRun.ruleKey !== r.ruleKey) ? null : s.selectedRun }));
      setUi((u) => ({ ...u, insertEdge: null, appendSource: null, unsavedGuardOpen: false, settingsOpen: false, bpOpen: false, testRunnerOpen: false, valOpen: false }));
      setSseDiff(null);
    }, []);

    React.useEffect(() => {
      Object.assign(refs, { activeOrg: effectiveOrg, actionEpoch: refs.actionEpoch + 1, loadSeq: refs.loadSeq + 1, initDone: false, docRule: null });
      setDoc(freshDoc(effectiveOrg || 1)); setData(FRESH_DATA); setRunUi(FRESH_RUN); setSseDiff(null);
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
    const validation = React.useMemo(() => validateFlowClient(doc.graph, nodeTypes), [doc.graph, nodeTypes]);
    const totalIssues = validation.errors.length + validation.warnings.length;

    const commitGraph = (nextG, nextSel, rulePatch, opts = {}) => setDoc((d) => {
      const g = typeof nextG === 'function' ? nextG(d.graph) : nextG;
      const selId = nextSel !== undefined ? nextSel : (d.selId && g.nodes.some((n) => n.id === d.selId) ? d.selId : null);
      const patch = rulePatch ? { rule: { ...d.rule, ...rulePatch } } : {};
      if (opts.skipUndo) return { ...d, preDragGraph: d.preDragGraph || d.graph, graph: g, selId, dirty: true, ...patch };
      return { ...d, preDragGraph: null, undo: [...d.undo.slice(-39), d.preDragGraph || d.graph], redo: [], graph: g, selId, dirty: true, ...patch };
    });
    const handleRuleMeta = (meta) => setDoc((d) => {
      const hasS = meta.cooldownSec !== undefined || meta.maxDepth !== undefined;
      const nextS = hasS ? { ...(d.graph.settings || {}), ...(meta.cooldownSec !== undefined ? { cooldownSec: meta.cooldownSec } : {}), ...(meta.maxDepth !== undefined ? { maxDepth: meta.maxDepth } : {}) } : d.graph.settings;
      return { ...d, dirty: true, rule: { ...d.rule, ...meta }, graph: hasS ? { ...d.graph, settings: nextS } : d.graph };
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

    Object.assign(refs, { commitGraph, handleRuleMeta, loadAll, reportFb, setRunWithIdx, docRule: doc.rule, docGraph: doc.graph, docDirty: doc.dirty });
    React.useEffect(() => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
      const onFlowUpdated = (evt) => {
        const d = evt?.detail;
        if (!d || typeof d !== 'object') return;
        if (d.organizationId && refs.latestOrg && String(d.organizationId) !== refs.latestOrg) return;
        const nextRaw = d.draftGraph || d.draftRule?.graphJson;
        if (nextRaw && Array.isArray(nextRaw.nodes)) {
          const [prevGraph, prevRule, prevDirty] = [refs.docGraph, refs.docRule, Boolean(refs.docDirty)];
          const g = ruleToGraph({ graphJson: nextRaw, cooldownSec: d.draftRule?.cooldownSec ?? refs.docRule?.cooldownSec, maxDepth: d.draftRule?.maxDepth ?? refs.docRule?.maxDepth });
          const cleanMeta = d.draftRule ? sanitizeSafeValue({ ...d.draftRule, graphJson: undefined }) : {};
          if (d.ruleKey && !cleanMeta.ruleKey) cleanMeta.ruleKey = String(d.ruleKey);
          const diff = computeGraphDiffSummary(prevGraph, g);
          const mutated = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0 || JSON.stringify(prevGraph?.edges || []) !== JSON.stringify(g.edges || []);
          refs.commitGraph(g, null, { ...cleanMeta, cooldownSec: g.settings.cooldownSec, maxDepth: g.settings.maxDepth });
          if (mutated) setSseDiff({ prevGraph, prevRule, prevDirty, nextGraph: g, diff });
          setUi((u) => (u.view === 'list' ? { ...u, view: 'editor' } : u));
        } else if (d.draftRule) { refs.handleRuleMeta(sanitizeSafeValue(d.draftRule)); setUi((u) => (u.view === 'list' ? { ...u, view: 'editor' } : u)); }
        if (d.simulation || d.run) refs.setRunWithIdx(sanitizeSafeValue(d.simulation || d.run), true);
        if (d.message) refs.reportFb({ type: 'success', text: String(d.message) });
        if (d.applied === true) refs.loadAll?.();
      };
      const onAiOpening = () => { setDoc((d) => (d.selId ? { ...d, selId: null } : d)); setUi((u) => ({ ...u, paletteOpen: false, unsavedGuardOpen: false, settingsOpen: false, testRunnerOpen: false, valOpen: false, n8nOpen: false, insertEdge: null, appendSource: null })); };
      window.addEventListener('latticedx:flow-updated', onFlowUpdated);
      window.addEventListener('latticedx:ai-chat-opening', onAiOpening);
      return () => { window.removeEventListener?.('latticedx:flow-updated', onFlowUpdated); window.removeEventListener?.('latticedx:ai-chat-opening', onAiOpening); };
    }, []);

    const makeNode = (schema, pos) => ({ id: nextId(String(schema.type || 'node').split('.').pop() || 'node', doc.graph), type: schema.type, label: schema.label || schema.type, continueOnFail: false, position: pos || { x: 120 + (doc.graph.nodes.length % 5) * 240, y: 160 + Math.floor(doc.graph.nodes.length / 5) * 140 }, config: sanitizeSafeValue(schema.defaultConfig || {}) });
    const addNodeOnly = (schema, pos) => { const n = makeNode(schema, pos); setUi((u) => ((u.insertEdge || u.appendSource) ? { ...u, insertEdge: null, appendSource: null } : u)); return commitGraph({ ...doc.graph, nodes: [...doc.graph.nodes, n] }, n.id); };
    const appendNodeAfter = (schema) => {
      const src = ui.appendSource; if (!src?.nodeId) return addNodeOnly(schema);
      const srcN = doc.graph.nodes.find((x) => x.id === src.nodeId);
      const sibs = doc.graph.edges.filter((e) => e.source === src.nodeId).length;
      const pos = srcN?.position ? { x: Math.round((srcN.position.x || 80) + 290), y: Math.round((srcN.position.y || 180) + sibs * 120) } : null;
      const n = makeNode(schema, pos);
      const edge = { id: nextId('edge', { nodes: [...doc.graph.nodes, n], edges: doc.graph.edges }), source: src.nodeId, sourceHandle: src.sourceHandle || 'main', target: n.id, targetHandle: 'in', label: null };
      setUi((u) => ({ ...u, appendSource: null, paletteOpen: false }));
      return commitGraph({ ...doc.graph, nodes: [...doc.graph.nodes, n], edges: [...doc.graph.edges, edge] }, n.id);
    };
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

    const buildSavePayload = () => buildRuleSavePayload(doc.rule, doc.graph, orgPayload, deriveTriggerEventType);
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
    const sampleEvt = (p, customEv) => customEv || doc.rule.sampleEvent || { type: primaryEvt(p.triggerEventType, doc.rule.triggerEventType), data: {} };
    const saveDraft = async () => {
      const p = buildSavePayload();
      if (!p.ruleKey || !p.name) { reportFb({ type: 'error', text: 'Rule Key và Rule Name không được để trống.' }); return false; }
      let ok = false;
      await runAction('save', 'dxosAutomations:saveRule', p, (d) => { ok = true; refs.docRule = d?.rule ? { ...doc.rule, ...d.rule } : { ...doc.rule, ruleKey: p.ruleKey, name: p.name }; setDoc((s) => ({ ...s, dirty: false, rule: d?.rule ? { ...s.rule, ...d.rule } : s.rule })); reportFb({ type: 'success', text: `Đã lưu & publish "${p.ruleKey}".` }); loadAll(); });
      return ok;
    };
    const handleSave = () => saveDraft();
    const handleDryRun = (customEv) => { setRunUi((s) => ({ ...s, playing: false })); const p = buildSavePayload(); return runAction('dryRun', 'dxosAutomations:testRule', { ...orgPayload, rule: p, sampleEvent: sampleEvt(p, customEv), useDraft: true }, (d) => setRunWithIdx(d.simulation || d.run || d, true)); };
    const handleRunNow = async (targetRule, customEv) => {
      const preRk = String(doc.rule?.ruleKey || '').trim();
      if (!targetRule && (doc.dirty || !preRk || !data.rules.some((x) => x.ruleKey === preRk)) && !(await saveDraft())) return false;
      const r = targetRule || refs.docRule || doc.rule, rk = String(r?.ruleKey || '').trim();
      if (!rk) { reportFb({ type: 'error', text: 'Rule Key không được để trống.' }); return false; }
      const ev = customEv || r.sampleEvent || { type: primaryEvt(targetRule ? r.triggerEventType : deriveTriggerEventType(doc.graph, r), r.triggerEventType), data: {} };
      return runAction('runNow', 'dxosAutomations:runNow', { ...orgPayload, ruleKey: rk, sampleEvent: ev }, doneRun(`Đã chạy "${rk}"`));
    };
    const handleToggleRuleActive = (r) => r?.ruleKey && runAction('toggle', 'dxosAutomations:toggleRule', { ...orgPayload, ruleKey: r.ruleKey, active: r.active === false }, () => { reportFb({ type: 'success', text: `Đã ${r.active === false ? 'kích hoạt' : 'tạm dừng'} "${r.ruleKey}".` }); loadAll(); });
    const handleDeleteRule = (r) => r?.ruleKey && runAction('delete', 'dxosAutomations:deleteRule', { ...orgPayload, ruleKey: r.ruleKey }, () => {
      setData((s) => ({ ...s, rules: s.rules.filter((x) => x.ruleKey !== r.ruleKey) }));
      if (doc.rule?.ruleKey === r.ruleKey) { const f = freshDoc(effectiveOrg || 1); refs.docRule = f.rule; setDoc(f); setRunUi(FRESH_RUN); }
      reportFb({ type: 'success', text: `Đã xóa quy trình "${r.ruleKey}".` }); loadAll();
    });
    const handleDuplicateRule = (r) => {
      const taken = new Set(data.rules.map((x) => x.ruleKey).filter(Boolean));
      let copyKey = `${r.ruleKey || 'rule'}_copy`;
      for (let i = 2; taken.has(copyKey); i += 1) copyKey = `${r.ruleKey || 'rule'}_copy_${i}`;
      applyRule({ ...sanitizeSafeValue(r), ruleKey: copyKey, name: `${r.name || r.ruleKey} (Bản sao)` }, { dirty: true });
      setUi((u) => ({ ...u, view: 'editor' }));
    };
    const handleTestNode = (nodeId, pinnedInputs) => runAction('testNode', 'dxosAutomations:testNode', { ...orgPayload, ruleKey: doc.rule.ruleKey, graph: doc.graph, nodeId, pinnedInputs }, (d) => setRunUi((s) => ({ ...s, testOut: d.result || d })), (err) => setRunUi((s) => ({ ...s, testOut: { nodeId, status: 'failed', error: errMsg(err, 'Test node failed') } })));
    const handleQuickTestNode = (nodeId) => { const ev = sampleEvt(buildSavePayload()); setDoc((d) => ({ ...d, selId: nodeId })); setUi((u) => ({ ...u, inspTab: 'output', inspTabSeq: (u.inspTabSeq || 0) + 1 })); return handleTestNode(nodeId, buildUpstreamPinnedInputs(doc.graph, nodeId, runUi.selectedRun, ev)); };
    const handleFixErrorWithAi = (trace) => {
      if (!trace?.nodeId) return undefined;
      const errTxt = String(trace.error || trace.reason || 'Step execution failed');
      return runAction('aiFix', 'dxosAutomations:aiAssist', {
        ...orgPayload, mode: 'fix_error', ruleKey: String(doc.rule?.ruleKey || '').trim() || undefined,
        graph: doc.graph, nodeId: trace.nodeId, error: errTxt,
        runTrace: { nodeId: trace.nodeId, failedNodeId: trace.nodeId, errorMessage: errTxt, stepTracesJson: [trace], nodeStatesJson: runUi.selectedRun?.nodeStatesJson || {} },
      }, (d) => {
        const nextRaw = d?.draftGraph || d?.draftRule?.graphJson;
        if (nextRaw && Array.isArray(nextRaw.nodes)) {
          commitGraph(ruleToGraph({ graphJson: nextRaw, cooldownSec: doc.rule?.cooldownSec, maxDepth: doc.rule?.maxDepth }), trace.nodeId);
        }
        reportFb({ type: 'success', text: d?.message || d?.summary || `AI đã đề xuất sửa lỗi cho node "${trace.nodeId}".` });
      });
    };
    const handleUndoSseDiff = () => {
      if (!sseDiff?.prevGraph) return setSseDiff(null);
      setDoc((d) => ({ ...d, preDragGraph: null, graph: sseDiff.prevGraph, rule: sseDiff.prevRule || d.rule, dirty: Boolean(sseDiff.prevDirty), selId: null, redo: [...d.redo, d.graph] }));
      return setSseDiff(null);
    };
    const handleResume = (runUid, decision) => runAction('resume', 'dxosAutomations:resumeRun', { ...orgPayload, runUid, decision }, doneRun(`HITL ${decision} hoàn tất`));
    const openRoute = (path) => { if (app?.router?.navigate) app.router.navigate(path); else if (typeof window !== 'undefined' && window.location) window.location.assign(app?.getRouteUrl?.(path) || path); };
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
      return { ...d, preDragGraph: null, dirty: true, rule: Object.keys(sMeta).length ? { ...d.rule, ...sMeta } : d.rule, graph: target, selId: d.selId && target.nodes.some((n) => n.id === d.selId) ? d.selId : null, undo: dir < 0 ? d.undo.slice(0, -1) : [...d.undo, d.graph], redo: dir < 0 ? [...d.redo, d.graph] : d.redo.slice(0, -1) };
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
    const closeEditorToList = () => { setUi((u) => ({ ...u, view: 'list', unsavedGuardOpen: false, settingsOpen: false, bpOpen: false, testRunnerOpen: false, valOpen: false })); loadAll(); };
    const handleBackToList = () => (doc.dirty ? setUi((u) => ({ ...u, unsavedGuardOpen: true, settingsOpen: false, bpOpen: false, testRunnerOpen: false, valOpen: false })) : closeEditorToList());
    const handleGuardSaveAndBack = async () => { if (await saveDraft()) closeEditorToList(); else setUi((u) => ({ ...u, unsavedGuardOpen: false })); };
    const handleGuardDiscardAndBack = () => { setDoc((d) => ({ ...d, dirty: false })); closeEditorToList(); };
    const handleNewFlow = () => { const f = freshDoc((refs.idSeq += 1)); refs.docRule = f.rule; setDoc(f); setData((s) => ({ ...s, runs: [] })); setRunUi(FRESH_RUN); setSseDiff(null); setUi((u) => ({ ...u, view: 'editor', unsavedGuardOpen: false, insertEdge: null, appendSource: null, bpOpen: false, settingsOpen: false, testRunnerOpen: false, valOpen: false })); };
    const loadBlueprint = (bp) => { applyRule(bp, { dirty: true }); setData((s) => ({ ...s, runs: [] })); setRunUi(FRESH_RUN); setSseDiff(null); setUi((u) => ({ ...u, view: 'editor', unsavedGuardOpen: false, bpOpen: false, settingsOpen: false })); };

    refs.kbHandler = (evt) => dispatchFlowKeyDown(evt, {
      ui, dslOpen: dsl.open, selId: doc.selId,
      hasOpenPopover: Boolean(ui.unsavedGuardOpen || ui.settingsOpen || ui.testRunnerOpen || ui.valOpen || ui.bpOpen || ui.paletteOpen || ui.insertEdge || ui.appendSource),
      closeDsl: () => setDsl((m) => ({ ...m, open: false })),
      closePopovers: () => setUi((u) => ({ ...u, unsavedGuardOpen: false, settingsOpen: false, testRunnerOpen: false, valOpen: false, bpOpen: false, paletteOpen: false, insertEdge: null, appendSource: null })),
      clearSel: () => setDoc((d) => ({ ...d, selId: null })),
      save: handleSave, togglePalette: () => setUi((u) => ({ ...u, paletteOpen: !u.paletteOpen })),
      undo: () => undoRedo(-1), redo: () => undoRedo(1), deleteSel: () => handleDeleteNode(doc.selId),
    });
    React.useEffect(() => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
      const onKeyDown = (evt) => refs.kbHandler?.(evt);
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener?.('keydown', onKeyDown);
    }, []);

    const dslObj = () => ({ ruleKey: doc.rule.ruleKey, name: doc.rule.name, cooldownSec: doc.rule.cooldownSec ?? 0, maxDepth: doc.rule.maxDepth ?? 8, graphJson: doc.graph });
    const tracesLen = getRunTraces(runUi.selectedRun).length;
    const activeFb = props.setFeedback ? null : ui.fb;
    const fbBar = activeFb ? h('div', { 'data-testid': 'dxos-flow-feedback', role: 'status', style: { padding: '6px 14px', fontSize: 12, background: activeFb.type === 'error' ? '#fef2f2' : activeFb.type === 'info' ? '#eff6ff' : '#f0fdf4', color: activeFb.type === 'error' ? '#991b1b' : activeFb.type === 'info' ? '#1e40af' : '#166534', borderBottom: '1px solid #e2e8f0' } }, activeFb.text) : null;
    const valTone = validation.errors.length ? 'err' : (validation.warnings.length ? 'act' : 'ok');
    const valLbl = validation.errors.length ? `⚠ ${validation.errors.length} lỗi` : (validation.warnings.length ? `⚠ ${validation.warnings.length} cảnh báo` : '✓ Hợp lệ');
    const tools = [
      ['dxos-flow-validation-btn', valLbl, () => setUi((u) => ({ ...u, valOpen: !u.valOpen, testRunnerOpen: false, settingsOpen: false, n8nOpen: false })), valTone, false],
      ['dxos-flow-test-data-btn', '🧪 Test Data', () => setUi((u) => ({ ...u, testRunnerOpen: !u.testRunnerOpen, valOpen: false, settingsOpen: false, n8nOpen: false })), ui.testRunnerOpen ? 'act' : 'ghost', false],
      ['dxos-flow-n8n-setup-btn', '⚡ n8n', () => setUi((u) => ({ ...u, n8nOpen: !u.n8nOpen, testRunnerOpen: false, valOpen: false, settingsOpen: false })), ui.n8nOpen ? 'act' : 'ghost', false],
      ['dxos-flow-dsl-btn', '{ } DSL', () => setDsl({ open: true, format: 'json', text: serializeFlowDsl(dslObj(), 'json'), error: null }), 'ghost', false],
      ['dxos-flow-dryrun-btn', '▶ Chạy thử', () => handleDryRun(null), 'act', Boolean(ui.busy.dryRun)],
      ['dxos-flow-save-btn', 'Lưu', handleSave, 'pri', data.loading || Boolean(ui.busy.save)],
      ['dxos-flow-run-now-btn', '⚡ Chạy ngay', () => handleRunNow(), 'run', Boolean(ui.busy.runNow)],
    ];

    return h('div', { 'data-testid': 'dxos-flow-studio-app', style: { height: props.embedded ? 640 : 'calc(100vh - 196px)', minHeight: 540, display: 'flex', flexDirection: 'column', background: '#f8fafc', overflow: 'hidden', position: 'relative' } },
      ui.view === 'list' ? h(React.Fragment, null, fbBar, h(FlowListView, { rules: data.rules, runs: data.runs, blueprints, loading: data.loading, runBusy: Boolean(ui.busy.runNow), deleteBusy: Boolean(ui.busy.delete), effectiveOrg, orgList, onOrgChange: setOrgOverride, bpOpen: ui.bpOpen, onToggleBlueprints: (force) => setUi((u) => ({ ...u, bpOpen: typeof force === 'boolean' ? force : !u.bpOpen })), onLoadBlueprint: loadBlueprint, onOpenRule: openRuleInEditor, onRunNow: (r) => handleRunNow(r), onNewFlow: handleNewFlow, onOpenN8nSetup: () => setUi((u) => ({ ...u, n8nOpen: true })), onOpenRoute: openRoute, onToggleRuleActive: handleToggleRuleActive, onDuplicateRule: handleDuplicateRule, onDeleteRule: handleDeleteRule }))
        : h(React.Fragment, null,
          h('header', { 'data-testid': 'dxos-flow-toolbar', style: { minHeight: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, padding: '6px 12px', borderBottom: '1px solid #e2e8f0', background: '#ffffff', boxSizing: 'border-box' } },
            h('div', { style: { ...ROW, flexWrap: 'wrap', flexShrink: 1 } },
              h('button', { 'data-testid': 'dxos-flow-back-to-list-btn', type: 'button', onClick: handleBackToList, style: btnS('ghost') }, '← Danh sách'),
              h('strong', { title: doc.rule.name || doc.rule.ruleKey || 'Workflow', style: { fontSize: 13, color: '#0f172a', maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, doc.rule.name || doc.rule.ruleKey || 'Workflow'),
              h('span', { style: { fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, flexShrink: 0, background: doc.rule.active === false ? '#f1f5f9' : '#ecfdf5', color: doc.rule.active === false ? '#475569' : '#047857' } }, doc.rule.active === false ? 'Tạm dừng' : 'Đang bật'),
              doc.dirty ? h('span', { 'data-testid': 'dxos-flow-dirty-badge', style: { fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, flexShrink: 0, background: '#fffbeb', color: '#b45309', border: '1px solid #fcd34d' } }, '● Chưa lưu') : null,
              h('button', { 'data-testid': 'dxos-flow-settings-btn', type: 'button', onClick: () => setUi((u) => ({ ...u, settingsOpen: !u.settingsOpen, testRunnerOpen: false, valOpen: false })), style: btnS(ui.settingsOpen ? 'act' : 'ghost') }, '⚙️ Cài đặt'),
            ),
            h('div', { style: { ...ROW, flexWrap: 'wrap', flexShrink: 1 } }, tools.map(([tid, lbl, onClick, tone, dis]) => h('button', { key: tid, 'data-testid': tid, type: 'button', disabled: dis, onClick, style: btnS(tone, dis) }, lbl))),
          ),
          fbBar,
          renderSseDiffBanner(h, { sseDiff, onUndo: handleUndoSseDiff, onDismiss: () => setSseDiff(null) }),
          ui.valOpen ? renderValidationPopover(h, { totalIssues, validation, onClose: () => setUi((u) => ({ ...u, valOpen: false })), onSelectIssue: (it) => { if (it.nodeId) { setDoc((d) => ({ ...d, selId: it.nodeId })); focusNode(it.nodeId); } setUi((u) => ({ ...u, valOpen: false })); } }) : null,
          h(FlowTestRunner, { open: ui.testRunnerOpen, rule: doc.rule, graph: doc.graph, busyDryRun: Boolean(ui.busy.dryRun), busyRunNow: Boolean(ui.busy.runNow), onClose: () => setUi((u) => ({ ...u, testRunnerOpen: false })), onUpdateSampleEvent: (ev) => handleRuleMeta({ sampleEvent: ev }), onDryRun: (ev) => { setUi((u) => ({ ...u, testRunnerOpen: false })); return handleDryRun(ev); }, onRunNow: (ev) => { setUi((u) => ({ ...u, testRunnerOpen: false })); return handleRunNow(null, ev); } }),
          ui.settingsOpen ? renderSettingsPopover(h, { doc, handleRuleMeta, blueprintsCount: blueprints.length, onClose: () => setUi((u) => ({ ...u, settingsOpen: false })), onToggleBlueprints: () => setUi((u) => ({ ...u, bpOpen: !u.bpOpen, settingsOpen: false })) }) : null,
          ui.bpOpen ? renderBlueprintsGallery(h, { blueprints, onLoadBlueprint: loadBlueprint }) : null,
          h('div', { style: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden', position: 'relative' } },
            h(FlowCanvas, {
              graph: doc.graph, nodeTypes, selectedNodeId: doc.selId, onSelectNode: (id) => setDoc((d) => ({ ...d, selId: id })),
              onConnectNodes: handleConnect, onNodesChangeGraph: (nextArg, meta) => commitGraph(Array.isArray(nextArg) ? (g) => ({ ...g, nodes: nextArg }) : nextArg, undefined, null, { skipUndo: Boolean(meta && !Array.isArray(meta) && meta.skipUndo === true) }),
              onInsertBetweenEdge: (e) => setUi((u) => ({ ...u, insertEdge: e, appendSource: null })), onAppendFromNode: (nodeId, sh) => { const n = doc.graph.nodes.find((x) => x.id === nodeId); setUi((u) => ({ ...u, appendSource: { nodeId, sourceHandle: sh || 'main', label: n?.label || nodeId }, insertEdge: null })); },
              runOverlay, validationByNodeId: validation.byNodeId, focusNodeId: focus.nodeId, focusSeq: focus.seq, onAutoLayout: (nextG) => commitGraph(nextG),
              onAddNode: addNodeOnly, onDropNode: addNodeOnly, onQuickTestNode: handleQuickTestNode, onDuplicateNode: handleDuplicateNode, onDeleteNode: handleDeleteNode,
              canUndo: doc.undo.length > 0, canRedo: doc.redo.length > 0, onUndo: () => undoRedo(-1), onRedo: () => undoRedo(1), xyflowOverride: props.xyflowOverride,
            }),
            h(NodePalette, { nodeTypes, onAddNode: addNodeOnly, insertEdge: ui.insertEdge, onInsertNode: insertBetweenEdge, onCancelInsert: () => setUi((u) => ({ ...u, insertEdge: null })), appendSource: ui.appendSource, onAppendNode: appendNodeAfter, onCancelAppend: () => setUi((u) => ({ ...u, appendSource: null })), open: ui.paletteOpen, onToggleOpen: (next) => setUi((u) => ({ ...u, paletteOpen: Boolean(next) })) }),
            h(NodeInspector, { rule: doc.rule, graph: doc.graph, selectedNode, nodeSchema: selectedSchema, catalog, activeTrace, nodeValidationIssues: selectedNode ? (validation.byNodeId[selectedNode.id] || []) : [], testOutput: runUi.testOut, testBusy: Boolean(ui.busy.testNode), onTestNode: handleTestNode, onOpenN8nSetup: () => setUi((u) => ({ ...u, n8nOpen: true })), onCloseInspector: () => setDoc((d) => ({ ...d, selId: null })), onUpdateNode: (id, pt) => commitGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...pt } : n)) })), onDeleteNode: handleDeleteNode, externalTab: ui.inspTab, externalTabSeq: ui.inspTabSeq, selectedRun: runUi.selectedRun, organizationId: effectiveOrg, pinStorage }),
          ),
          h(PlaybackBar, { runs: data.runs, selectedRun: runUi.selectedRun, onSelectRun: (r) => setRunWithIdx(r, false), playbackIndex: runUi.idx, onStepChange: (idx) => setRunUi((s) => ({ ...s, playing: false, idx })), onFocusNode: focusNode, playing: runUi.playing, onTogglePlay: () => setRunUi((s) => ({ ...s, idx: !s.playing && s.idx >= tracesLen - 1 ? 0 : s.idx, playing: !s.playing })), onResumeApproval: handleResume, resumeBusy: Boolean(ui.busy.resume), autoExpandSeq: runUi.autoExpandSeq, onFixErrorWithAi: handleFixErrorWithAi, aiFixBusy: Boolean(ui.busy.aiFix) }),
        ),
      h(N8nSetupModal, { open: ui.n8nOpen, api, organizationId: effectiveOrg, selectedNode, onClose: () => setUi((u) => ({ ...u, n8nOpen: false })), onConnectorsChanged: () => loadAll(), onApplyToSelectedNode: (p) => selectedNode && commitGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === selectedNode.id ? { ...n, config: { ...(n.config || {}), connectorKey: p.connectorKey, method: 'POST', path: p.path } } : n)) })), onOpenEnterpriseBlueprint: () => { const bp = blueprints.find((b) => (b.blueprintKey || b.ruleKey) === 'auto_enterprise_n8n_compliance'); if (bp) loadBlueprint(bp); setUi((u) => ({ ...u, view: 'editor', bpOpen: false, n8nOpen: false })); } }),
      dsl.open ? renderDslModal(h, { dsl, dslObj, serializeFlowDsl, setDsl, handleImportDsl }) : null,
      ui.unsavedGuardOpen ? renderUnsavedGuard(h, { ruleName: doc.rule.name || doc.rule.ruleKey, busy: Boolean(ui.busy.save), onSaveAndBack: handleGuardSaveAndBack, onDiscardAndBack: handleGuardDiscardAndBack, onCancel: () => setUi((u) => ({ ...u, unsavedGuardOpen: false })) }) : null,
    );
  };
}

module.exports = { createFlowStudioApp, parseDsl: parseDslText, parseDslText, serializeDsl: serializeFlowDsl, serializeFlowDsl, safeJsonParse, nextCollisionFreeId, ruleToGraph, makeBlankFlow, buildRunOverlay, deriveTriggerEventType };
