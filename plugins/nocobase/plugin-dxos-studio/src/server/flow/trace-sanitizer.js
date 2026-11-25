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
const { scrubAndCapHttpBody } = require('./security-helpers');

function sanitizeTraceData(val, maxBytes = 16384) {
  if (val === undefined || val === null) return null;
  try {
    return scrubAndCapHttpBody(cloneSafe(val), null, maxBytes);
  } catch {
    return null;
  }
}

module.exports = { sanitizeTraceData };
