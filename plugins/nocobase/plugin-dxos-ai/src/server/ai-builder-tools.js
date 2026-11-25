/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  hasUnsafeAutomationTemplate,
  interpolateLocal,
  scrubFlowSyncPayload,
} = require('./ai-builder-security');
const { createSchemaBuilderTools } = require('./ai-builder-schema');
const { createFlowBuilderTools } = require('./ai-builder-flow');

function createBuilderTools(deps) {
  return [
    ...createSchemaBuilderTools(deps),
    ...createFlowBuilderTools(deps),
  ];
}

module.exports = {
  createBuilderTools,
  hasUnsafeAutomationTemplate,
  interpolateLocal,
  scrubFlowSyncPayload,
};
