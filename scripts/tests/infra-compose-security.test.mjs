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

  // 5 networks: edge (public), plus internal app/data/scanner/iiot-net
  for (const net of ['edge:', 'app:', 'data:', 'scanner:', 'iiot-net:']) {
    assert.ok(prod.includes(net), `prod.yml missing network ${net}`);
  }
  const internalCount = (prod.match(/internal:\s*true/g) || []).length;
  assert.ok(internalCount >= 4, `Expected app/data/scanner/iiot-net networks internal: true, found ${internalCount}`);

  // All image lines must be pinned with @sha256
  const imageLines = prod.split(/\r?\n/).filter((l) => /^\s*image:/.test(l));
  assert.ok(imageLines.length >= 19, `Expected >=19 pinned service images in prod.yml, found ${imageLines.length}`);
  for (const line of imageLines) {
    assert.match(line, /@sha256:[a-f0-9]{64}/, `Unpinned image in prod.yml: ${line}`);
  }

  // Upgraded stack versions and OSI pinned digests (Valkey BSD-3-Clause replaces Redis)
  for (const expected of [
    'postgres:16.16-alpine@sha256:',
    'pgvector/pgvector:0.8.1-pg16@sha256:',
    'valkey/valkey:8.1-alpine@sha256:9971099af41c36e887aabdfe22b80c0fe45df949163dfc9cb434febc57cfc3fc',
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
    'gotenberg/gotenberg:8.20.1@sha256:cda4386c7ed38f18bc6897828be01ba7361c99929a5c84ec5e293d7916e29bac',
    'otel/opentelemetry-collector-contrib:0.123.0@sha256:e39311df1f3d941923c00da79ac7ba6269124a870ee87e3c3ad24d60f8aee4d2',
    'prom/prometheus:v3.3.0@sha256:339ce86a59413be18d0e445472891d022725b4803fab609069110205e79fb2f1',
    'grafana/grafana-oss:11.5.8@sha256:b8121de93047fd77c77de806bae9706e7d60de21c3bd5381a5db0167f94c6a48',
    'eclipse-mosquitto:2.0.21@sha256:94f5a3d7deafa59fa3440d227ddad558f59d293c612138de841eec61bfa4d353',
    'nodered/node-red:4.0.9@sha256:0b295b3a14c512548567ca99db631bc37b23bfc79fd009ee8248a610fafdb4b5',
  ]) {
    assert.ok(prod.includes(expected), `prod.yml must pin ${expected}`);
  }
  assert.doesNotMatch(prod, /redis:7\.4-alpine/);

  // Zero hardcoded dev secrets
  assert.doesNotMatch(prod, /local-demo-password|local-nocobase-password|local-admin-password|public-fixture|local-gateway-secret/);

  // Legacy api/agent-worker replaced by lean file-scanner
  assert.doesNotMatch(prod, /^\s{2}api:\s*$/m);
  assert.doesNotMatch(prod, /^\s{2}agent-worker:\s*$/m);
  assert.doesNotMatch(prod, /http:\/\/api:4000/);

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
    'N8N_DOMAIN=',
    'POSTGRES_SUPERUSER_PASSWORD=',
    'NOCOBASE_DB_PASSWORD=',
    'NOCOBASE_APP_DB_PASSWORD=',
    'REDIS_PASSWORD=',
    'NOCOBASE_APP_KEY=',
    'APISIX_OIDC_CLIENT_SECRET=',
    'DX_METRICS_TOKEN=CHANGE_ME_METRICS_TOKEN',
    'GRAFANA_ADMIN_PASSWORD=CHANGE_ME_GRAFANA_ADMIN_PASSWORD',
    'FILE_STORAGE_PROVIDER=s3',
    'DX_PG_RLS_SESSION=true',
    'PG_ARCHIVE_COMMAND=/bin/sh /etc/postgresql/pitr-archive.sh %p %f',
    'OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318',
    'MQTT_ADMIN_USER=',
    'MQTT_ADMIN_PASSWORD=',
    'MQTT_BRIDGE_USER=',
    'MQTT_BRIDGE_PASSWORD=',
    'DX_IIOT_INGEST_TOKEN=',
    'NODERED_CREDENTIAL_SECRET=',
  ]) {
    assert.ok(envEx.includes(reqVar), `prod.env.example missing ${reqVar}`);
  }
});

function serviceSection(composeText, name) {
  const re = new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|^volumes:)`, 'm');
  const m = composeText.match(re);
  assert.ok(m, `Missing service ${name}`);
  return m[1];
}

test('prod.yml wires file-scanner, observability profile, pdf profile, nocobase hardening env, and PITR archive script', () => {
  const prod = read('infra/compose/prod.yml');

  const scanner = serviceSection(prod, 'file-scanner');
  assert.match(scanner, /dockerfile:\s*apps\/file-scanner\/Dockerfile/);
  assert.match(scanner, /read_only:\s*true/);
  assert.match(scanner, /CLAMD_HOST:\s*clamav/);
  assert.match(scanner, /S3_ENDPOINT:\s*http:\/\/rustfs:9000/);
  assert.match(scanner, /S3_ACCESS_KEY_ID:/);
  assert.match(scanner, /S3_SECRET_ACCESS_KEY:/);
  assert.match(scanner, /FILE_STORAGE_PROVIDER:\s*\$\{FILE_STORAGE_PROVIDER:-s3\}/);
  assert.match(scanner, /mem_limit:\s*256m/);
  assert.match(scanner, /127\.0\.0\.1:4010\/health/);
  for (const net of ['- app', '- data', '- scanner']) {
    assert.ok(scanner.includes(net), `file-scanner missing network ${net}`);
  }

  const gateway = serviceSection(prod, 'gateway');
  assert.doesNotMatch(gateway, /^\s+api:\s*$/m);

  const nocobase = serviceSection(prod, 'nocobase');
  assert.match(nocobase, /DX_NATIVE_FILES_URL:\s*http:\/\/file-scanner:4010/);
  assert.match(nocobase, /DX_METRICS_TOKEN:\s*\$\{DX_METRICS_TOKEN:\?Set DX_METRICS_TOKEN\}/);
  assert.match(nocobase, /DX_PG_RLS_SESSION:\s*\$\{DX_PG_RLS_SESSION:-true\}/);
  assert.match(nocobase, /DXOS_GOTENBERG_URL:\s*\$\{DXOS_GOTENBERG_URL:-\}/);
  assert.match(nocobase, /OTEL_EXPORTER_OTLP_ENDPOINT:\s*(?:\$\{OTEL_EXPORTER_OTLP_ENDPOINT:-)?http:\/\/otel-collector:4318\}?/);
  assert.match(nocobase, /DX_IIOT_INGEST_TOKEN:\s*\$\{DX_IIOT_INGEST_TOKEN:\?Set DX_IIOT_INGEST_TOKEN\}/);
  assert.match(nocobase, /DX_MQTT_BROKER_HOST:\s*\$\{DX_MQTT_BROKER_HOST:-mosquitto\}/);
  assert.match(nocobase, /DX_NODERED_COMMAND_URL:\s*\$\{DX_NODERED_COMMAND_URL:-http:\/\/nodered:1880\/twin\/command\}/);
  assert.match(nocobase, /DX_ALLOW_INTERNAL_CONNECTORS:\s*\$\{DX_ALLOW_INTERNAL_CONNECTORS:-true\}/);
  assert.match(nocobase, /-\s*iiot-net/);
  assert.match(nocobase, /^\s+file-scanner:\s*$/m);
  assert.doesNotMatch(nocobase, /^\s+api:\s*$/m);

  const caddySvc = serviceSection(prod, 'caddy');
  assert.match(caddySvc, /N8N_DOMAIN:\s*\$\{N8N_DOMAIN:\?Set N8N_DOMAIN\}/);

  const n8nSvc = serviceSection(prod, 'n8n');
  assert.match(n8nSvc, /profiles:\s*\["n8n"\]/);
  assert.match(n8nSvc, /N8N_PUBLIC_API_DISABLED:\s*"false"/);

  const noderedSvc = serviceSection(prod, 'nodered');
  assert.match(noderedSvc, /NODERED_CREDENTIAL_SECRET:\s*\$\{NODERED_CREDENTIAL_SECRET:\?Set NODERED_CREDENTIAL_SECRET\}/);
  const noderedSettings = read('infra/config/nodered/settings.js');
  assert.match(noderedSettings, /NODERED_CREDENTIAL_SECRET/);
  assert.match(noderedSettings, /NODERED_ADMIN_USER/);
  assert.match(noderedSettings, /NODERED_ADMIN_PASS_HASH/);

  const otel = serviceSection(prod, 'otel-collector');
  assert.match(otel, /profiles:\s*\["observability"\]/);
  assert.match(otel, /\.\.\/config\/otel\/otel-collector\.yaml:[^:\r\n]+:ro/);
  assert.match(otel, /mem_limit:\s*512m/);
  assert.match(otel, /-\s*app/);
  assert.match(otel, /-\s*data/);

  const prom = serviceSection(prod, 'prometheus');
  assert.match(prom, /profiles:\s*\["observability"\]/);
  assert.match(prom, /\.\.\/config\/prometheus\/prometheus\.yml:[^:\r\n]+:ro/);
  assert.match(prom, /\.\.\/config\/prometheus\/alerts\.yml:\/etc\/prometheus\/alerts\.yml:ro/);
  assert.match(prom, /\/tmp:uid=65534,gid=65534,mode=0700,noexec,nosuid,size=16m/);
  assert.match(prom, /mem_limit:\s*512m/);
  assert.match(prom, /-\s*app/);
  assert.match(prom, /-\s*data/);

  const grafana = serviceSection(prod, 'grafana');
  assert.match(grafana, /profiles:\s*\["observability"\]/);
  assert.match(grafana, /grafana\/grafana-oss:11\.5\.8@sha256:b8121de93047fd77c77de806bae9706e7d60de21c3bd5381a5db0167f94c6a48/);
  assert.doesNotMatch(grafana, /^\s*ports:/m);
  assert.match(grafana, /GF_SECURITY_ADMIN_USER:\s*\$\{GRAFANA_ADMIN_USER:-admin\}/);
  assert.match(grafana, /GF_SECURITY_ADMIN_PASSWORD:\s*\$\{GRAFANA_ADMIN_PASSWORD:\?Set GRAFANA_ADMIN_PASSWORD\}/);
  assert.match(grafana, /GF_USERS_ALLOW_SIGN_UP:\s*"false"/);
  assert.match(grafana, /GF_ANALYTICS_REPORTING_ENABLED:\s*"false"/);
  assert.match(grafana, /\.\.\/config\/grafana\/provisioning:\/etc\/grafana\/provisioning:ro/);
  assert.match(grafana, /\.\.\/config\/grafana\/dashboards:\/var\/lib\/grafana\/dashboards:ro/);
  assert.match(grafana, /grafana-data:\/var\/lib\/grafana/);
  assert.match(grafana, /prometheus:/);
  assert.match(grafana, /mem_limit:\s*512m/);
  assert.match(grafana, /cpus:\s*"0\.5"/);
  assert.match(grafana, /127\.0\.0\.1:3000\/api\/health/);
  assert.match(grafana, /-\s*app/);
  assert.match(grafana, /-\s*data/);
  assert.doesNotMatch(grafana, /-\s*edge/);
  assert.match(prod, /^volumes:[\s\S]*^\s{2}grafana-data:/m);

  const gotenberg = serviceSection(prod, 'gotenberg');
  assert.match(gotenberg, /profiles:\s*\["pdf"\]/);
  assert.match(gotenberg, /read_only:\s*true/);
  assert.match(gotenberg, /tmpfs:/);
  assert.match(gotenberg, /\/tmp:mode=1777,noexec,nosuid,size=256m/);
  assert.match(gotenberg, /\/home\/gotenberg:uid=1001,gid=1001,mode=0700,noexec,nosuid,size=256m/);
  assert.match(gotenberg, /--chromium-disable-javascript=true/);
  assert.match(gotenberg, /mem_limit:\s*768m/);
  assert.match(gotenberg, /127\.0\.0\.1:3000\/health/);
  assert.match(gotenberg, /-\s*app/);
  assert.doesNotMatch(gotenberg, /-\s*edge/);

  for (const [pgSvc, expectedVol] of [
    ['postgres', 'postgres-wal-archive'],
    ['nocobase-db', 'nocobase-wal-archive'],
  ]) {
    const sec = serviceSection(prod, pgSvc);
    assert.match(sec, /\.\.\/config\/postgres\/pitr-archive\.sh:[^:\r\n]+:ro/);
    assert.match(sec, /include_if_exists=\/etc\/postgresql\/pitr\.conf/);
    assert.match(sec, /archive_command=\$\{PG_ARCHIVE_COMMAND:-\/bin\/sh \/etc\/postgresql\/pitr-archive\.sh %p %f\}/);
    assert.match(sec, new RegExp(`${expectedVol}:\\/var\\/lib\\/postgresql\\/wal-archive`));
    assert.match(prod, new RegExp(`^volumes:[\\s\\S]*^\\s{2}${expectedVol}:`, 'm'));
  }
  assert.doesNotMatch(serviceSection(prod, 'nocobase-db'), /postgres-wal-archive/);
});

test('observability configs and PostgreSQL PITR archive script meet security, SPDX, and credential hygiene standards', () => {
  const otelCfg = read('infra/config/otel/otel-collector.yaml');
  assert.match(otelCfg, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(otelCfg, /receivers:/);
  assert.match(otelCfg, /otlp:/);
  assert.match(otelCfg, /memory_limiter:/);
  assert.match(otelCfg, /prometheus:/);

  const promCfg = read('infra/config/prometheus/prometheus.yml');
  assert.match(promCfg, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(promCfg, /rule_files:\s*\["\/etc\/prometheus\/alerts\.yml"\]/);
  assert.match(promCfg, /nocobase:80/);
  assert.match(promCfg, /\/api\/dxos:metrics/);
  assert.match(promCfg, /caddy:2020/);
  assert.doesNotMatch(promCfg, /caddy:2019/);
  assert.match(promCfg, /keycloak:9000/);
  assert.match(promCfg, /credentials_file:/);
  assert.doesNotMatch(promCfg, /CHANGE_ME_|bearer_token:\s*["']?[A-Za-z0-9._-]{8,}/i);

  assert.equal(existsSync(join(ROOT, 'infra/config/prometheus/alerts.yml')), true, 'Missing infra/config/prometheus/alerts.yml');
  const alertsCfg = read('infra/config/prometheus/alerts.yml');
  assert.match(alertsCfg, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(alertsCfg, /@copyright\s*\(C\)\s*2026 CTU-OpenPaw/);
  for (const alertName of [
    'LatticeDxNocoBaseDown',
    'LatticeDxHigh5xxRate',
    'LatticeDxOutboxBacklogHigh',
    'LatticeDxCriticalColdAlarmsActive',
    'LatticeDxQuotaSpike',
  ]) {
    assert.match(alertsCfg, new RegExp(`alert:\\s*${alertName}\\b`), `alerts.yml missing alert ${alertName}`);
  }

  assert.equal(existsSync(join(ROOT, 'infra/config/grafana/provisioning/datasources/prometheus.yml')), true, 'Missing Grafana datasource provisioning');
  const grafanaDs = read('infra/config/grafana/provisioning/datasources/prometheus.yml');
  assert.match(grafanaDs, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(grafanaDs, /@copyright\s*\(C\)\s*2026 CTU-OpenPaw/);
  assert.match(grafanaDs, /name:\s*Prometheus/);
  assert.match(grafanaDs, /uid:\s*latticedx-prom/);
  assert.match(grafanaDs, /url:\s*http:\/\/prometheus:9090/);
  assert.match(grafanaDs, /isDefault:\s*true/);

  assert.equal(existsSync(join(ROOT, 'infra/config/grafana/provisioning/dashboards/dashboards.yml')), true, 'Missing Grafana dashboards provider provisioning');
  const grafanaDashProv = read('infra/config/grafana/provisioning/dashboards/dashboards.yml');
  assert.match(grafanaDashProv, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(grafanaDashProv, /@copyright\s*\(C\)\s*2026 CTU-OpenPaw/);
  assert.match(grafanaDashProv, /path:\s*\/var\/lib\/grafana\/dashboards/);

  assert.equal(existsSync(join(ROOT, 'infra/config/grafana/dashboards/latticedx-360.json')), true, 'Missing Grafana latticedx-360.json dashboard');
  const dashText = read('infra/config/grafana/dashboards/latticedx-360.json');
  const dash = JSON.parse(dashText);
  assert.equal(dash.uid, 'latticedx-360');
  assert.ok(Array.isArray(dash.panels) && dash.panels.length >= 6, 'latticedx-360.json must define >= 6 observability panels');
  const exprs = dash.panels.flatMap((p) => (p.targets || []).map((t) => String(t.expr || ''))).join('\n');
  assert.match(exprs, /latticedx_http_requests_total/);
  assert.match(exprs, /latticedx_http_request_duration_seconds_bucket/);
  assert.match(exprs, /latticedx_active_alarms_total/);
  assert.match(exprs, /latticedx_outbox_by_state/);
  assert.match(exprs, /latticedx_unread_notifications_total/);
  assert.match(exprs, /up\{job="nocobase"\}/);
  assert.match(dashText, /latticedx-prom/);
  assert.doesNotMatch(dashText, /CHANGE_ME_|local-gateway-secret/i);

  const panel5 = dash.panels.find((p) => p.id === 5);
  assert.ok(panel5, 'latticedx-360.json missing Panel 5 (Database & Engine Health)');
  const panel5Override = (panel5.fieldConfig?.overrides || []).find(
    (o) => o?.matcher?.id === 'byFrameRefID' && o?.matcher?.options === 'B',
  );
  assert.ok(panel5Override, 'Panel 5 missing byFrameRefID: "B" override for Uptime Seconds');
  const panel5Props = new Map((panel5Override.properties || []).map((prop) => [prop.id, prop.value]));
  assert.equal(panel5Props.get('unit'), 's');
  assert.deepEqual(panel5Props.get('mappings'), []);

  const pitrSh = read('infra/config/postgres/pitr-archive.sh');
  assert.ok(pitrSh.startsWith('#!/bin/sh\n'), 'pitr-archive.sh must start with POSIX #!/bin/sh and LF');
  assert.equal(pitrSh.includes('\r'), false, 'pitr-archive.sh must use LF line endings');
  assert.match(pitrSh, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(pitrSh, /mkdir -p/);
  assert.match(pitrSh, /gzip -c -- "\$wal_path"/);
  assert.match(pitrSh, /\$\{PITR_WAL_DIR:-\/var\/lib\/postgresql\/wal-archive\}/);
  assert.match(pitrSh, /wal-g/);
});

test('iiot.yml enforces internal iiot-net, Mosquitto Dynamic Security, Node-RED LWT, pinned digests, non-root caps, and localhost-only UI port', () => {
  const iiot = read('infra/compose/iiot.yml');
  assert.match(iiot, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(iiot, /iiot-net:\s*\r?\n\s*driver:\s*bridge\s*\r?\n\s*internal:\s*true/);
  assert.match(iiot, /no-new-privileges:true/);
  assert.match(iiot, /cap_drop:\s*\r?\n\s*-\s*ALL/);
  assert.match(iiot, /mem_limit:/);
  assert.doesNotMatch(iiot, /timescaledb/i);
  const imageLines = iiot.split(/\r?\n/).filter((l) => /^\s*image:/.test(l));
  assert.equal(imageLines.length, 2, `Expected exactly 2 pinned images (mosquitto + nodered) in iiot.yml, found ${imageLines.length}`);
  for (const line of imageLines) {
    assert.match(line, /@sha256:[a-f0-9]{64}/, `Unpinned image in iiot.yml: ${line}`);
  }
  const portMatches = [...iiot.matchAll(/^\s*-\s*["']?([^"'\r\n]+)["']?/gm)]
    .map((m) => m[1])
    .filter((v) => /:\d+/.test(v));
  assert.deepEqual(portMatches, ['127.0.0.1:1880:1880']);

  const dynsecSh = read('infra/config/mosquitto/init-dynsec.sh');
  assert.ok(dynsecSh.startsWith('#!/bin/sh\n'), 'init-dynsec.sh must start with POSIX #!/bin/sh and LF');
  assert.equal(dynsecSh.includes('\r'), false, 'init-dynsec.sh must use LF line endings');
  assert.match(dynsecSh, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(dynsecSh, /mosquitto_ctrl dynsec init/);
  assert.match(dynsecSh, /chown 1883:1883/);

  const mosqConf = read('infra/config/mosquitto/mosquitto.conf');
  assert.match(mosqConf, /allow_anonymous\s+false/);
  assert.match(mosqConf, /mosquitto_dynamic_security\.so/);
});

test('Caddyfile, APISIX prod config, Postgres least-privilege/PITR, and Keycloak prod realm meet zero-trust standards', () => {
  const caddy = read('infra/config/caddy/Caddyfile');
  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /X-Content-Type-Options\s+"?nosniff"?/);
  assert.match(caddy, /X-Frame-Options\s+"?SAMEORIGIN"?/);
  assert.match(caddy, /Permissions-Policy\s+"camera=\(self\),\s*microphone=\(\),\s*geolocation=\(self\)"/);
  assert.match(caddy, /handle\s+\/\.well-known\/agent-card\.json\s*\{\s*reverse_proxy\s+gateway:9080\s*\{\s*flush_interval\s+-1\s*\}\s*\}[\s\S]*handle\s+\{\s*reverse_proxy\s+nocobase:80/s);
  assert.match(caddy, /handle\s+\/api\/\*\s*\{\s*reverse_proxy\s+gateway:9080\s*\{\s*flush_interval\s+-1\s*\}/s);
  assert.doesNotMatch(caddy, /\/v1\/\*/);
  assert.match(caddy, /reverse_proxy\s+nocobase:80/);
  assert.match(caddy, /reverse_proxy\s+keycloak:8080/);
  assert.match(caddy, /\{\$N8N_DOMAIN\}/);
  assert.match(caddy, /reverse_proxy\s+n8n:5678/);
  assert.match(caddy, /http:\/\/:2020/);
  assert.match(caddy, /metrics/);
  assert.match(caddy, /respond 404/);

  const apisixProd = read('infra/config/apisix/apisix.prod.yaml');
  assert.doesNotMatch(apisixProd, /ssl_verify:\s*false/);
  assert.doesNotMatch(apisixProd, /local-gateway-secret/);
  assert.doesNotMatch(apisixProd, /"api:4000"/);
  assert.doesNotMatch(apisixProd, /\/v1\//);
  assert.match(apisixProd, /proxy-rewrite/);
  assert.match(apisixProd, /\/api\/dxos:health/);
  assert.match(apisixProd, /\/api\/enterpriseAuth\*/);
  assert.match(apisixProd, /\/api\/enterpriseAuth:start/);
  assert.match(apisixProd, /\/api\/enterpriseAuth:callback/);
  assert.match(apisixProd, /\/api\/enterpriseAuth:backchannelLogout/);
  assert.match(apisixProd, /\/api\/dxosLedger:verifySignature/);
  assert.match(apisixProd, /\/api\/dxos-mcp/);
  assert.match(apisixProd, /\/api\/dxos-mcp\/\*/);
  assert.match(apisixProd, /\/api\/dxosBlocks:telemetryIngest/);
  assert.match(apisixProd, /\/api\/dxosBlocks:alarmIngest/);
  assert.match(apisixProd, /\/api\/dxosBroker:deviceStatusIngest/);
  assert.match(apisixProd, /\/api\/dxosBroker:orionNotify/);
  assert.match(apisixProd, /\/api\/dxos:openapi/);
  assert.match(apisixProd, /\/api\/dxos:asyncapi/);
  assert.match(apisixProd, /\/api\/dxos:manifest/);
  assert.match(apisixProd, /\/api\/dxos:sw\.js/);
  assert.match(apisixProd, /\/api\/dxosWms:publicTrack/);
  assert.match(apisixProd, /\/\.well-known\/agent-card\.json/);
  assert.match(apisixProd, /\/api\/dxos-a2a\/agent-card\.json/);
  assert.match(apisixProd, /\/api\/dxosForms:meta/);
  assert.match(apisixProd, /\/api\/dxosForms:submit/);
  assert.match(apisixProd, /\/api\/dxosForms:status/);
  assert.match(apisixProd, /id:\s*dxos-public-paas[\s\S]*?\/\.well-known\/agent-card\.json[\s\S]*?\/api\/dxos-a2a\/agent-card\.json[\s\S]*?\/api\/dxosForms:meta[\s\S]*?\/api\/dxosForms:submit[\s\S]*?\/api\/dxosForms:status[\s\S]*?"nocobase:80"/);
  assert.match(apisixProd, /uri:\s*\/api\/\*/);
  assert.match(apisixProd, /"nocobase:80"/);
  assert.match(apisixProd, /ssl_verify:\s*true/);
  assert.match(apisixProd, /policy:\s*redis/);
  assert.match(apisixProd, /APISIX_OIDC_CLIENT_SECRET/);
  assert.match(apisixProd, /allow_headers:[^\r\n]*X-Lattice-Edge-Token/);
  assert.match(apisixProd, /id:\s*dxos-enterprise-auth[\s\S]*?\/api\/enterpriseAuth\*/);
  assert.match(apisixProd, /id:\s*dxos-oidc-bridge[\s\S]*?use_jwks:\s*true/);
  assert.match(apisixProd, /id:\s*dxos-mcp[\s\S]*?timeout:\s*\r?\n\s*connect:\s*6\s*\r?\n\s*send:\s*600\s*\r?\n\s*read:\s*600/);
  assert.match(apisixProd, /id:\s*dxos-core-api[\s\S]*?timeout:\s*\r?\n\s*connect:\s*6\s*\r?\n\s*send:\s*600\s*\r?\n\s*read:\s*600/);

  const apisixCfg = read('infra/config/apisix/config.prod.yaml');
  assert.match(apisixCfg, /response-rewrite/);
  assert.match(apisixCfg, /proxy-rewrite/);
  assert.match(apisixCfg, /cors/);
  assert.match(apisixCfg, /nginx_config:\s*\r?\n\s+http:/);
  assert.match(apisixCfg, /real_ip_header:\s*"?X-Forwarded-For"?/);
  assert.match(apisixCfg, /real_ip_recursive:\s*"?on"?/);
  assert.match(apisixCfg, /real_ip_from:/);
  for (const cidr of ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
    assert.ok(apisixCfg.includes(cidr), `config.prod.yaml real_ip_from missing ${cidr}`);
  }

  const initProd = read('infra/config/postgres/init-prod.sh');
  assert.match(initProd, /ON_ERROR_STOP=1/);
  assert.match(initProd, /NOSUPERUSER\s+NOCREATEDB\s+NOCREATEROLE\s+NOINHERIT\s+NOBYPASSRLS/);
  assert.match(initProd, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);

  const initNocobaseDb = read('infra/config/postgres/init-nocobase-db.sh');
  assert.equal(initNocobaseDb.includes('\r'), false, 'init-nocobase-db.sh must use LF line endings');
  assert.match(initNocobaseDb, /@copyright\s*\(C\)\s*2026 CTU-OpenPaw/);
  assert.match(initNocobaseDb, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(initNocobaseDb, /ON_ERROR_STOP=1/);
  assert.match(initNocobaseDb, /NOSUPERUSER\s+NOCREATEDB\s+NOCREATEROLE\s+NOINHERIT\s+NOBYPASSRLS/);
  assert.match(initNocobaseDb, /ALTER DATABASE/);
  assert.match(initNocobaseDb, /ALTER SCHEMA public OWNER TO/);
  assert.match(initNocobaseDb, /APP_PASSWORD="\$\{NOCOBASE_APP_DB_PASSWORD:\?Set NOCOBASE_APP_DB_PASSWORD\}"/);
  assert.doesNotMatch(initNocobaseDb, /NOCOBASE_APP_DB_PASSWORD:-\$\{NOCOBASE_DB_PASSWORD/);

  const prodText = read('infra/compose/prod.yml');
  const nocobaseDbSec = serviceSection(prodText, 'nocobase-db');
  assert.match(nocobaseDbSec, /002-init-nocobase-db\.sh:ro/);
  assert.match(nocobaseDbSec, /NOCOBASE_APP_DB_USER:\s*\$\{NOCOBASE_APP_DB_USER:-nocobase_app\}/);
  assert.match(nocobaseDbSec, /NOCOBASE_APP_DB_PASSWORD:\s*\$\{NOCOBASE_APP_DB_PASSWORD:\?Set NOCOBASE_APP_DB_PASSWORD\}/);
  assert.doesNotMatch(nocobaseDbSec, /NOCOBASE_APP_DB_PASSWORD:-\$\{NOCOBASE_DB_PASSWORD/);
  const nocobaseSec = serviceSection(prodText, 'nocobase');
  assert.match(nocobaseSec, /DB_USER:\s*\$\{NOCOBASE_APP_DB_USER:-nocobase_app\}/);
  assert.match(nocobaseSec, /DB_PASSWORD:\s*\$\{NOCOBASE_APP_DB_PASSWORD:\?Set NOCOBASE_APP_DB_PASSWORD\}/);
  assert.doesNotMatch(nocobaseSec, /DB_PASSWORD:\s*\$\{NOCOBASE_APP_DB_PASSWORD:-\$\{NOCOBASE_DB_PASSWORD/);
  const prodEnvEx = read('infra/compose/prod.env.example');
  assert.match(prodEnvEx, /NOCOBASE_APP_DB_USER=nocobase_app/);
  assert.match(prodEnvEx, /NOCOBASE_APP_DB_PASSWORD=CHANGE_ME_/);

  const pitr = read('infra/config/postgres/pitr.conf');
  assert.equal(pitr.includes('\r'), false, 'pitr.conf must use LF line endings');
  assert.match(pitr, /wal_level\s*=\s*replica/);
  assert.match(pitr, /archive_mode\s*=\s*on/);
  assert.match(pitr, /archive_command\s*=\s*'\/bin\/sh \/etc\/postgresql\/pitr-archive\.sh %p %f'/);
  assert.doesNotMatch(pitr, /archive_command\s*=\s*'\/bin\/true'/);

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
  assert.match(nocobase, /valkey\/valkey:8\.1-alpine@sha256:9971099af41c36e887aabdfe22b80c0fe45df949163dfc9cb434febc57cfc3fc/);
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
