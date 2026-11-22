/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { registerSubscription, subscriptionConfig } from './lib/ngsi-ld-subscription.mjs';
try {
  if (process.argv.slice(2).some(arg => arg !== '--recreate')) throw new Error('Supported option: --recreate (resets this demo subscription and counters only).');
  await registerSubscription(await subscriptionConfig(), { recreate: process.argv.includes('--recreate') });
}
catch (error) { console.error(error.message); process.exitCode = 1; }
