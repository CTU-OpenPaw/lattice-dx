// SPDX-License-Identifier: Apache-2.0
import { registerSubscription, subscriptionConfig } from './lib/ngsi-ld-subscription.mjs';
try { await registerSubscription(await subscriptionConfig()); }
catch (error) { console.error(error.message); process.exitCode = 1; }
