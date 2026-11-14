/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'plugins/nocobase/*/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**', 'upstream/**'] } });
