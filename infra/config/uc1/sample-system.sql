-- @file LatticeDX — Open Digital Enterprise Platform
-- @author CTU-OpenPaw
-- @license Apache-2.0
-- @see https://github.com/CTU-OpenPaw/lattice-dx
-- SPDX-License-Identifier: Apache-2.0

CREATE SCHEMA IF NOT EXISTS uc1_sample;

-- Accepted handover events. The original payload is retained for comparison.
CREATE TABLE IF NOT EXISTS uc1_sample.handovers (
    organization_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    run_version INTEGER NOT NULL CHECK (run_version > 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (organization_id, event_id)
);

-- Delivery history for accepted, duplicate, and conflicting events.
CREATE TABLE IF NOT EXISTS uc1_sample.delivery_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (
        outcome IN ('accepted', 'duplicate', 'conflict')
    ),
    http_status INTEGER NOT NULL CHECK (
        http_status BETWEEN 200 AND 599
    ),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS handover_attempts_event_idx
    ON uc1_sample.delivery_attempts (
        organization_id,
        event_id,
        received_at DESC
    );