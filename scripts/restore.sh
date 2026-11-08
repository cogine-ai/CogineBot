#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?usage: restore.sh backups/<stamp>}"
restore_fence_sql="$(cat "$ROOT/scripts/restore-transfer-fence.sql" "$ROOT/scripts/restore-page-share-fence.sql")"
compose=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
# Compose resolves its default env file relative to the compose file, not the
# repo root; point it at the root .env when one exists (vars may also come
# from the environment, so its absence is not an error).
if [[ -f "$ROOT/.env" ]]; then compose=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/docker-compose.yml"); fi
[[ -f "$SRC/rakazo.sql" && ! -L "$SRC/rakazo.sql" ]] || { echo "missing regular rakazo.sql" >&2; exit 1; }
[[ ! -L "$ROOT/data" && ( ! -e "$ROOT/data" || -d "$ROOT/data" ) ]] || {
  echo "data must be a directory, not a symlink" >&2
  exit 1
}
STAGE=""
STOP_ON_FAILURE=0
MIGRATION_STARTED=0
cleanup() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if (( STOP_ON_FAILURE )); then
    "${compose[@]}" stop api worker supervisor || true
    if (( MIGRATION_STARTED )); then "${compose[@]}" stop --timeout 120 migrate || echo "The administrator migration could not be stopped; inspect it before retrying" >&2; fi
  fi
  if [[ -n "$STAGE" ]]; then rm -rf -- "$STAGE" || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -e "$SRC/homes.tgz" || -L "$SRC/homes.tgz" ]]; then
  [[ -f "$SRC/homes.tgz" && ! -L "$SRC/homes.tgz" ]] || {
    echo "homes archive must be a regular file" >&2; exit 1
  }
  STAGE="$(mktemp -d "$ROOT/.restore.XXXXXX")"
  tar -tzf "$SRC/homes.tgz" > "$STAGE/members"
  if [[ -s "$STAGE/members" ]]; then
    while IFS= read -r member; do
      case "$member" in
        data|data/*) ;;
        *) echo "homes archive contains a path outside data" >&2; exit 1 ;;
      esac
      case "/$member/" in
        */../*) echo "homes archive contains a parent path" >&2; exit 1 ;;
      esac
    done < "$STAGE/members"
    tar -xzf "$SRC/homes.tgz" -C "$STAGE"
    [[ ! -L "$STAGE/data" && -d "$STAGE/data" ]] || {
      echo "homes archive must contain a data directory, not a symlink" >&2
      exit 1
    }
  fi
fi
STOP_ON_FAILURE=1
"${compose[@]}" stop --timeout 120 api worker supervisor
"${compose[@]}" up -d postgres
ready=0
for _ in {1..30}; do
  if "${compose[@]}" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo "Postgres did not become ready" >&2; exit 1; }
# Plain SQL preserves its role references. Only the current inert grant role is
# bootstrapped; a missing old or unknown role must fail the restore transaction.
"${compose[@]}" run --rm --no-deps migrate pnpm --filter @rakazo/api run db:restore prepare
authority_fence_sql="$("${compose[@]}" run --rm --no-deps migrate pnpm --silent --filter @rakazo/api run db:restore fence)"
restore_fence_sql="${authority_fence_sql}"$'\n'"${restore_fence_sql}"
# Stop on SQL errors and roll back the dump before restoring files or starting
# the application. -f is required for psql's single-transaction mode.
"${compose[@]}" exec -T postgres sh -c \
  'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" --set=ON_ERROR_STOP=on --single-transaction --file=- --command "$1"' \
  restore "$restore_fence_sql" < "$SRC/rakazo.sql"
MIGRATION_STARTED=1
"${compose[@]}" up --no-deps --no-build --pull never --abort-on-container-exit --exit-code-from migrate migrate
"${compose[@]}" run --rm --no-deps migrate pnpm --filter @rakazo/api run db:restore verify
if [[ -n "$STAGE" && -d "$STAGE/data" ]]; then
  if [[ -e "$ROOT/data" ]]; then
    ROLLBACK="$(mktemp -d "$ROOT/data.rollback.XXXXXX")"
    mv "$ROOT/data" "$ROLLBACK/data"
    echo "Previous data preserved at $ROLLBACK/data"
  fi
  mv "$STAGE/data" "$ROOT/data"
fi
"${compose[@]}" up -d
STOP_ON_FAILURE=0
MIGRATION_STARTED=0
echo "Restore complete from $SRC"
