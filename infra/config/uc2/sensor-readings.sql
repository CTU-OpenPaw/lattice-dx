-- @file LatticeDX — Open Digital Enterprise Platform
-- @author CTU-OpenPaw
-- @license Apache-2.0
-- @see https://github.com/CTU-OpenPaw/lattice-dx
-- SPDX-License-Identifier: Apache-2.0

BEGIN;

CREATE SCHEMA IF NOT EXISTS uc2_integration;

CREATE TABLE IF NOT EXISTS uc2_integration.sensor_readings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    organization_id text NOT NULL,
    source_system text NOT NULL,
    source_device_id text NOT NULL,
    event_id text NOT NULL,

    asset_urn text NOT NULL,
    attribute text NOT NULL
        CHECK (attribute IN ('temperature', 'humidity', 'batteryLevel')),
    unit text NOT NULL
        CHECK (unit IN ('celsius', 'percent')),

    observed_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),

    simulated boolean NOT NULL,
    quality text NOT NULL
        CHECK (quality IN ('good', 'missing', 'invalid')),
    quality_reason text,
    value double precision,

    source_payload jsonb NOT NULL
        CHECK (jsonb_typeof(source_payload) = 'object'),

    CONSTRAINT sensor_readings_source_event_unique
        UNIQUE (organization_id, source_system, event_id),

    CONSTRAINT sensor_readings_unit_matches_attribute
        CHECK (
            (attribute = 'temperature' AND unit = 'celsius')
            OR
            (attribute IN ('humidity', 'batteryLevel') AND unit = 'percent')
        ),

    CONSTRAINT sensor_readings_quality_matches_value
        CHECK (
            (
                quality = 'good'
                AND value IS NOT NULL
                AND quality_reason IS NULL
            )
            OR
            (
                quality IN ('missing', 'invalid')
                AND value IS NULL
                AND quality_reason IS NOT NULL
            )
        ),

    CONSTRAINT sensor_readings_value_is_finite
        CHECK (
            value IS NULL
            OR (
                value > '-Infinity'::double precision
                AND value < 'Infinity'::double precision
            )
        ),

    CONSTRAINT sensor_readings_percent_range
        CHECK (
            attribute = 'temperature'
            OR value IS NULL
            OR value BETWEEN 0 AND 100
        )
);

CREATE INDEX IF NOT EXISTS sensor_readings_asset_history_idx
    ON uc2_integration.sensor_readings (
        organization_id,
        asset_urn,
        attribute,
        observed_at DESC,
        id DESC
    );

COMMIT;