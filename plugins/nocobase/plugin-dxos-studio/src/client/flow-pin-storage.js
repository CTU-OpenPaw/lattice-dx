/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function createFlowPinStorage() {
  const mem = new Map();
  const resolveStore = () => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
      return null;
    } catch { return null; }
  };
  return {
    getItem(key) {
      const k = String(key || '');
      const ls = resolveStore();
      if (ls && typeof ls.getItem === 'function') {
        try { return ls.getItem(k); } catch { /* fallback */ }
      }
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem(key, val) {
      const k = String(key || '');
      const v = String(val ?? '');
      const ls = resolveStore();
      if (ls && typeof ls.setItem === 'function') {
        try { ls.setItem(k, v); return; } catch { /* fallback */ }
      }
      mem.set(k, v);
    },
  };
}

module.exports = { createFlowPinStorage };
