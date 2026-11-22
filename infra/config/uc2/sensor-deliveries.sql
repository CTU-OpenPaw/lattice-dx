-- @file LatticeDX — Open Digital Enterprise Platform
-- @author CTU-OpenPaw
-- @copyright (C) 2026 CTU-OpenPaw
-- @license Apache-2.0
-- @see https://github.com/CTU-OpenPaw/lattice-dx
-- SPDX-License-Identifier: Apache-2.0

BEGIN;

CREATE TABLE IF NOT EXISTS uc2_integration.sensor_deliveries (
    reading_id bigint PRIMARY KEY
        REFERENCES uc2_integration.sensor_readings(id),

    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'succeeded', 'stale', 'skipped', 'failed'
        )),

    attempts integer NOT NULL DEFAULT 0
        CHECK (attempts >= 0),

    last_error_code text,

    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_attempt_at timestamptz,
    completed_at timestamptz,

    CONSTRAINT sensor_deliveries_completion_matches_status
        CHECK (
            (status = 'pending' AND completed_at IS NULL)
            OR
            (status <> 'pending' AND completed_at IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS sensor_deliveries_pending_idx
    ON uc2_integration.sensor_deliveries (created_at, reading_id)
    WHERE status = 'pending';

-- Preserve existing readings and initialize delivery tracking.
-- Invalid/missing measurements stay in history without broker delivery.
INSERT INTO uc2_integration.sensor_deliveries (
    reading_id,
    status,
    completed_at
)
SELECT
    id,
    CASE WHEN quality = 'good' THEN 'pending' ELSE 'skipped' END,
    CASE WHEN quality = 'good' THEN NULL ELSE clock_timestamp() END
FROM uc2_integration.sensor_readings
ON CONFLICT (reading_id) DO NOTHING;

COMMIT;