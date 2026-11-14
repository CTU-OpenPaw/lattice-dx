/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { generateSensorFixtures } from "./lib/sensor-simulator.mjs";

const args = process.argv.slice(2);

try {
  if (args.length < 2 || args.length > 3) {
    throw new Error(
      "Usage: node scripts/simulate-sensor.mjs " +
      "<asset-urn> <reference-time> [seed]",
    );
  }

  const [assetUrn, referenceTime, seed = "uc2-demo-v1"] = args;

  const readings = generateSensorFixtures({
    assetUrn,
    referenceTime,
    seed,
  });

  process.stdout.write(
    readings.map((reading) => JSON.stringify(reading)).join("\n") + "\n",
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Sensor simulation failed.",
  );
  process.exitCode = 1;
}