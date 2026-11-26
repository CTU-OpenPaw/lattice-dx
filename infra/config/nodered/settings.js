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
