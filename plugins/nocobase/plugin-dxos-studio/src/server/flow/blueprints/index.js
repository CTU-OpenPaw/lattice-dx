/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const coldchainEmergency = require('./coldchain-emergency.json');
const mktQuarantine = require('./mkt-quarantine.json');
const slaEscalation = require('./sla-escalation.json');
const procurementHitlApproval = require('./procurement-hitl-approval.json');
const scheduledAiDigest = require('./scheduled-ai-digest.json');
const partnerWebhookSync = require('./partner-webhook-sync.json');
const enterpriseN8nCompliance = require('./enterprise-n8n-compliance.json');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

const RAW_BLUEPRINTS = [
  coldchainEmergency,
  mktQuarantine,
  slaEscalation,
  procurementHitlApproval,
  scheduledAiDigest,
  partnerWebhookSync,
  enterpriseN8nCompliance,
];

const FLOW_BLUEPRINTS = deepFreeze(RAW_BLUEPRINTS.map((bp) => structuredClone(bp)));

function listFlowBlueprints() {
  return FLOW_BLUEPRINTS.map((bp) => structuredClone(bp));
}

function getFlowBlueprint(key) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return null;
  const found = FLOW_BLUEPRINTS.find(
    (bp) => bp.blueprintKey === cleanKey || bp.ruleKey === cleanKey,
  );
  return found ? structuredClone(found) : null;
}

module.exports = {
  FLOW_BLUEPRINTS,
  listFlowBlueprints,
  getFlowBlueprint,
};
