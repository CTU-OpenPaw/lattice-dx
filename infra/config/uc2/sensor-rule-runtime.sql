-- @file LatticeDX — Open Digital Enterprise Platform
-- @author CTU-OpenPaw
-- @license Apache-2.0
-- @see https://github.com/CTU-OpenPaw/lattice-dx
-- SPDX-License-Identifier: Apache-2.0
BEGIN;

CREATE SCHEMA IF NOT EXISTS uc2_integration;

-- This row is also the serialization point for concurrent evaluations.
-- Rule edits do not reset cooldown automatically.
CREATE TABLE uc2_integration.sensor_rule_state (
    organization_id text NOT NULL,
    rule_id uuid NOT NULL,
    asset_entity_id uuid NOT NULL,
    last_alert_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (organization_id, rule_id, asset_entity_id)
);

-- One source event is evaluated once per rule, including across rule edits.
-- Deliberate re-evaluation will require a separate explicit replay mechanism.
CREATE TABLE uc2_integration.sensor_rule_evaluations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    source_system text NOT NULL,
    event_id text NOT NULL,
    rule_id uuid NOT NULL,
    rule_version integer NOT NULL CHECK (rule_version > 0),
    asset_entity_id uuid NOT NULL,
    asset_urn text NOT NULL,
    observed_at timestamptz NOT NULL,
    evaluated_at timestamptz NOT NULL,

    outcome text NOT NULL CHECK (
        outcome IN ('not_matched', 'cooldown', 'queued')
    ),

    -- Preserve the exact inputs and decision used for this evaluation.
    source_payload jsonb NOT NULL
        CHECK (jsonb_typeof(source_payload) = 'object'),
    rule_snapshot jsonb NOT NULL
        CHECK (jsonb_typeof(rule_snapshot) = 'object'),
    mapping_snapshot jsonb NOT NULL
        CHECK (jsonb_typeof(mapping_snapshot) = 'object'),
    evaluation jsonb NOT NULL
        CHECK (jsonb_typeof(evaluation) = 'object'),

    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    UNIQUE (organization_id, source_system, rule_id, event_id),
    UNIQUE (organization_id, id),

    FOREIGN KEY (organization_id, rule_id, asset_entity_id)
        REFERENCES uc2_integration.sensor_rule_state (
            organization_id, rule_id, asset_entity_id
        )
);

CREATE INDEX sensor_rule_evaluations_asset_history_idx
    ON uc2_integration.sensor_rule_evaluations (
        organization_id, asset_entity_id, evaluated_at DESC, id
    );

-- Written atomically with the queued evaluation and cooldown update.
-- The future dispatcher uses this ID as its stable delivery key.
CREATE TABLE uc2_integration.sensor_rule_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL,
    evaluation_id uuid NOT NULL,

    status text NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'succeeded', 'failed')
    ),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_token uuid,
    lease_until timestamptz,
    last_error_code text,

    -- Filled after the authorized native action accepts the alert.
    target_record_id text,
    receipt jsonb,

    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,

    UNIQUE (organization_id, evaluation_id),

    FOREIGN KEY (organization_id, evaluation_id)
        REFERENCES uc2_integration.sensor_rule_evaluations (
            organization_id, id
        ),

    CHECK (
        (
            status = 'processing'
            AND lease_token IS NOT NULL
            AND lease_until IS NOT NULL
        )
        OR
        (
            status <> 'processing'
            AND lease_token IS NULL
            AND lease_until IS NULL
        )
    ),

    CHECK (
        (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
        OR
        (status IN ('pending', 'processing') AND completed_at IS NULL)
    )
);

CREATE INDEX sensor_rule_alerts_pending_idx
    ON uc2_integration.sensor_rule_alerts (
        available_at, created_at, id
    )
    WHERE status = 'pending';

CREATE INDEX sensor_rule_alerts_lease_idx
    ON uc2_integration.sensor_rule_alerts (lease_until, id)
    WHERE status = 'processing';

COMMIT;