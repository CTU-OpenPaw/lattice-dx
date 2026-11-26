/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function serviceSection(composeText, name) {
  const re = new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|^volumes:)`, 'm');
  const m = composeText.match(re);
  assert.ok(m, `Missing service ${name}`);
  return m[1];
}

function loadNoderedSettingsWithEnv(envOverrides) {
  const settingsPath = join(ROOT, 'infra/config/nodered/settings.js');
  const code = readFileSync(settingsPath, 'utf8');
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    process: { env: { ...envOverrides } },
  };
  vm.runInNewContext(code, sandbox, { filename: settingsPath });
  return mod.exports;
}

function runNoderedCredBootstrapSnippet(snippet, { u, p, secret }) {
  let written = null;
  const fakeFs = {
    writeFileSync(filePath, content, opts) {
      written = { filePath, content, opts };
    },
  };
  const fakeProcess = {
    env: {
      MQTT_BRIDGE_USER: u,
      MQTT_BRIDGE_PASSWORD: p,
      NODERED_CREDENTIAL_SECRET: secret,
    },
  };
  const fakeRequire = (mod) => {
    if (mod === 'fs' || mod === 'node:fs') return fakeFs;
    if (mod === 'crypto' || mod === 'node:crypto') return crypto;
    throw new Error(`Unexpected module required in Node-RED bootstrap: ${mod}`);
  };
  const fn = new Function('require', 'process', snippet);
  fn(fakeRequire, fakeProcess);
  return written;
}

test('P0-09: prod.yml and prod.env.example require NODERED_ADMIN_PASS_HASH and settings.js fails closed in prod', () => {
  const prod = read('infra/compose/prod.yml');
  const noderedProd = serviceSection(prod, 'nodered');
  assert.match(noderedProd, /NODERED_ADMIN_PASS_HASH:\s*\$\{NODERED_ADMIN_PASS_HASH:\?Set NODERED_ADMIN_PASS_HASH\}/);
  assert.match(noderedProd, /NODERED_REQUIRE_ADMIN_AUTH:\s*"true"/);

  const envEx = read('infra/compose/prod.env.example');
  assert.match(envEx, /^NODERED_ADMIN_PASS_HASH=CHANGE_ME_BCRYPT_NODERED_ADMIN_PASS_HASH$/m);

  assert.throws(
    () => loadNoderedSettingsWithEnv({
      NODERED_REQUIRE_ADMIN_AUTH: 'true',
      NODERED_ADMIN_USER: 'nodered_admin',
      NODERED_ADMIN_PASS_HASH: '',
      NODERED_CREDENTIAL_SECRET: 'secret',
    }),
    /NODERED_ADMIN_USER|NODERED_ADMIN_PASS_HASH/i,
  );

  const prodSettings = loadNoderedSettingsWithEnv({
    NODERED_REQUIRE_ADMIN_AUTH: 'true',
    NODERED_ADMIN_USER: 'nodered_admin',
    NODERED_ADMIN_PASS_HASH: '$2b$10$examplehashvalue',
    NODERED_CREDENTIAL_SECRET: 'secret',
  });
  assert.equal(prodSettings.credentialSecret, 'secret');
  assert.equal(prodSettings.adminAuth.users[0].username, 'nodered_admin');

  const devSettings = loadNoderedSettingsWithEnv({
    NODERED_REQUIRE_ADMIN_AUTH: '',
    NODERED_ADMIN_USER: '',
    NODERED_ADMIN_PASS_HASH: '',
  });
  assert.equal(devSettings.credentialSecret, false);
  assert.equal(devSettings.adminAuth, undefined);
});

test('P0-09: Node-RED flows_cred.json bootstrap encrypts with Node-RED 4.0.9 aes-256-ctr when secret is set', () => {
  for (const rel of ['infra/compose/prod.yml', 'infra/compose/iiot.yml']) {
    const compose = read(rel);
    const noderedSec = serviceSection(compose, 'nodered');
    const match = noderedSec.match(/node -e '([^']+)'/);
    assert.ok(match, `${rel} missing node -e flows_cred.json bootstrap`);
    const snippet = match[1];
    assert.equal(snippet.includes('$'), false, `${rel} snippet must not contain literal $ (Compose interpolation hazard)`);

    // When secret is non-empty, output must use { "$": "<32-hex-iv><base64>" }
    const encryptedOut = runNoderedCredBootstrapSnippet(snippet, {
      u: 'nodered_bridge',
      p: 'bridge-secret-pass',
      secret: 'my-nodered-cred-secret',
    });
    assert.equal(encryptedOut.filePath, '/data/flows_cred.json');
    assert.equal(encryptedOut.opts?.mode, 0o600);
    const parsedEnc = JSON.parse(encryptedOut.content);
    assert.equal(typeof parsedEnc.$, 'string');
    assert.equal(parsedEnc['latticedx-mqtt-broker'], undefined);

    const key = crypto.createHash('sha256').update('my-nodered-cred-secret').digest();
    const iv = Buffer.from(parsedEnc.$.slice(0, 32), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
    const decrypted = decipher.update(parsedEnc.$.slice(32), 'base64', 'utf8') + decipher.final('utf8');
    assert.deepEqual(JSON.parse(decrypted), {
      'latticedx-mqtt-broker': { user: 'nodered_bridge', password: 'bridge-secret-pass' },
    });

    // When secret is empty or whitespace-only, plaintext JSON fallback is preserved (matching settings.js .trim())
    for (const emptySecret of ['', '   ']) {
      const plainOut = runNoderedCredBootstrapSnippet(snippet, {
        u: 'nodered_bridge',
        p: 'local-pass',
        secret: emptySecret,
      });
      assert.deepEqual(JSON.parse(plainOut.content), {
        'latticedx-mqtt-broker': { user: 'nodered_bridge', password: 'local-pass' },
      });
    }
  }
});

test('P3-04: logistics-order-webhook.json moved from repo root to infra/config/n8n/ and references updated', () => {
  assert.equal(existsSync(join(ROOT, 'logistics-order-webhook.json')), false, 'Root logistics-order-webhook.json must be removed');
  const destPath = join(ROOT, 'infra/config/n8n/logistics-order-webhook.json');
  assert.equal(existsSync(destPath), true, 'Missing infra/config/n8n/logistics-order-webhook.json');

  const parsed = JSON.parse(readFileSync(destPath, 'utf8'));
  assert.ok(Array.isArray(parsed) && parsed.length === 1);
  assert.equal(parsed[0].name, 'LatticeDX - Logistics Order Intake');
  assert.ok(parsed[0].nodes.some((n) => n.name === 'Webhook'));
  assert.ok(parsed[0].nodes.some((n) => n.name === 'Create Logistics Order'));

  const fixtureScript = read('scripts/prepare-n8n-failure-fixture.mjs');
  assert.match(fixtureScript, /\.\.\/infra\/config\/n8n\/logistics-order-webhook\.json/);
  assert.doesNotMatch(fixtureScript, /\.\.\/logistics-order-webhook\.json/);

  const doc = read('docs/integration-ngsi-ld-n8n.md');
  assert.match(doc, /\.\.\/infra\/config\/n8n\/logistics-order-webhook\.json/);
  assert.doesNotMatch(doc, /\.\.\/logistics-order-webhook\.json/);
});

test('P1-17: README.md and docs/FINALS_15MIN_SCRIPT.md align script names and ground-truth metrics', () => {
  const readme = read('README.md');
  assert.match(readme, /pnpm acceptance:broker-automation-builder -- --origin=http:\/\/localhost:13014/);
  assert.doesNotMatch(readme, /pnpm acceptance:broker-automation\s+--/);
  assert.match(readme, /56 bảng tĩnh/);
  assert.doesNotMatch(readme, /54 bảng tĩnh/);
  assert.match(readme, /11 tab Studio/);
  assert.doesNotMatch(readme, /9 tab Studio/);

  const scriptDoc = read('docs/FINALS_15MIN_SCRIPT.md');
  assert.match(scriptDoc, /pnpm acceptance:broker-automation-builder -- --origin=http:\/\/localhost:13014/);
  assert.doesNotMatch(scriptDoc, /pnpm acceptance:broker-automation\s+--/);
  assert.match(scriptDoc, /Control Studio \*\*11 Tabs\*\*/);
  assert.doesNotMatch(scriptDoc, /\*\*9 Tabs\*\*/);
  assert.match(scriptDoc, /AI\/MCP \(20 Tools \+ App Builder \+ HITL\)/);
  assert.doesNotMatch(scriptDoc, /17 Tools/);
  assert.match(scriptDoc, /\(163\/163 ca\)/);
  assert.doesNotMatch(scriptDoc, /\(112\/112 ca\)/);
  assert.match(scriptDoc, /56 bảng tĩnh `lattice\*`/);
  assert.doesNotMatch(scriptDoc, /42 bảng `lattice\*`/);
});

test('P1-15: apisix.prod.yaml dxos-public-paas allowlists /api/dxos:icon-192.png and /api/dxos:icon-512.png', () => {
  const apisixProd = read('infra/config/apisix/apisix.prod.yaml');
  assert.match(
    apisixProd,
    /id:\s*dxos-public-paas[\s\S]*?\/api\/dxos:manifest[\s\S]*?\/api\/dxos:sw\.js[\s\S]*?\/api\/dxos:icon-192\.png[\s\S]*?\/api\/dxos:icon-512\.png[\s\S]*?"nocobase:80"/,
  );
});

test('P1-17: pitr-archive.sh checks gzip -t integrity before comparing and fails on corrupt .gz + 0-byte WAL', (t) => {
  const pitrSh = read('infra/config/postgres/pitr-archive.sh');
  assert.match(pitrSh, /gzip -t -- "\$dest" 2>\/dev\/null && gzip -dc -- "\$dest" 2>\/dev\/null \| cmp -s - "\$wal_path"/);

  const shCandidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'sh']
    : ['sh'];
  let shBin = null;
  for (const cand of shCandidates) {
    const probe = spawnSync(cand, ['-c', 'command -v gzip >/dev/null && command -v cmp >/dev/null'], { encoding: 'utf8' });
    if (probe.status === 0) {
      shBin = cand;
      break;
    }
  }
  if (!shBin) {
    t.skip('POSIX sh with gzip and cmp not available on PATH');
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'pitr-archive-guard-'));
  try {
    const walDir = join(work, 'archive');
    const walFile = join(work, '000000010000000000000099');
    const corruptDest = join(walDir, '000000010000000000000099.gz');
    const scriptPath = join(ROOT, 'infra/config/postgres/pitr-archive.sh');

    const mkdirRes = spawnSync(shBin, ['-c', `mkdir -p "$1"`, '_', walDir], { encoding: 'utf8' });
    assert.equal(mkdirRes.status, 0);

    // 0-byte source WAL + corrupt existing .gz must exit 1 (not masked by empty stdout from gzip -dc)
    writeFileSync(walFile, Buffer.alloc(0));
    writeFileSync(corruptDest, Buffer.from('not-a-valid-gzip-stream', 'utf8'));

    const corruptRes = spawnSync(shBin, [scriptPath, walFile, '000000010000000000000099'], {
      env: { ...process.env, PITR_WAL_DIR: walDir },
      encoding: 'utf8',
    });
    assert.equal(corruptRes.status, 1, `Expected exit 1 on corrupt .gz + 0-byte WAL, got ${corruptRes.status}`);
    assert.match(corruptRes.stderr, /already exists with different content/);

    // Fresh WAL archive + idempotent retry must exit 0
    const walOk = join(work, '00000001000000000000009A');
    writeFileSync(walOk, Buffer.from('WAL_RECORD_OK_2026', 'utf8'));
    const firstOk = spawnSync(shBin, [scriptPath, walOk, '00000001000000000000009A'], {
      env: { ...process.env, PITR_WAL_DIR: walDir },
      encoding: 'utf8',
    });
    assert.equal(firstOk.status, 0, firstOk.stderr);
    const retryOk = spawnSync(shBin, [scriptPath, walOk, '00000001000000000000009A'], {
      env: { ...process.env, PITR_WAL_DIR: walDir },
      encoding: 'utf8',
    });
    assert.equal(retryOk.status, 0, retryOk.stderr);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
