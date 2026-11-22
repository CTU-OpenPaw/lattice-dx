/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeLabOrigin,
  createRootApiClient,
} from './setup-native-multi-portal-demo.mjs';

export function parseDxosAiSetupArgs(argv) {
  let reportPath = null;
  let origin = null;
  let defaultOrigin = 'http://127.0.0.1';

  for (const arg of argv) {
    if (arg.startsWith('--origin=')) {
      origin = arg.slice('--origin='.length);
    } else if (arg.startsWith('--default-origin=')) {
      defaultOrigin = arg.slice('--default-origin='.length).trim();
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (reportPath === null) {
      reportPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!reportPath && !origin) {
    throw new Error(
      'Usage: node scripts/setup-dxos-ai-workforce.mjs <clean-install report.json> | --origin=http://localhost:13014 [--default-origin=http://127.0.0.1]',
    );
  }
  if (origin !== null) origin = assertSafeLabOrigin(origin);
  if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(defaultOrigin)) {
    throw new Error(`Invalid --default-origin "${defaultOrigin}"`);
  }
  return { reportPath, origin, defaultOrigin };
}

export async function setupDxosAiWorkforce(api, { defaultOrigin = 'http://127.0.0.1', env = process.env } = {}) {
  const bootstrap = await api('dxosAi:bootstrapDefaults', {
    method: 'POST',
    values: { defaultOrigin },
  });
  let llm = bootstrap?.llm || { skipped: true, configured: false };
  const apiKey = String(env?.AGENT_API_KEY || env?.NINE_ROUTER_API_KEY || '').trim();
  const baseURL = String(env?.AGENT_BASE_URL || 'http://host.docker.internal:20128/v1').trim();
  if (apiKey) {
    const existingList = await api('llmServices:list?pageSize=50').catch(() => []);
    const items = Array.isArray(existingList) ? existingList : existingList?.rows || [];
    const existed = items.find((s) => s.name === 'local-9router');
    const llmValues = {
      name: 'local-9router',
      title: 'Local 9router (OpenAI-compatible)',
      provider: 'openai-completions',
      enabled: true,
      options: { baseURL, apiKey },
      enabledModels: {
        mode: 'custom',
        models: [
          { label: 'ag/gemini-3.8-flash (9router)', value: 'ag/gemini-3.8-flash' },
          { label: 'combo (9router auto-route)', value: 'combo' },
        ],
      },
    };
    if (existed) {
      await api('llmServices:update?filterByTk=local-9router', { method: 'POST', values: llmValues });
    } else {
      await api('llmServices:create', { method: 'POST', values: llmValues });
    }
    llm = { configured: true, skipped: false, serviceName: 'local-9router', baseURL };
  }

  const listed = await api('dxosAi:listProfiles');
  const profiles = Array.isArray(listed?.profiles) ? listed.profiles : [];
  assert.ok(profiles.length >= 5, `Expected >= 5 bootstrapped AI profiles, got ${profiles.length}`);

  const arch = profiles.find((p) => p.username === 'dxos-architect');
  assert.ok(arch?.isAdminBuilder, 'dxos-architect must carry isAdminBuilder=true');
  assert.deepEqual([...(arch.allowedRoles || [])].sort(), ['admin', 'root']);

  let itOtMcpSynced = false;
  try {
    const mcpRows = await api('aiMcpClients:list?pageSize=50');
    const items = Array.isArray(mcpRows) ? mcpRows : mcpRows?.rows || [];
    const hit = items.find((m) => m.name === 'dxos-it-ot-mcp');
    itOtMcpSynced = Boolean(hit && hit.transport === 'http' && hit.useUserContext === true);
  } catch {
    itOtMcpSynced = profiles.some((p) => Array.isArray(p.mcpServers) && p.mcpServers.some((s) => s.name === 'dxos-it-ot-mcp'));
  }

  return {
    result: 'PASS',
    bootstrappedCount: Number(bootstrap?.bootstrappedCount ?? profiles.length),
    activeProfileCount: profiles.length,
    profiles: profiles.map((p) => p.username),
    llm,
    itOtMcpSynced,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseDxosAiSetupArgs(process.argv.slice(2));
  (async () => {
    let targetOrigin = args.origin;
    if (args.reportPath) {
      const report = JSON.parse(await readFile(resolve(args.reportPath), 'utf8'));
      targetOrigin = assertSafeLabOrigin(report.origin);
    }
    const api = await createRootApiClient(targetOrigin);
    const out = await setupDxosAiWorkforce(api, { defaultOrigin: args.defaultOrigin });
    console.log(JSON.stringify({ origin: targetOrigin, ...out }));
  })().catch((err) => {
    console.error(JSON.stringify({ result: 'FAIL', error: err.message }));
    process.exitCode = 1;
  });
}
