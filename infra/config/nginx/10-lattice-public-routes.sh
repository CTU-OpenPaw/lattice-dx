#!/bin/sh
# @file LatticeDX — Open Digital Enterprise Platform
# @author CTU-OpenPaw
# @copyright (C) 2026 CTU-OpenPaw
# @license Apache-2.0
# @see https://github.com/CTU-OpenPaw/lattice-dx
# SPDX-License-Identifier: Apache-2.0
set -eu

CONF="/app/nocobase/storage/nocobase.conf"
[ -f "$CONF" ] || exit 0

UPSTREAM_PORT="${NOCOBASE_PROXY_UPSTREAM_PORT:-${APP_PORT:-13000}}"

node -e '
const fs = require("fs");
const confPath = process.argv[1];
const rawPort = String(process.argv[2] || "13000").trim();
const upstreamPort = /^\d+$/.test(rawPort) ? rawPort : "13000";
const upstream = "http://127.0.0.1:" + upstreamPort;

let raw = fs.readFileSync(confPath, "utf8");

raw = raw.replace(/\n?[ \t]*# BEGIN LATTICEDX PUBLIC ROUTES[\s\S]*?# END LATTICEDX PUBLIC ROUTES[ \t]*\n*/g, "\n");
raw = raw.replace(/\n?[ \t]*location = \/\.well-known\/agent-card\.json \{[\s\S]*?\n[ \t]*\}[ \t]*\n*/g, "\n");

const buildProxyDirectives = (cacheControlValue) => [
  "        proxy_pass " + upstream + ";",
  "        proxy_http_version 1.1;",
  "        proxy_set_header Upgrade $http_upgrade;",
  "        proxy_set_header Connection '\''upgrade'\'';",
  "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
  "        proxy_set_header X-Forwarded-Proto $upstream_x_forwarded_proto;",
  "        proxy_set_header Host $final_host;",
  "        proxy_set_header Referer $http_referer;",
  "        proxy_set_header User-Agent $http_user_agent;",
  "        add_header Cache-Control '\''" + cacheControlValue + "'\'';",
  "        proxy_cache_bypass $http_upgrade;",
  "        proxy_connect_timeout 600;",
  "        proxy_send_timeout 600;",
  "        proxy_read_timeout 600;",
  "        send_timeout 600;",
];

const makeProxyLocation = (matcher, cacheControlValue = "no-cache, no-store") => [
  "    " + matcher + " {",
  ...buildProxyDirectives(cacheControlValue),
  "    }",
  "",
].join("\n");

const block = [
  "    # BEGIN LATTICEDX PUBLIC ROUTES",
  makeProxyLocation("location = /.well-known/agent-card.json"),
  makeProxyLocation("location ^~ /v/form"),
  makeProxyLocation("location ^~ /v/track"),
  makeProxyLocation("location ^~ /v/mobile", "no-cache"),
  makeProxyLocation("location ^~ /track"),
  "    location ^~ /form {",
  "        absolute_redirect off;",
  "        return 302 /v$request_uri;",
  "    }",
  "    # END LATTICEDX PUBLIC ROUTES",
  "",
].join("\n");

const anchor = "    location / {";
const idx = raw.indexOf(anchor);
if (idx === -1) {
  console.error("Anchor location / { not found in " + confPath);
  process.exit(1);
}
const updated = raw.slice(0, idx) + block + "\n" + raw.slice(idx);
fs.writeFileSync(confPath, updated, "utf8");
' "$CONF" "$UPSTREAM_PORT"

nginx -t
nginx -s reload || true
