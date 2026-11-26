/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const credentialSecret = String(process.env.NODERED_CREDENTIAL_SECRET || '').trim();
const adminUser = String(process.env.NODERED_ADMIN_USER || '').trim();
const adminPassHash = String(process.env.NODERED_ADMIN_PASS_HASH || '').trim();
const requireAdminAuth = String(process.env.NODERED_REQUIRE_ADMIN_AUTH || '').trim().toLowerCase() === 'true';

if (requireAdminAuth && (!adminUser || !adminPassHash)) {
  throw new Error('Node-RED admin auth is required in production: set both NODERED_ADMIN_USER and NODERED_ADMIN_PASS_HASH.');
}

module.exports = {
  flowFile: 'flows.json',
  flowFilePretty: true,
  // Encrypt /data/flows_cred.json when NODERED_CREDENTIAL_SECRET is set
  credentialSecret: credentialSecret || false,
  ...(adminUser && adminPassHash ? {
    adminAuth: {
      type: 'credentials',
      users: [
        {
          username: adminUser,
          password: adminPassHash,
          permissions: '*',
        },
      ],
    },
  } : {}),
  uiPort: process.env.PORT || 1880,
  diagnostics: {
    enabled: true,
    ui: true,
  },
  runtimeState: {
    enabled: false,
    ui: false,
  },
  logging: {
    console: {
      level: 'info',
      metrics: false,
      audit: false,
    },
  },
  editorTheme: {
    projects: {
      enabled: false,
    },
  },
};
