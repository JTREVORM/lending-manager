#!/usr/bin/env bash
# ===========================================================================
# Financial reconciliation certification against a COHERENT book.
#
# Phase 4, Task 0. `scripts/certify-financial-reconciliation.mjs` walks 38
# cross-subsystem identities, but its verdict is only as good as the book it is
# pointed at. Phase 3 measured two different books and got two different
# answers:
#
#   * the membership-only demonstration book (`scripts/seed-demo.ts`) has no
#     loans at all, so eleven loan identities had no subject rows and proved
#     nothing. The harness calls those VACUOUS and refuses to count them as
#     coverage — but without `--require-complete` it still exits 0, which is
#     how a vacuous run could be mistaken for a certification.
#
#   * the end-to-end book (`tests/e2e/harness/seed.mjs`) carries loans,
#     payments, savings, memberships and reversals, and reconciles fully.
#
# This script builds the second one and certifies it with the gate on, so the
# certification can only pass on a book that actually exercises every identity.
#
# It needs a cluster already running — `npm run db:local:setup` — and uses its
# own database so nothing else in the job is disturbed.
# ===========================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PGLOCAL_PORT:-5433}"
DB_USER="${PGLOCAL_USER:-lending}"
CERT_DB="${CERT_DB:-lending_cert}"
JSON_OUT="${JSON_OUT:-${PROJECT_ROOT}/work/financial-reconciliation.json}"

# Harness-only, local-only, and never a real credential: this role exists so
# the seeder can write a password hash into the shim's `auth.users`, exactly as
# `stack.sh` does for PostgREST.
HARNESS_ROLE_PASSWORD="financial-certification-only"

PG_BIN="${PGLOCAL_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)}"
if [[ -z "${PG_BIN}" ]]; then
  echo "error: no PostgreSQL server binaries found under /usr/lib/postgresql/*/bin" >&2
  exit 1
fi

# PostgreSQL refuses to run as root, and `pg-local.sh` delegates to an
# unprivileged user in that case. Mirror it so this works both in CI (not root)
# and in a container shell (root).
RUN_AS=""
if [[ "$(id -u)" -eq 0 ]]; then
  RUN_AS="${PGLOCAL_RUNAS:-postgres}"
  getent passwd "${RUN_AS}" >/dev/null || { echo "error: user '${RUN_AS}' does not exist" >&2; exit 1; }
fi

as_pg() {
  if [[ -n "${RUN_AS}" ]]; then su "${RUN_AS}" -s /bin/bash -c "$1"; else bash -c "$1"; fi
}

psql_db() {
  as_pg "${PG_BIN}/psql -h 127.0.0.1 -p ${PORT} -U '${DB_USER}' -d '$1' -X -v ON_ERROR_STOP=1 -q ${2:-}"
}

echo "==> rebuilding '${CERT_DB}'"
psql_db postgres "-c \"drop database if exists ${CERT_DB} with (force)\""
psql_db postgres "-c \"create database ${CERT_DB}\""

echo "==> applying the test shim"
psql_db "${CERT_DB}" "-f '${PROJECT_ROOT}/tests/helpers/supabase-shim.sql'"

echo "==> applying every migration in timestamp order"
count=0
for migration in "${PROJECT_ROOT}"/supabase/migrations/*.sql; do
  psql_db "${CERT_DB}" "-f '${migration}'"
  count=$((count + 1))
done
echo "    ${count} migrations applied"

# The seeder writes a password hash, which the shim's `auth.users` has no column
# for until the harness bridge adds it.
echo "==> applying the end-to-end harness bridge"
psql_db "${CERT_DB}" "-v password=\"'${HARNESS_ROLE_PASSWORD}'\" -f '${PROJECT_ROOT}/tests/e2e/harness/harness.sql'"

echo "==> seeding the end-to-end book"
E2E_DATABASE_URL="postgresql://${DB_USER}@127.0.0.1:${PORT}/${CERT_DB}" \
  node "${PROJECT_ROOT}/tests/e2e/harness/seed.mjs" >"${PROJECT_ROOT}/work/financial-certification-seed.log" 2>&1 || {
    echo "error: the seed failed; last 30 lines:" >&2
    tail -30 "${PROJECT_ROOT}/work/financial-certification-seed.log" >&2
    exit 1
  }
grep -E '^(loans receivable|trial balance|ledger):' "${PROJECT_ROOT}/work/financial-certification-seed.log" || true

echo "==> certifying the book (vacuous identities refused)"
DATABASE_URL="postgresql://${DB_USER}@127.0.0.1:${PORT}/${CERT_DB}" \
  node "${PROJECT_ROOT}/scripts/certify-financial-reconciliation.mjs" \
    --require-complete --json "${JSON_OUT}"
