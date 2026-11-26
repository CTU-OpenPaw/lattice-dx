/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { cloneSafe } = require('./schema');
const { sanitizeTraceData } = require('./trace-sanitizer');

function collectSubgraph(startIds, edges, allowedSet) {
  const [v, q] = [new Set(), [...startIds]];
  for (let i = 0; i < q.length; i += 1) {
    if (!v.has(q[i]) && (!allowedSet || allowedSet.has(q[i]))) {
      v.add(q[i]);
      edges.forEach((e) => { if (e.source === q[i] && !v.has(e.target)) q.push(e.target); });
    }
  }
  return v;
}

function collectPreSettledNodes(subTopo, edges, nodeMap, nodeStatesJson, completedMap, resumedNodeId) {
  const preSettled = new Set();
  const isDone = (id) => (completedMap ? completedMap.has(id) : nodeStatesJson[id]?.status === 'completed');
  const queue = [];
  for (const id of subTopo) {
    if (id !== resumedNodeId && nodeMap.get(id)?.type === 'control.merge' && nodeMap.get(id)?.config?.mode === 'first_completed' && isDone(id)) {
      preSettled.add(id); queue.push(id);
    }
  }
  const subSet = new Set(subTopo);
  for (let i = 0; i < queue.length; i += 1) {
    for (const e of edges) {
      if (e.source === queue[i] && subSet.has(e.target) && !preSettled.has(e.target) && e.target !== resumedNodeId && isDone(e.target)) {
        preSettled.add(e.target); queue.push(e.target);
      }
    }
  }
  return preSettled;
}

function buildResumeInitInputs(subTopo, downSet, edges, anchorId, anchorPort, anchorOut, nodeStatesJson, preSettled, completedMap = null, extraItemSrc = null) {
  const initInputs = new Map(subTopo.map((id) => [id, []]));
  const srcPorts = (id) => nodeStatesJson[id]?.nextPorts || [nodeStatesJson[id]?.nextPort || 'main'];
  edges.filter((e) => downSet.has(e.target)).forEach((e) => {
    if (e.source === anchorId && e.sourceHandle === anchorPort) {
      initInputs.get(e.target)?.push({ from: anchorId, output: anchorOut });
    } else if (preSettled?.has(e.source) && !preSettled.has(e.target)) {
      const st = completedMap?.get(e.source) || nodeStatesJson[e.source];
      if (st && srcPorts(e.source).includes(e.sourceHandle)) initInputs.get(e.target)?.push({ from: e.source, output: st.output });
    } else if (extraItemSrc && e.source === extraItemSrc.id && e.sourceHandle === 'item' && !downSet.has(e.source)) {
      initInputs.get(e.target)?.push({ from: extraItemSrc.id, output: extraItemSrc.item });
    } else if (!downSet.has(e.source) && (completedMap ? completedMap.has(e.source) : nodeStatesJson[e.source]?.status === 'completed')) {
      const out = completedMap ? completedMap.get(e.source).output : nodeStatesJson[e.source].output;
      if (srcPorts(e.source).includes(e.sourceHandle)) initInputs.get(e.target)?.push({ from: e.source, output: out });
    }
  });
  return initInputs;
}

function persistSuspendedLoop(nodeStatesJson, execState, loopNode, cursorBase, idx, loopResults, traceStart, localTopo, childStack, rawRest, recordNodeOutput, inputVal, durationMs) {
  const cursor = { loopNodeId: loopNode.id, items: cloneSafe(cursorBase.items || []), currentIndex: idx, loopResults: cloneSafe(loopResults), loopOutput: cloneSafe(cursorBase.loopOutput || {}), iterTraceStart: traceStart, bodyNodeIds: [...localTopo] };
  const loopStack = [...(Array.isArray(childStack) ? cloneSafe(childStack) : []), cloneSafe(cursor), ...(Array.isArray(rawRest) ? cloneSafe(rawRest) : [])];
  nodeStatesJson.loopCursor = cloneSafe(loopStack[0]);
  nodeStatesJson.loopCursors = cloneSafe(loopStack);
  const partialOut = { ...(cursorBase.loopOutput || {}), results: cloneSafe(loopResults) };
  recordNodeOutput(execState, loopNode, partialOut, 'suspended');
  nodeStatesJson[loopNode.id] = { status: 'suspended', input: inputVal ?? null, output: sanitizeTraceData(partialOut), loopCursor: cloneSafe(cursor), durationMs: durationMs ?? 0 };
  return loopStack;
}

function failHaltedLoop(nodeStatesJson, execState, loopNode, loopOutput, loopResults, haltError, recordNodeOutput, inputVal, durationMs) {
  delete nodeStatesJson.loopCursor;
  delete nodeStatesJson.loopCursors;
  const out = { ...(loopOutput || {}), results: loopResults };
  recordNodeOutput(execState, loopNode, out, 'failed', haltError);
  nodeStatesJson[loopNode.id] = { status: 'failed', input: inputVal ?? null, output: sanitizeTraceData(out), error: haltError, durationMs: durationMs ?? 0 };
  execState.loop = null;
  return { halted: true, haltError, suspended: null };
}

const iterOutput = (traces, start, loopId, idx, fb = null) => traces.slice(start).filter((t) => t.status === 'completed' && t.loopNodeId === loopId && t.loopIteration === idx).at(-1)?.output ?? fb;

function finishLoopNode(execState, nodeStatesJson, stepTracesJson, recordNodeOutput, loopNode, baseOut, loopResults, inputVal, durationMs) {
  const finalOut = { ...(baseOut || {}), results: loopResults };
  const safeFinal = sanitizeTraceData(finalOut);
  recordNodeOutput(execState, loopNode, finalOut, 'completed');
  nodeStatesJson[loopNode.id] = { status: 'completed', input: inputVal ?? null, output: safeFinal, nextPort: 'done', nextPorts: ['done'], durationMs: durationMs ?? 0 };
  const lt = [...stepTracesJson].reverse().find((t) => t.nodeId === loopNode.id);
  if (lt) Object.assign(lt, { status: 'completed', output: safeFinal });
  return finalOut;
}

function makeIterInit(edges, loopId, bodySet, item) {
  const m = new Map();
  edges.filter((e) => e.source === loopId && e.sourceHandle === 'item' && bodySet.has(e.target))
    .forEach((e) => m.set(e.target, [...(m.get(e.target) || []), { from: loopId, output: item }]));
  return m;
}

async function executeLoopBody({
  n, r, graph, subTopo, nodeMap, edges, outEdges, subSet, activeInputs, execState,
  nodeStatesJson, stepTracesJson, reg, db, app, options, helpers, traverseDag, recordNodeOutput,
}) {
  const items = Array.isArray(r.output?.items) ? r.output.items : [];
  const bodySet = collectSubgraph((outEdges.get(n.id) || []).filter((e) => e.sourceHandle === 'item').map((e) => e.target), edges, subSet);
  const [localTopo, loopResults, prevLoop] = [subTopo.filter((id) => bodySet.has(id)), [], execState.loop ?? null];
  let [halted, haltError] = [false, null];

  if (items.length && localTopo.length) {
    for (let idx = 0; idx < items.length; idx += 1) {
      execState.loop = { item: items[idx], index: idx, count: items.length };
      const traceStart = stepTracesJson.length;
      const iterRes = await traverseDag({ graph, subTopo: localTopo, nodeMap, edges, initialInputs: makeIterInit(edges, n.id, bodySet, items[idx]), execState, nodeStatesJson, stepTracesJson, reg, db, app, options, helpers, loopMeta: { nodeId: n.id, index: idx } });
      if (iterRes.suspended) {
        const loopStack = persistSuspendedLoop(nodeStatesJson, execState, n, { items, loopOutput: r.output || {} }, idx, loopResults, traceStart, localTopo, iterRes.suspended.loopStack, [], recordNodeOutput, r.input, r.durationMs);
        execState.loop = prevLoop;
        return { halted: false, haltError: null, suspended: { ...iterRes.suspended, loopStack }, localTopo };
      }
      loopResults.push(iterRes.halted ? null : iterOutput(stepTracesJson, traceStart, n.id, idx));
      if (iterRes.halted) { halted = true; haltError = iterRes.haltError; break; }
    }
    execState.loop = prevLoop;
  }
  if (!halted) localTopo.forEach((id) => { if (!nodeStatesJson[id]) nodeStatesJson[id] = { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' }; });
  if (halted) return { ...failHaltedLoop(nodeStatesJson, execState, n, r.output, loopResults, haltError, recordNodeOutput, r.input, r.durationMs), localTopo };

  const finalOut = finishLoopNode(execState, nodeStatesJson, stepTracesJson, recordNodeOutput, n, r.output, loopResults, r.input, r.durationMs);
  (outEdges.get(n.id) || []).filter((e) => e.sourceHandle === 'done').forEach((e) => activeInputs.get(e.target)?.push({ from: n.id, output: finalOut }));
  return { halted: false, haltError: null, suspended: null, localTopo };
}

async function resumeLoopStack({
  rawStack, sNode, resumedPort, resumedOut, graph, validation, nodeMap,
  execState, nodeStatesJson, stepTracesJson, reg, db, app, options, helpers, traverseDag, recordNodeOutput,
}) {
  const [edges, topo] = [graph.edges, validation.topoOrder];
  let [anchorId, anchorPort, anchorOut] = [sNode.id, resumedPort, resumedOut];

  for (let k = 0; k < rawStack.length; k += 1) {
    const cursor = rawStack[k];
    const loopNode = nodeMap.get(cursor?.loopNodeId);
    if (!loopNode) break;
    const parentCursor = rawStack[k + 1] || null;
    const outerAllowed = parentCursor?.bodyNodeIds ? new Set(parentCursor.bodyNodeIds) : null;
    const bodySet = Array.isArray(cursor.bodyNodeIds) && cursor.bodyNodeIds.length ? new Set(cursor.bodyNodeIds) : collectSubgraph(edges.filter((e) => e.source === loopNode.id && e.sourceHandle === 'item').map((e) => e.target), edges, outerAllowed);
    const [localTopo, items, curIdx, loopResults] = [topo.filter((id) => bodySet.has(id)), Array.isArray(cursor.items) ? cursor.items : [], Math.max(0, Number(cursor.currentIndex || 0)), Array.isArray(cursor.loopResults) ? [...cursor.loopResults] : []];
    const [traceStart, savedIn, savedDur] = [Number.isInteger(cursor.iterTraceStart) ? cursor.iterTraceStart : stepTracesJson.length, nodeStatesJson[loopNode.id]?.input ?? null, nodeStatesJson[loopNode.id]?.durationMs ?? 0];

    execState.loop = { item: items[curIdx], index: curIdx, count: items.length };
    const isLoopDone = nodeMap.get(anchorId)?.type === 'control.loop' && anchorPort === 'done';
    const remSet = collectSubgraph(edges.filter((e) => e.source === anchorId && (!isLoopDone || e.sourceHandle === 'done') && bodySet.has(e.target)).map((e) => e.target), edges, bodySet);
    const remTopo = localTopo.filter((id) => remSet.has(id));
    if (remTopo.length) {
      const doneInIter = new Map();
      stepTracesJson.slice(traceStart).forEach((t) => { if (t?.nodeId && t.status === 'completed') doneInIter.set(t.nodeId, t); });
      const preSettled = collectPreSettledNodes(remTopo, edges, nodeMap, nodeStatesJson, doneInIter, anchorId);
      const remInit = buildResumeInitInputs(remTopo, remSet, edges, anchorId, anchorPort, anchorOut, nodeStatesJson, preSettled, doneInIter, { id: loopNode.id, item: items[curIdx] });
      const remRes = await traverseDag({ graph, subTopo: remTopo, nodeMap, edges, initialInputs: remInit, preSettled, execState, nodeStatesJson, stepTracesJson, reg, db, app, options, helpers, loopMeta: { nodeId: loopNode.id, index: curIdx } });
      if (remRes.suspended) {
        const loopStack = persistSuspendedLoop(nodeStatesJson, execState, loopNode, cursor, curIdx, loopResults, traceStart, localTopo, remRes.suspended.loopStack, rawStack.slice(k + 1), recordNodeOutput, savedIn, savedDur);
        return { halted: false, haltError: null, suspended: { ...remRes.suspended, loopStack } };
      }
      if (remRes.halted) return failHaltedLoop(nodeStatesJson, execState, loopNode, cursor.loopOutput, loopResults, remRes.haltError, recordNodeOutput, savedIn, savedDur);
    }
    loopResults.push(iterOutput(stepTracesJson, traceStart, loopNode.id, curIdx, anchorOut ?? null));

    for (let idx = curIdx + 1; idx < items.length; idx += 1) {
      execState.loop = { item: items[idx], index: idx, count: items.length };
      const subStart = stepTracesJson.length;
      const iterRes = await traverseDag({ graph, subTopo: localTopo, nodeMap, edges, initialInputs: makeIterInit(edges, loopNode.id, bodySet, items[idx]), execState, nodeStatesJson, stepTracesJson, reg, db, app, options, helpers, loopMeta: { nodeId: loopNode.id, index: idx } });
      if (iterRes.suspended) {
        const loopStack = persistSuspendedLoop(nodeStatesJson, execState, loopNode, cursor, idx, loopResults, subStart, localTopo, iterRes.suspended.loopStack, rawStack.slice(k + 1), recordNodeOutput, savedIn, savedDur);
        return { halted: false, haltError: null, suspended: { ...iterRes.suspended, loopStack } };
      }
      if (iterRes.halted) return failHaltedLoop(nodeStatesJson, execState, loopNode, cursor.loopOutput, loopResults, iterRes.haltError, recordNodeOutput, savedIn, savedDur);
      loopResults.push(iterOutput(stepTracesJson, subStart, loopNode.id, idx));
    }

    localTopo.forEach((id) => { if (!nodeStatesJson[id]) nodeStatesJson[id] = { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' }; });
    const finalOut = finishLoopNode(execState, nodeStatesJson, stepTracesJson, recordNodeOutput, loopNode, cursor.loopOutput, loopResults, savedIn, savedDur);
    execState.loop = parentCursor ? { item: parentCursor.items?.[parentCursor.currentIndex], index: parentCursor.currentIndex, count: (parentCursor.items || []).length } : null;
    [anchorId, anchorPort, anchorOut] = [loopNode.id, 'done', finalOut];
  }

  delete nodeStatesJson.loopCursor; delete nodeStatesJson.loopCursors; execState.loop = null;
  return { halted: false, haltError: null, suspended: null, anchorId, anchorPort, anchorOut };
}

module.exports = { collectSubgraph, collectPreSettledNodes, buildResumeInitInputs, executeLoopBody, resumeLoopStack };
