#!/usr/bin/env bash
# ===========================================================================
# Throwaway local PostgreSQL cluster for migration verification.
#
# Supabase's own local stack (`supabase start`) needs Docker. Where Docker is
# unavailable — CI containers, this project's development sandbox — this script
# gives the same thing that actually matters: a clean PostgreSQL database with
# every migration applied in order, so the schema can be inspected and the
# database integration tests can run.
#
# It is a developer tool. It never touches a hosted Supabase project.
#
#   ./scripts/pg-local.sh setup      initdb, start, create database, migrate
#   ./scripts/pg-local.sh migrate    re-create the database and re-apply
#   ./scripts/pg-local.sh psql       open a shell on it
#   ./scripts/pg-local.sh url        print the DATABASE_URL to use
#   ./scripts/pg-local.sh teardown   stop and delete the cluster
# ===========================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_DIR="${PROJECT_ROOT}/.pglocal"
DATA_DIR="${CLUSTER_DIR}/data"
SOCKET_DIR="${CLUSTER_DIR}/socket"
LOG_FILE="${CLUSTER_DIR}/postgres.log"
PORT="${PGLOCAL_PORT:-5433}"
DB_NAME="${PGLOCAL_DB:-lending_test}"
DB_USER="${PGLOCAL_USER:-lending}"

PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [[ -z "${PG_BIN}" ]]; then
  echo "error: no PostgreSQL server binaries found under /usr/lib/postgresql/*/bin" >&2
  echo "       install postgresql, or use 'supabase start' if Docker is available" >&2
  exit 1
fi

# PostgreSQL refuses to run as root. When this script is invoked as root, every
# cluster operation is delegated to an unprivileged user.
RUN_AS=""
if [[ "$(id -u)" -eq 0 ]]; then
  RUN_AS="${PGLOCAL_RUNAS:-postgres}"
  if ! getent passwd "${RUN_AS}" >/dev/null; then
    echo "error: running as root and user '${RUN_AS}' does not exist" >&2
    echo "       set PGLOCAL_RUNAS to an existing unprivileged user" >&2
    exit 1
  fi
fi

as_pg() {
  if [[ -n "${RUN_AS}" ]]; then
    su "${RUN_AS}" -s /bin/bash -c "$1"
  else
    bash -c "$1"
  fi
}

database_url() {
  echo "postgresql://${DB_USER}@localhost:${PORT}/${DB_NAME}"
}

is_running() {
  as_pg "${PG_BIN}/pg_ctl -D '${DATA_DIR}' status" >/dev/null 2>&1
}

cmd_init() {
  if [[ -f "${DATA_DIR}/PG_VERSION" ]]; then
    echo "cluster already initialised at ${DATA_DIR}"
    return
  fi

  mkdir -p "${DATA_DIR}" "${SOCKET_DIR}"
  if [[ -n "${RUN_AS}" ]]; then
    chown -R "${RUN_AS}" "${CLUSTER_DIR}"
  fi

  echo "initialising cluster..."
  # Trust auth on the local socket and loopback only; the cluster listens on
  # 127.0.0.1 and is deleted by `teardown`. No password is set because none is
  # needed and a hard-coded one would be worse.
  as_pg "${PG_BIN}/initdb -D '${DATA_DIR}' -U '${DB_USER}' --auth-local=trust --auth-host=trust --encoding=UTF8 --locale=C" >/dev/null
}

cmd_start() {
  if is_running; then
    echo "cluster already running on port ${PORT}"
    return
  fi

  mkdir -p "${SOCKET_DIR}"
  if [[ -n "${RUN_AS}" ]]; then
    chown -R "${RUN_AS}" "${CLUSTER_DIR}"
  fi

  echo "starting cluster on port ${PORT}..."
  as_pg "${PG_BIN}/pg_ctl -D '${DATA_DIR}' -l '${LOG_FILE}' -o \"-p ${PORT} -k '${SOCKET_DIR}' -c listen_addresses=127.0.0.1\" -w start" >/dev/null

  for _ in $(seq 1 30); do
    if as_pg "${PG_BIN}/pg_isready -h 127.0.0.1 -p ${PORT} -U '${DB_USER}'" >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done

  echo "error: cluster did not become ready; see ${LOG_FILE}" >&2
  exit 1
}

cmd_migrate() {
  echo "re-creating database '${DB_NAME}'..."
  as_pg "${PG_BIN}/psql -h 127.0.0.1 -p ${PORT} -U '${DB_USER}' -d postgres -v ON_ERROR_STOP=1 -q -c \"drop database if exists ${DB_NAME} with (force)\"" >/dev/null
  as_pg "${PG_BIN}/psql -h 127.0.0.1 -p ${PORT} -U '${DB_USER}' -d postgres -v ON_ERROR_STOP=1 -q -c \"create database ${DB_NAME}\"" >/dev/null

  echo "applying Supabase shim (test harness only)..."
  as_pg "${PG_BIN}/psql -h 127.0.0.1 -p ${PORT} -U '${DB_USER}' -d '${DB_NAME}' -v ON_ERROR_STOP=1 -q -f '${PROJECT_ROOT}/tests/helpers/supabase-shim.sql'"

  # Applied in filename order, which is why migrations are timestamp-prefixed.
  for migration in "${PROJECT_ROOT}"/supabase/migrations/*.sql; do
    echo "applying $(basename "${migration}")..."
    as_pg "${PG_BIN}/psql -h 127.0.0.1 -p ${PORT} -U '${DB_USER}' -d '${DB_NAME}' -v ON_ERROR_STOP=1 -q -f '${migration}'"
  done

  echo
  echo "migrations applied to a clean database."
  echo "DATABASE_URL=$(database_url)"
}

cmd_psql() {
  as_pg "${PG_BIN}/psql -h 127.0.0.1 -p ${PORT} -U '${DB_USER}' -d '${DB_NAME}'"
}

cmd_teardown() {
  if is_running; then
    echo "stopping cluster..."
    as_pg "${PG_BIN}/pg_ctl -D '${DATA_DIR}' -m immediate -w stop" >/dev/null || true
  fi
  rm -rf "${CLUSTER_DIR}"
  echo "cluster removed."
}

case "${1:-setup}" in
  setup)    cmd_init; cmd_start; cmd_migrate ;;
  init)     cmd_init ;;
  start)    cmd_start ;;
  migrate)  cmd_start; cmd_migrate ;;
  psql)     cmd_psql ;;
  url)      database_url ;;
  teardown) cmd_teardown ;;
  *)
    echo "usage: $0 {setup|init|start|migrate|psql|url|teardown}" >&2
    exit 1
    ;;
esac
