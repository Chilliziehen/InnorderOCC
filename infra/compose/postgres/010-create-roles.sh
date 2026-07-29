#!/bin/bash
set -Eeuo pipefail

read_secret() {
  local path="$1"
  if [[ ! -r "$path" ]]; then
    echo "Required secret file is not readable: $path" >&2
    return 1
  fi

  local value
  value="$(<"$path")"
  if [[ -z "$value" ]]; then
    echo "Required secret file is empty: $path" >&2
    return 1
  fi
  printf '%s' "$value"
}

admin_password="$(read_secret /run/secrets/postgres_admin_password)"
flyway_password="$(read_secret /run/secrets/postgres_flyway_password)"
runtime_password="$(read_secret /run/secrets/postgres_runtime_password)"

if [[ "$admin_password" == "$flyway_password" ||
      "$admin_password" == "$runtime_password" ||
      "$flyway_password" == "$runtime_password" ]]; then
  echo "PostgreSQL admin, Flyway, and runtime passwords must be distinct" >&2
  exit 1
fi

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" \
  --set=flyway_password="$flyway_password" \
  --set=runtime_password="$runtime_password" <<'SQL'
\set ON_ERROR_STOP on

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'innorder_flyway'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'innorder_flyway')
\gexec

SELECT format(
  'ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'innorder_flyway',
  :'flyway_password'
)
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'innorder_runtime'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'innorder_runtime')
\gexec

SELECT format(
  'ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'innorder_runtime',
  :'runtime_password'
)
\gexec

REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE :"database_name" TO innorder_flyway;
GRANT CONNECT ON DATABASE :"database_name" TO innorder_runtime;
GRANT innorder_runtime TO innorder_flyway;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO innorder_flyway;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;
SQL
