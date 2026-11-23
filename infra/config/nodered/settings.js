/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

module.exports = {
  flowFile: 'flows.json',
  flowFilePretty: true,
  // Runtime container generates /data/flows_cred.json ephemerally from env secrets
  credentialSecret: false,
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
