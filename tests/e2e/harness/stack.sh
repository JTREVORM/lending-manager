#!/usr/bin/env bash
# ===========================================================================
# The end-to-end stack.
#
# ## Why this exists rather than `supabase start`
#
# Supabase's local stack needs Docker, which this project's development and CI
# sandboxes do not have. Without a way to *run* the application, Phases 1–8
# shipped 2,584 tests and three defects that every one of them missed: every
# authenticated page rendered an error boundary, `/users` returned a 500, and
# no payment could be recorded at all. Each was found in the first ten minutes
# of actually opening the application in a browser.
#
# So this assembles the same thing out of real parts:
#
#   PostgreSQL   real, with every migration applied from zero
#   PostgREST    the real binary — the same server Supabase runs
#   auth shim    the one substitution: a minimal GoTrue-compatible service
#   Next.js      the production build, not the dev server
#
# Only the auth service is replaced, and only because GoTrue is distributed as
# a container. Everything the application's own code touches — Row Level
# Security, the SECURITY DEFINER functions, PostgREST's embedding rules, the
# JWT claims — is the real thing. That matters: the `/users` defect was a
# PostgREST relationship ambiguity, which no amount of talking to PostgreSQL
# directly would have found.
#
# ## Usage
#
#   tests/e2e/harness/stack.sh up     start everything and seed
#   tests/e2e/harness/stack.sh down   stop everything
#   tests/e2e/harness/stack.sh env    print the environment for a client
# ===========================================================================
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${HARNESS_DIR}/../../.." && pwd)"
RUN_DIR="${E2E_RUN_DIR:-${PROJECT_ROOT}/.e2e}"

PG_PORT="${E2E_PG_PORT:-5433}"
PG_USER="${E2E_PG_USER:-lending}"
PG_DB="${E2E_PG_DB:-lending_e2e}"
POSTGREST_PORT="${E2E_POSTGREST_PORT:-3001}"
SHIM_PORT="${E2E_SHIM_PORT:-8443}"
APP_PORT="${E2E_APP_PORT:-3000}"

# The harness's own credentials. Synthetic, local-only, and never a secret:
# the database listens on loopback, the shim signs with a key generated into
# .e2e, and nothing here reaches a hosted project. They are named rather than
# random so a failed run can be inspected afterwards.
PG_PASSWORD="e2e-harness-only"
POSTGREST_ROLE_PASSWORD="e2e-harness-only"

# The API keys the application presents to the shim. One definition, exported
# to both sides: the shim reads them from the environment and `print_env`
# hands the same values to Next.js. They were once written out twice, and the
# two copies disagreed — see the note in shim.mjs.
PUBLISHABLE_KEY="sb_publishable_harness_only_key"
SECRET_KEY="sb_secret_harness_only_key"

mkdir -p "${RUN_DIR}"

log() { printf '  %s\n' "$*"; }

# Kill the processes matching a pattern whose working directory is this
# checkout. Scoped deliberately: a bare `pkill -f next-server` on a shared
# machine would take down somebody else's work.
kill_ours() {
  local pattern="$1" pid cwd
  for pid in $(pgrep -f "${pattern}" 2>/dev/null || true); do
    cwd="$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)"
    if [[ "${cwd}" == "${PROJECT_ROOT}" ]]; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
}

# ---------------------------------------------------------------------------
# PostgREST
# ---------------------------------------------------------------------------
postgrest_binary() {
  if [[ -n "${E2E_POSTGREST:-}" ]]; then
    echo "${E2E_POSTGREST}"
  elif command -v postgrest >/dev/null 2>&1; then
    command -v postgrest
  elif [[ -x "${RUN_DIR}/postgrest" ]]; then
    echo "${RUN_DIR}/postgrest"
  else
    echo ""
  fi
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------
start() {
  local pgrst
  pgrst="$(postgrest_binary)"

  # Refuse to start over a stack that is already up: a stale server would
  # answer the readiness probe below and the new build would never be tested.
  if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${APP_PORT}/login"; then
    echo "error: something is already serving port ${APP_PORT}." >&2
    echo "       Run '$0 down' first." >&2
    exit 1
  fi

  if [[ -z "${pgrst}" ]]; then
    echo "error: no postgrest binary found." >&2
    echo "       Set E2E_POSTGREST, put one on PATH, or drop one in ${RUN_DIR}." >&2
    exit 1
  fi

  log "database"
  PGLOCAL_PORT="${PG_PORT}" PGLOCAL_DB="${PG_DB}" "${PROJECT_ROOT}/scripts/pg-local.sh" setup >/dev/null 2>&1 ||
    PGLOCAL_PORT="${PG_PORT}" PGLOCAL_DB="${PG_DB}" "${PROJECT_ROOT}/scripts/pg-local.sh" migrate >/dev/null

  log "auth shim schema"
  psql "postgresql://${PG_USER}@127.0.0.1:${PG_PORT}/${PG_DB}" \
    -v ON_ERROR_STOP=1 -q -f "${HARNESS_DIR}/harness.sql" \
    -v password="'${POSTGREST_ROLE_PASSWORD}'" >/dev/null

  log "tls certificate"
  if [[ ! -f "${RUN_DIR}/cert.pem" ]]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout "${RUN_DIR}/key.pem" -out "${RUN_DIR}/cert.pem" \
      -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
      >/dev/null 2>&1
  fi

  log "postgrest"
  sed -e "s|@DB_URI@|postgres://authenticator:${POSTGREST_ROLE_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}|" \
      -e "s|@PORT@|${POSTGREST_PORT}|" \
      "${HARNESS_DIR}/postgrest.conf" > "${RUN_DIR}/postgrest.conf"
  nohup "${pgrst}" "${RUN_DIR}/postgrest.conf" > "${RUN_DIR}/postgrest.log" 2>&1 &
  echo $! > "${RUN_DIR}/postgrest.pid"

  # PostgREST builds its schema cache once at boot and reloads it on a
  # `pgrst` NOTIFY — which is how a hosted project picks up a migration. A
  # stale cache answers PGRST202 ("could not find the function") for a
  # function that plainly exists, so the notify is sent explicitly rather
  # than relied upon.
  for _ in $(seq 1 30); do
    if curl -sf -o /dev/null "http://127.0.0.1:${POSTGREST_PORT}/"; then break; fi
    sleep 1
  done
  psql "postgresql://${PG_USER}@127.0.0.1:${PG_PORT}/${PG_DB}" \
    -q -c "notify pgrst, 'reload schema';" >/dev/null

  log "auth shim"
  E2E_RUN_DIR="${RUN_DIR}" \
  E2E_PG_PORT="${PG_PORT}" E2E_PG_DB="${PG_DB}" E2E_PG_USER="${PG_USER}" \
  E2E_POSTGREST_PORT="${POSTGREST_PORT}" E2E_SHIM_PORT="${SHIM_PORT}" \
  E2E_PUBLISHABLE_KEY="${PUBLISHABLE_KEY}" E2E_SECRET_KEY="${SECRET_KEY}" \
    nohup node "${HARNESS_DIR}/shim.mjs" > "${RUN_DIR}/shim.log" 2>&1 &
  echo $! > "${RUN_DIR}/shim.pid"

  for _ in $(seq 1 30); do
    if curl -skf -o /dev/null "https://127.0.0.1:${SHIM_PORT}/auth/v1/health"; then break; fi
    sleep 1
  done

  log "seed"
  E2E_DATABASE_URL="postgresql://${PG_USER}@127.0.0.1:${PG_PORT}/${PG_DB}" \
    node "${HARNESS_DIR}/seed.mjs" > "${RUN_DIR}/seed.log" 2>&1 ||
    { tail -20 "${RUN_DIR}/seed.log" >&2; exit 1; }

  log "application"
  # The production build, not the dev server: the dev overlay injects scripts
  # the Content-Security-Policy is not written for, and the thing under test
  # is what ships.
  # shellcheck disable=SC1090
  source <(print_env)
  (cd "${PROJECT_ROOT}" && npx next build > "${RUN_DIR}/build.log" 2>&1) ||
    { tail -20 "${RUN_DIR}/build.log" >&2; exit 1; }

  (cd "${PROJECT_ROOT}" && nohup npx next start -p "${APP_PORT}" > "${RUN_DIR}/next.log" 2>&1 &
   echo $! > "${RUN_DIR}/next.pid")

  for _ in $(seq 1 30); do
    if curl -sf -o /dev/null "http://127.0.0.1:${APP_PORT}/login"; then
      log "ready on http://127.0.0.1:${APP_PORT}"
      return 0
    fi
    sleep 1
  done

  echo "error: the application did not come up." >&2
  tail -20 "${RUN_DIR}/next.log" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------
stop() {
  for name in next shim postgrest; do
    if [[ -f "${RUN_DIR}/${name}.pid" ]]; then
      kill "$(cat "${RUN_DIR}/${name}.pid")" 2>/dev/null || true
      rm -f "${RUN_DIR}/${name}.pid"
    fi
  done

  # `npx next start` is a wrapper: the recorded pid is the wrapper's, and
  # killing it leaves `next-server` running. A second `up` then builds,
  # cannot bind, and the readiness probe is answered by the *old* server —
  # so the stack looks healthy while serving the previous build. That is an
  # hour of chasing a bug that was already fixed, so cleanup goes by what is
  # actually running, not by what we remember starting.
  #
  # `lsof -i` does not see these listeners in the project's sandbox, so the
  # ports cannot be used to find them. The working-directory check is what
  # keeps this precise: only processes whose cwd is this checkout are killed,
  # never another project's server on the same machine.
  kill_ours "next-server"
  kill_ours "shim.mjs"
  kill_ours "postgrest"

  log "stopped"
}

# ---------------------------------------------------------------------------
# env
# ---------------------------------------------------------------------------
print_env() {
  cat <<ENV
export NEXT_PUBLIC_SUPABASE_URL="https://127.0.0.1:${SHIM_PORT}"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="${PUBLISHABLE_KEY}"
export NEXT_PUBLIC_APP_ENV="test"
export SUPABASE_SECRET_KEY="${SECRET_KEY}"
export NODE_EXTRA_CA_CERTS="${RUN_DIR}/cert.pem"
export NODE_TLS_REJECT_UNAUTHORIZED="1"
export E2E_BASE_URL="http://127.0.0.1:${APP_PORT}"
export E2E_DATABASE_URL="postgresql://${PG_USER}@127.0.0.1:${PG_PORT}/${PG_DB}"
ENV
}

case "${1:-up}" in
  up) start ;;
  down) stop ;;
  env) print_env ;;
  *) echo "usage: $0 {up|down|env}" >&2; exit 2 ;;
esac
