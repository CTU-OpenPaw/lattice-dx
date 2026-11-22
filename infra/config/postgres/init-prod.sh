#!/usr/bin/env sh
# @file LatticeDX — Open Digital Enterprise Platform
# @author CTU-OpenPaw
# @copyright (C) 2026 CTU-OpenPaw
# @license Apache-2.0
# @see https://github.com/CTU-OpenPaw/lattice-dx
# SPDX-License-Identifier: Apache-2.0
set -eu

: "${LATTICE_DB_PASSWORD:?Set LATTICE_DB_PASSWORD}"
: "${KEYCLOAK_DB_PASSWORD:?Set KEYCLOAK_DB_PASSWORD}"
: "${N8N_DB_PASSWORD:?Set N8N_DB_PASSWORD}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "postgres" \
  -v lattice_pw="$LATTICE_DB_PASSWORD" \
  -v keycloak_pw="$KEYCLOAK_DB_PASSWORD" \
  -v n8n_pw="$N8N_DB_PASSWORD" <<'EOSQL'
CREATE ROLE lattice_app LOGIN PASSWORD :'lattice_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE keycloak_app LOGIN PASSWORD :'keycloak_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE n8n_app LOGIN PASSWORD :'n8n_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

CREATE DATABASE lattice OWNER lattice_app;
CREATE DATABASE keycloak OWNER keycloak_app;
CREATE DATABASE n8n OWNER n8n_app;

REVOKE ALL ON DATABASE lattice, keycloak, n8n FROM PUBLIC;
EOSQL

for db in lattice keycloak n8n; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'EOSQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL
done
