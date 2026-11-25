/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const SSE_HUB_KEY = '__LATTICEDX_SSE_HUB__';
const DEFAULT_RECONNECT_BASE_MS = 3_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

function parseSseChunk(chunk) {
  const normalized = String(chunk || '').replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const frames = [];
  for (const block of blocks) {
    if (!block.trim() || block.startsWith(':')) continue;
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    let data = {};
    try { data = JSON.parse(dataLines.join('\n')); } catch { data = { raw: dataLines.join('\n') }; }
    frames.push({ event: eventName, data });
  }
  return { frames, rest };
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('aborted') || msg.includes('bodystreambuffer');
}

function getOrCreateSseHub(win) {
  const host = win || (typeof window !== 'undefined' ? window : null);
  if (host && host[SSE_HUB_KEY] && host[SSE_HUB_KEY].channels instanceof Map) {
    return host[SSE_HUB_KEY];
  }
  const hub = { channels: new Map() };
  if (host) {
    try {
      host[SSE_HUB_KEY] = hub;
    } catch {}
  }
  return hub;
}

function subscribeSurfaceEvents({
  portalSlug = 'workspace',
  sseUrl,
  token,
  fetchFn,
  onEvent,
  onAuthError,
  minBackoffMs = DEFAULT_RECONNECT_BASE_MS,
  maxBackoffMs = DEFAULT_RECONNECT_MAX_MS,
  win,
} = {}) {
  const slugKey = String(portalSlug || 'workspace').trim().toLowerCase() || 'workspace';
  if (!token || !sseUrl || typeof fetchFn !== 'function') {
    return () => {};
  }

  const hub = getOrCreateSseHub(win);
  let channel = hub.channels.get(slugKey);

  // Replace stale/idle channel if connection parameters or fetch implementation changed
  if (channel && (channel.disposed || channel.subscribers.size === 0 || channel.fetchFn !== fetchFn || channel.sseUrl !== sseUrl || channel.token !== token)) {
    channel.dispose();
    hub.channels.delete(slugKey);
    channel = null;
  }

  let createdChannel = false;
  if (!channel) {
    const subscribers = new Set();
    let disposed = false;
    let controller = null;
    let activeReader = null;
    let reconnectTimer = null;
    let retryAttempt = 0;

    const cleanupTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      cleanupTimer();
      try {
        controller?.abort?.();
      } catch {}
      const readerToCancel = activeReader;
      activeReader = null;
      if (readerToCancel && typeof readerToCancel.cancel === 'function') {
        try {
          Promise.resolve(readerToCancel.cancel()).catch(() => {});
        } catch {}
      }
      subscribers.clear();
      if (hub.channels.get(slugKey) === channel) {
        hub.channels.delete(slugKey);
      }
    };

    const connect = async () => {
      if (disposed || subscribers.size === 0) return;
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      let stopReconnect = false;
      try {
        const res = await fetchFn(sseUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          credentials: 'same-origin',
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (disposed || controller?.signal?.aborted) {
          return;
        }
        if (res && (res.status === 401 || res.status === 403)) {
          stopReconnect = true;
          for (const sub of [...subscribers]) {
            try { sub.onAuthError?.(res.status); } catch {}
          }
          return;
        }
        if (!res?.ok || !res.body?.getReader) {
          throw new Error('SSE_UNAVAILABLE');
        }
        retryAttempt = 0;
        activeReader = res.body.getReader();
        const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
        let buffer = '';
        while (!disposed && !controller?.signal?.aborted) {
          let part;
          try {
            part = await activeReader.read();
          } catch (readErr) {
            if (disposed || controller?.signal?.aborted || isAbortError(readErr)) {
              return;
            }
            throw readErr;
          }
          if (!part || part.done) break;
          const text = decoder ? decoder.decode(part.value, { stream: true }) : String(part.value || '');
          buffer += text;
          const parsed = parseSseChunk(buffer);
          buffer = parsed.rest;
          for (const frame of parsed.frames) {
            if (frame.event === 'snapshot') {
              retryAttempt = 0;
            }
            for (const sub of [...subscribers]) {
              try { sub.onEvent?.(frame.event, frame.data); } catch {}
            }
          }
        }
      } catch (err) {
        if (disposed || controller?.signal?.aborted || isAbortError(err)) {
          return;
        }
      } finally {
        activeReader = null;
      }

      if (!disposed && !controller?.signal?.aborted && !stopReconnect && subscribers.size > 0 && !reconnectTimer) {
        const baseMs = Math.max(DEFAULT_RECONNECT_BASE_MS, Number(minBackoffMs) || DEFAULT_RECONNECT_BASE_MS);
        const capMs = Math.max(baseMs, Number(maxBackoffMs) || DEFAULT_RECONNECT_MAX_MS);
        const delayMs = Math.min(capMs, baseMs * (2 ** Math.min(4, retryAttempt)));
        retryAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect().catch(() => {});
        }, delayMs);
        if (typeof reconnectTimer?.unref === 'function') reconnectTimer.unref();
      }
    };

    channel = {
      slugKey,
      sseUrl,
      token,
      fetchFn,
      subscribers,
      connect,
      get disposed() { return disposed; },
      dispose,
    };
    hub.channels.set(slugKey, channel);
    createdChannel = true;
  }

  const sub = { onEvent, onAuthError };
  channel.subscribers.add(sub);
  if (createdChannel) {
    channel.connect().catch(() => {});
  }

  return () => {
    channel.subscribers.delete(sub);
    if (channel.subscribers.size === 0) {
      channel.dispose();
    }
  };
}

module.exports = {
  SSE_HUB_KEY,
  DEFAULT_RECONNECT_BASE_MS,
  parseSseChunk,
  isAbortError,
  getOrCreateSseHub,
  subscribeSurfaceEvents,
};
