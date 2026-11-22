/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Build target versions for NocoBase host externals, overridable via NOCOBASE_VERSION
// without echoing an arbitrary runtime host dependency tree.
export const DEFAULT_NOCOBASE_VERSION = '2.2.50';
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHARED_VENDOR_VERSIONS = {
  react: '18.2.0',
  antd: '5.24.2',
};
const NOCOBASE_EXTERNAL_NAMES = [
  '@nocobase/server',
  '@nocobase/auth',
  '@nocobase/plugin-auth',
  '@nocobase/database',
  '@nocobase/client',
  '@nocobase/client-v2',
  '@nocobase/plugin-workflow',
];

export function resolveNocoBaseVersion(env = process.env) {
  const raw = env?.NOCOBASE_VERSION;
  if (raw === undefined || raw === null) return DEFAULT_NOCOBASE_VERSION;
  const trimmed = String(raw).trim();
  if (!trimmed) return DEFAULT_NOCOBASE_VERSION;
  if (!SEMVER_RE.test(trimmed)) {
    throw new Error('Invalid NOCOBASE_VERSION');
  }
  return trimmed;
}

export function externalVersionSource(names, { version = resolveNocoBaseVersion() } = {}) {
  if (!SEMVER_RE.test(String(version))) {
    throw new Error('Invalid NOCOBASE_VERSION');
  }
  const versions = {
    ...Object.fromEntries(NOCOBASE_EXTERNAL_NAMES.map((pkg) => [pkg, version])),
    ...SHARED_VENDOR_VERSIONS,
  };
  const declared = {};
  for (const name of names) {
    if (!Object.hasOwn(versions, name)) throw Error('Unverified host dependency: ' + name);
    declared[name] = versions[name];
  }
  return '// SPDX-License-Identifier: Apache-2.0\nmodule.exports = ' + JSON.stringify(declared, null, 2) + ';\n';
}
