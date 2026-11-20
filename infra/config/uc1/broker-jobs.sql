-- @file LatticeDX — Open Digital Enterprise Platform
-- @author CTU-OpenPaw
-- @copyright (C) 2026 CTU-OpenPaw
-- @license Apache-2.0
-- @see https://github.com/CTU-OpenPaw/lattice-dx
-- SPDX-License-Identifier: Apache-2.0
CREATE SCHEMA IF NOT EXISTS uc1_integration;

-- One frozen broker projection per accepted source event.
CREATE TABLE IF NOT EXISTS uc1_integration.asset_jobs (
    organization_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    source_system TEXT NOT NULL,
    mapping_version TEXT NOT NULL,

    asset_urn TEXT NOT NULL,
    source_observed_at TEXT NOT NULL,
    projection JSONB NOT NULL
        CHECK (jsonb_typeof(projection) = 'object'),

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'processing', 'succeeded',
            'stale', 'conflict', 'failed'
        )),

    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    last_error_code TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    PRIMARY KEY (organization_id, event_id),

    FOREIGN KEY (organization_id, event_id)
        REFERENCES uc1_sample.handovers (organization_id, event_id),

    CHECK (
        (status = 'processing'
            AND lease_token IS NOT NULL
            AND lease_until IS NOT NULL)
        OR
        (status <> 'processing'
            AND lease_token IS NULL
            AND lease_until IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS asset_jobs_due_idx
    ON uc1_integration.asset_jobs (available_at, created_at)
    WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS asset_jobs_asset_idx
    ON uc1_integration.asset_jobs (
        organization_id, asset_urn, created_at
    );

-- Shared coordination row for workers handling the same Asset.
-- Updated only after the broker result has been verified.
CREATE TABLE IF NOT EXISTS uc1_integration.asset_heads (
    organization_id TEXT NOT NULL,
    asset_urn TEXT NOT NULL,

    applied_event_id TEXT,
    source_observed_at TEXT,
    applied_attributes JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (organization_id, asset_urn),

    CHECK (
        (applied_event_id IS NULL
            AND source_observed_at IS NULL
            AND applied_attributes IS NULL)
        OR
        (applied_event_id IS NOT NULL
            AND source_observed_at IS NOT NULL
            AND applied_attributes IS NOT NULL)
    ),

    CHECK (
        applied_attributes IS NULL
        OR jsonb_typeof(applied_attributes) = 'object'
    )
);

-- Persistent history, including attempts interrupted by worker shutdown.
CREATE TABLE IF NOT EXISTS uc1_integration.asset_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    lease_token UUID NOT NULL,

    outcome TEXT NOT NULL DEFAULT 'processing'
        CHECK (outcome IN (
            'processing', 'succeeded', 'stale',
            'conflict', 'retry', 'failed', 'abandoned'
        )),
    broker_http_status INTEGER
        CHECK (broker_http_status BETWEEN 100 AND 599),
    error_code TEXT,

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,

    FOREIGN KEY (organization_id, event_id)
        REFERENCES uc1_integration.asset_jobs (
            organization_id, event_id
        ),

    UNIQUE (organization_id, event_id, attempt_number),
    UNIQUE (lease_token),

    CHECK (
        (outcome = 'processing' AND finished_at IS NULL)
        OR
        (outcome <> 'processing' AND finished_at IS NOT NULL)
    )
);

-- Reconcile the original handover with its broker synchronization result.
CREATE OR REPLACE VIEW uc1_integration.asset_trace AS
SELECT
    h.organization_id,
    h.event_id,
    h.run_id,
    h.record_id,
    h.definition_id,
    h.run_version,
    h.payload,
    h.payload->>'occurredAt' AS source_occurred_at,
    h.received_at,
    j.source_system,
    j.mapping_version,
    j.asset_urn,
    j.status AS broker_status,
    j.attempts,
    j.last_error_code,
    j.created_at AS queued_at,
    j.updated_at,
    j.completed_at
FROM uc1_sample.handovers h
LEFT JOIN uc1_integration.asset_jobs j
    ON j.organization_id = h.organization_id
   AND j.event_id = h.event_id;