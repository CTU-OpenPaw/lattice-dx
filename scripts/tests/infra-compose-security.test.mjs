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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('prod.yml enforces 4 isolated networks, mandatory secrets, pinned upgraded digests, non-root caps, and edge-only ports', () => {
  const prod = read('infra/compose/prod.yml');
  assert.match(prod, /^name:\s*lattice-dx-prod/m);

  // 4 networks: edge (public), plus internal app/data/scanner
  for (const net of ['edge:', 'app:', 'data:', 'scanner:']) {
    assert.ok(prod.includes(net), `prod.yml missing network ${net}`);
  }
  const internalCount = (prod.match(/internal:\s*true/g) || []).length;
  assert.ok(internalCount >= 3, `Expected app/data/scanner networks internal: true, found ${internalCount}`);

  // All image lines must be pinned with @sha256
  const imageLines = prod.split(/\r?\n/).filter((l) => /^\s*image:/.test(l));
  assert.ok(imageLines.length >= 12, 'Expected >=12 pinned service images in prod.yml');
  for (const line of imageLines) {
    assert.match(line, /@sha256:[a-f0-9]{64}/, `Unpinned image in prod.yml: ${line}`);
  }

  // Upgraded stack versions
  for (const expected of [
    'postgres:16.16-alpine@sha256:',
    'pgvector/pgvector:0.8.1-pg16@sha256:',
    'redis:7.4-alpine@sha256:',
    'caddy:2.10-alpine@sha256:',
    'apache/apisix:3.19.0-debian@sha256:',
    'quay.io/keycloak/keycloak:26.8.2@sha256:',
    'adorsys/keycloak-config-cli:6.5.1-26@sha256:',
    'mongo:8.0@sha256:',
    'fiware/orion-ld:1.12.0@sha256:',
    'clamav/clamav:1.5.5@sha256:',
    'n8nio/n8n:2.48.1@sha256:',
    'nocobase/nocobase:2.2.50@sha256:',
    'rustfs/rustfs:1.0.6@sha256:',
  ]) {
    assert.ok(prod.includes(expected), `prod.yml must pin ${expected}`);
  }

  // Zero hardcoded dev secrets
  assert.doesNotMatch(prod, /local-demo-password|local-nocobase-password|local-admin-password|public-fixture|local-gateway-secret/);

  // Hardening policies & runtime protections
  assert.match(prod, /no-new-privileges:true/);
  assert.match(prod, /cap_drop:\s*\r?\n\s*-\s*ALL/);
  assert.match(prod, /mem_limit:/);
  assert.match(prod, /PUBSUB_ADAPTER:\s*redis/);
  assert.match(prod, /"--auth"/);
  assert.match(prod, /(?:"|-\s)-mongocOnly/);
  assert.doesNotMatch(prod, /start-dev/);
  assert.match(prod, /"start"/);

  // Only caddy binds host ports (80, 443)
  const portMatches = [...prod.matchAll(/^\s*-\s*["']?([^"'\r\n]+)["']?/gm)]
    .map((m) => m[1])
    .filter((v) => /^\d+:\d+/.test(v));
  assert.deepEqual(portMatches.sort(), ['443:443', '443:443/udp', '80:80']);

  // Env template uses PoF-safe name and no legacy .env.prod.example
  assert.equal(existsSync(join(ROOT, 'infra/compose/prod.env.example')), true);
  assert.equal(existsSync(join(ROOT, 'infra/compose/.env.prod.example')), false);
  const envEx = read('infra/compose/prod.env.example');
  for (const reqVar of [
    'LATTICE_DOMAIN=',
    'KEYCLOAK_DOMAIN=',
    'POSTGRES_SUPERUSER_PASSWORD=',
    'NOCOBASE_DB_PASSWORD=',
    'REDIS_PASSWORD=',
    'NOCOBASE_APP_KEY=',
    'APISIX_OIDC_CLIENT_SECRET=',
  ]) {
    assert.ok(envEx.includes(reqVar), `prod.env.example missing ${reqVar}`);
  }
});

test('Caddyfile, APISIX prod config, Postgres least-privilege/PITR, and Keycloak prod realm meet zero-trust standards', () => {
  const caddy = read('infra/config/caddy/Caddyfile');
  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /X-Content-Type-Options\s+"?nosniff"?/);
  assert.match(caddy, /X-Frame-Options\s+"?SAMEORIGIN"?/);
  assert.match(caddy, /reverse_proxy\s+nocobase:80/);
  assert.match(caddy, /reverse_proxy\s+keycloak:8080/);

  const apisixProd = read('infra/config/apisix/apisix.prod.yaml');
  assert.doesNotMatch(apisixProd, /ssl_verify:\s*false/);
  assert.doesNotMatch(apisixProd, /local-gateway-secret/);
  assert.match(apisixProd, /ssl_verify:\s*true/);
  assert.match(apisixProd, /policy:\s*redis/);
  assert.match(apisixProd, /APISIX_OIDC_CLIENT_SECRET/);

  const apisixCfg = read('infra/config/apisix/config.prod.yaml');
  assert.match(apisixCfg, /response-rewrite/);
  assert.match(apisixCfg, /cors/);

  const initProd = read('infra/config/postgres/init-prod.sh');
  assert.match(initProd, /ON_ERROR_STOP=1/);
  assert.match(initProd, /NOSUPERUSER\s+NOCREATEDB\s+NOCREATEROLE/);
  assert.match(initProd, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);

  const pitr = read('infra/config/postgres/pitr.conf');
  assert.match(pitr, /wal_level\s*=\s*replica/);
  assert.match(pitr, /archive_mode\s*=\s*on/);

  const realm = JSON.parse(read('infra/config/keycloak/lattice-realm.prod.json'));
  assert.equal(realm.sslRequired, 'external');
  assert.equal(realm.bruteForceProtected, true);
  assert.equal(realm.eventsEnabled, true);
  assert.equal(realm.adminEventsEnabled, true);
  assert.ok(realm.passwordPolicy && realm.passwordPolicy.includes('length(12)'));
  assert.equal(Array.isArray(realm.users) ? realm.users.length : 0, 0, 'prod realm must not seed static users');
  assert.ok(Array.isArray(realm.groups) && realm.groups.length >= 4);
  for (const client of realm.clients || []) {
    assert.notEqual(client.directAccessGrantsEnabled, true, 'ROPC password grant forbidden in prod realm');
    if (client.clientId === 'dx-native') {
      assert.equal(client.standardFlowEnabled, true);
      assert.equal(client.attributes?.['pkce.code.challenge.method'], 'S256');
      assert.ok(client.attributes?.['backchannel.logout.url']?.includes('backchannelLogout'));
    }
    if (client.clientId === 'dx-gateway') {
      assert.match(String(client.secret || ''), /APISIX_OIDC_CLIENT_SECRET/);
    }
  }
});

test('local compose stacks upgrade all images to non-EOL digests, add Redis PubSub, and harden containers', () => {
  for (const file of [
    'infra/compose/core.yml',
    'infra/compose/nocobase.yml',
    'infra/compose/integration.yml',
    'infra/compose/native-rehearsal.yml',
    'infra/compose/uc1-sample.yml',
  ]) {
    const text = read(file);
    assert.doesNotMatch(text, /postgres:16\.13|mongo:4\.4\.29|orion-ld:1\.10\.0|clamav:1\.4\.3|keycloak:26\.8\.0|n8nio\/n8n:2\.42\.7|nocobase:2\.2\.38/);
    assert.match(text, /no-new-privileges:true/);
    assert.match(text, /mem_limit:/);
  }
  const nocobase = read('infra/compose/nocobase.yml');
  assert.match(nocobase, /redis:7\.4-alpine@sha256:/);
  assert.match(nocobase, /PUBSUB_ADAPTER:\s*redis/);

  const integration = read('infra/compose/integration.yml');
  assert.match(integration, /mongo:8\.0@sha256:/);
  assert.match(integration, /"--auth"/);
  assert.match(integration, /fiware\/orion-ld:1\.12\.0@sha256:/);
  assert.match(integration, /(?:"|-\s)-mongocOnly/);
});

test('apps/api and apps/agent-worker Dockerfiles exist with SPDX header, non-root USER, and HEALTHCHECK', () => {
  for (const dockerfile of ['apps/api/Dockerfile', 'apps/agent-worker/Dockerfile']) {
    assert.equal(existsSync(join(ROOT, dockerfile)), true, `Missing ${dockerfile}`);
    const content = read(dockerfile);
    assert.match(content, /SPDX-License-Identifier:\s*Apache-2\.0/);
    assert.match(content, /^USER\s+node/m);
    assert.match(content, /^HEALTHCHECK\s+/m);
  }
});
