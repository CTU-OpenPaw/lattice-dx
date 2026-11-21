/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDxosAiSetupArgs,
  setupDxosAiWorkforce,
} from '../setup-dxos-ai-workforce.mjs';

test('parseDxosAiSetupArgs validates lab origin and optional default-origin', () => {
  assert.throws(() => parseDxosAiSetupArgs([]), /Usage:/);
  assert.throws(() => parseDxosAiSetupArgs(['--origin=http://localhost:13000']), /Unsafe/i);
  const parsed = parseDxosAiSetupArgs(['--origin=http://localhost:13014', '--default-origin=http://127.0.0.1']);
  assert.equal(parsed.origin, 'http://localhost:13014');
  assert.equal(parsed.defaultOrigin, 'http://127.0.0.1');
});

test('setupDxosAiWorkforce bootstraps starter blueprints and verifies profiles & IT/OT MCP connector', async () => {
  const calls = [];
  const fakeApi = async (path, opts = {}) => {
    calls.push({ path, opts });
    if (path === 'dxosAi:bootstrapDefaults') {
      return {
        bootstrappedCount: 5,
        profiles: ['dxos-coordinator', 'dxos-architect', 'dxos-ops', 'dxos-logistics', 'dxos-workspace'],
        llm: { skipped: true, configured: false },
      };
    }
    if (path === 'dxosAi:listProfiles') {
      return {
        profiles: [
          { username: 'dxos-coordinator', mcpServers: [{ name: 'dxos-it-ot-mcp' }] },
          { username: 'dxos-architect', isAdminBuilder: true, allowedRoles: ['root', 'admin'] },
          { username: 'dxos-ops' },
          { username: 'dxos-logistics' },
          { username: 'dxos-workspace' },
        ],
      };
    }
    if (path.startsWith('aiMcpClients:list')) {
      return [{ name: 'dxos-it-ot-mcp', transport: 'http', useUserContext: true }];
    }
    throw new Error(`Unexpected path: ${path}`);
  };

  const out = await setupDxosAiWorkforce(fakeApi, { defaultOrigin: 'http://127.0.0.1' });
  assert.equal(out.result, 'PASS');
  assert.equal(out.bootstrappedCount, 5);
  assert.equal(out.activeProfileCount, 5);
  assert.equal(out.itOtMcpSynced, true);
  assert.equal(calls[0].opts.values.defaultOrigin, 'http://127.0.0.1');
});
