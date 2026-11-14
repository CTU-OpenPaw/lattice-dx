/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from "node:crypto";

export const SENSOR_SCENARIOS = Object.freeze([
  "normal",
  "anomalous",
  "missing",
  "stale",
  "malformed",
]);

/**
 * Generate simulated temperature readings without network or database writes.
 * Scenario labels describe fixtures, not validated ingestion quality.
 */
export function generateSensorFixtures({
  assetUrn,
  referenceTime,
  seed = "uc2-demo-v1",
} = {}) {
  const assetMatch =
    /^urn:ngsi-ld:Asset:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})$/
      .exec(assetUrn ?? "");

  if (typeof assetUrn !== "string" || !assetMatch) {
    throw new Error("A valid tenant-scoped Asset URN is required.");
  }

  if (
    typeof seed !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(seed)
  ) {
    throw new Error("Seed must contain 1–64 ASCII letters, digits, . _ or -.");
  }

  const referenceMs =
    typeof referenceTime === "string" ? Date.parse(referenceTime) : NaN;

  if (
    !Number.isFinite(referenceMs) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(referenceTime) ||
    new Date(referenceMs).toISOString() !== referenceTime ||
    referenceMs < 3_600_000
  ) {
    throw new Error(
      "Reference time must be a valid UTC timestamp with milliseconds, " +
      "at least one hour after the Unix epoch.",
    );
  }

  const cases = [
    { scenario: "normal", ageSeconds: 4, value: 25 },
    { scenario: "anomalous", ageSeconds: 3, value: 85 },
    { scenario: "missing", ageSeconds: 2 },
    { scenario: "stale", ageSeconds: 3600, value: 85 },
    { scenario: "malformed", ageSeconds: 1, value: "not-a-number" },
  ];

  return cases.map(({ scenario, ageSeconds, ...measurement }) => {
    const reading = {
      schemaVersion: 1,
      assetUrn,
      attribute: "temperature",
      unit: "celsius",
      ...measurement,
      observedAt: new Date(
        referenceMs - ageSeconds * 1000,
      ).toISOString(),
      source: {
        system: "latticedx-simulator",
        deviceId: "simulated-temperature-001",
      },
      simulated: true,
      simulation: {
        scenario,
        seed,
        referenceTime,
      },
    };

    const digest = createHash("sha256")
      .update(JSON.stringify(reading))
      .digest("hex");

    return {
      eventId: `sim:${digest}`,
      ...reading,
    };
  });
}