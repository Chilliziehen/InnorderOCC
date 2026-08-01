#!/bin/bash
set -Eeuo pipefail

clear_passwords() {
  unset admin_password flyway_password runtime_password ai_runtime_password
  unset FLYWAY_PASSWORD RUNTIME_PASSWORD AI_RUNTIME_PASSWORD
}
trap clear_passwords EXIT

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
ai_password_file="${AI_DATABASE_PASSWORD_FILE:-/run/secrets/postgres_ai_runtime_password}"
ai_runtime_login=false
ai_runtime_password=''
if [[ -r "$ai_password_file" ]]; then
  ai_runtime_password="$(read_secret "$ai_password_file")"
  ai_runtime_login=true
fi

if [[ "$admin_password" == "$flyway_password" ||
      "$admin_password" == "$runtime_password" ||
      "$flyway_password" == "$runtime_password" ||
      ( "$ai_runtime_login" == true && ( "$admin_password" == "$ai_runtime_password" ||
        "$flyway_password" == "$ai_runtime_password" ||
        "$runtime_password" == "$ai_runtime_password" ) ) ]]; then
  echo "PostgreSQL admin, Flyway, Core runtime, and AI runtime passwords must be distinct" >&2
  exit 1
fi

export FLYWAY_PASSWORD="$flyway_password"
export RUNTIME_PASSWORD="$runtime_password"
export AI_RUNTIME_PASSWORD="$ai_runtime_password"
export AI_RUNTIME_LOGIN="$ai_runtime_login"
unset admin_password flyway_password runtime_password ai_runtime_password

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" \
  <<'SQL'
\set ON_ERROR_STOP on
\getenv flyway_password FLYWAY_PASSWORD
\getenv runtime_password RUNTIME_PASSWORD
\getenv ai_runtime_password AI_RUNTIME_PASSWORD
\getenv ai_runtime_login AI_RUNTIME_LOGIN

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

ALTER ROLE innorder_runtime SET search_path TO flowable, pg_catalog;

SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'innorder_ai_runtime'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'innorder_ai_runtime')
\gexec

\if :ai_runtime_login
  SELECT format(
    'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
    'innorder_ai_runtime',
    :'ai_runtime_password'
  )
  \gexec
\else
  SELECT format(
    'ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
    'innorder_ai_runtime'
  )
  \gexec
\endif

ALTER ROLE innorder_ai_runtime SET search_path TO pg_catalog;

REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE :"database_name" TO innorder_flyway;
GRANT CONNECT ON DATABASE :"database_name" TO innorder_runtime;
GRANT CONNECT ON DATABASE :"database_name" TO innorder_ai_runtime;
GRANT innorder_runtime TO innorder_flyway;
GRANT innorder_ai_runtime TO innorder_flyway;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO innorder_flyway;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;
SQL
