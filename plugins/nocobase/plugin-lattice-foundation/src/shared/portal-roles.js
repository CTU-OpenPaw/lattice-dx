/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const BUSINESS_ROLE_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
const SYSTEM_PORTAL_EXCLUDED_ROLES = new Set(['root', 'admin', 'anonymous', 'member']);

function readRoleProp(role, key) {
  if (!role || typeof role !== 'object') return undefined;
  return typeof role.get === 'function' ? role.get(key) : role[key];
}

function isBusinessPortalRole(roleOrName) {
  if (typeof roleOrName === 'string') {
    const name = roleOrName.trim();
    return BUSINESS_ROLE_NAME_RE.test(name) && !SYSTEM_PORTAL_EXCLUDED_ROLES.has(name);
  }
  if (!roleOrName || typeof roleOrName !== 'object') return false;
  const name = String(readRoleProp(roleOrName, 'name') || '').trim();
  if (!BUSINESS_ROLE_NAME_RE.test(name) || SYSTEM_PORTAL_EXCLUDED_ROLES.has(name)) return false;
  if (readRoleProp(roleOrName, 'allowConfigure') === true) return false;
  const snippets = readRoleProp(roleOrName, 'snippets');
  if (Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'))) return false;
  return true;
}

module.exports = {
  BUSINESS_ROLE_NAME_RE,
  SYSTEM_PORTAL_EXCLUDED_ROLES,
  isBusinessPortalRole,
};
