#!/usr/bin/env sh
# @file LatticeDX — Open Digital Enterprise Platform
# @author CTU-OpenPaw
# @copyright (C) 2026 CTU-OpenPaw
# @license Apache-2.0
# @see https://github.com/CTU-OpenPaw/lattice-dx
# SPDX-License-Identifier: Apache-2.0
set -eu

APP_USER="${NOCOBASE_APP_DB_USER:-nocobase_app}"
APP_PASSWORD="${NOCOBASE_APP_DB_PASSWORD:-${NOCOBASE_DB_PASSWORD:?Set NOCOBASE_DB_PASSWORD}}"
TARGET_DB="${POSTGRES_DB:-nocobase}"

case "$APP_USER" in
  ''|*[!a-zA-Z0-9_]*|[0-9]*)
    echo "Invalid NOCOBASE_APP_DB_USER: $APP_USER" >&2
    exit 1
    ;;
esac
case "$TARGET_DB" in
  ''|*[!a-zA-Z0-9_]*|[0-9]*)
    echo "Invalid POSTGRES_DB: $TARGET_DB" >&2
    exit 1
    ;;
esac
if [ "$APP_USER" = "$POSTGRES_USER" ]; then
  echo "NOCOBASE_APP_DB_USER must differ from POSTGRES_USER ($POSTGRES_USER) so FORCE ROW LEVEL SECURITY is enforced" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "postgres" \
  -v app_user="$APP_USER" \
  -v app_pw="$APP_PASSWORD" \
  -v target_db="$TARGET_DB" <<'EOSQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'app_user',
  :'app_pw'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'app_user',
  :'app_pw'
)\gexec

ALTER DATABASE :"target_db" OWNER TO :"app_user";
REVOKE ALL ON DATABASE :"target_db" FROM PUBLIC;
GRANT ALL PRIVILEGES ON DATABASE :"target_db" TO :"app_user";
EOSQL

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$TARGET_DB" \
  -v app_user="$APP_USER" <<'EOSQL'
ALTER SCHEMA public OWNER TO :"app_user";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO :"app_user";
EOSQL
