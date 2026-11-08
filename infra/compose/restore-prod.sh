#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C

PROJECT_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
SRC="${1:?usage: restore-prod.sh /var/backups/rakazo/<stamp>}"
[[ "${PROJECT_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
fail() { echo "$*" >&2; exit 1; }
compose=(docker compose --env-file "${PROJECT_DIR}/.env")
separator="${COMPOSE_PATH_SEPARATOR:-:}"
[[ ${#separator} == 1 ]] || fail "COMPOSE_PATH_SEPARATOR must be one character"
IFS="$separator" read -r -a files <<< "${RAKAZO_COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
for file in "${files[@]}"; do
  [[ -n "$file" ]] || fail "The Compose file list contains an empty path"
  if [[ "$file" != /* ]]; then file="${PROJECT_DIR}/${file}"; fi
  compose+=(-f "$file")
done
writers=(api worker)
services="$("${compose[@]}" config --services)"
for required in api worker migrate postgres; do
  grep -Fxq "$required" <<< "$services" || fail "The selected Compose stack is missing a required service"
done
if grep -Fxq supervisor <<< "$services"; then writers+=(supervisor); fi
for name in rakazo.dump appdata.tgz SOURCE_SIZE_KB SHA256SUMS; do
  [[ -f "${SRC}/${name}" && ! -L "${SRC}/${name}" ]] || fail "The snapshot must contain regular backup files"
done
# The completion receipt has a fixed inventory. Do not let a supplied receipt
# cause the checksum tool to read paths outside this snapshot.
awk 'NF != 2 || $1 !~ /^[[:xdigit:]]+$/ || length($1) != 64 ||
  ($2 != "rakazo.dump" && $2 != "appdata.tgz" && $2 != "SOURCE_SIZE_KB") { exit 1 }
  { if (seen[$2]++) exit 1; count++ } END { if (count != 3) exit 1 }' "${SRC}/SHA256SUMS" || fail "The snapshot checksum inventory is invalid"
(cd "${SRC}"; sha256sum --check --strict SHA256SUMS) || fail "The snapshot checksum verification failed"

STAGE="$(mktemp -d "${PROJECT_DIR}/.restore.XXXXXX")"
PG_STAGE=""
DATA_STAGE=""
STOP_ON_FAILURE=0
MIGRATION_STARTED=0
cleanup() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if (( STOP_ON_FAILURE )); then
    "${compose[@]}" stop "${writers[@]}" || true
    if (( MIGRATION_STARTED )); then "${compose[@]}" stop --timeout 120 migrate || echo "The administrator migration could not be stopped; inspect it before retrying" >&2; fi
  fi
  if [[ -n "${PG_STAGE}" ]]; then
    "${compose[@]}" exec -T postgres rm -rf -- "${PG_STAGE}" || true
  fi
  if [[ -n "${DATA_STAGE}" ]]; then rm -rf -- "${DATA_STAGE}" || true; fi
  rm -rf -- "${STAGE}" || true
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
tar -tzf "${SRC}/appdata.tgz" > "${STAGE}/members"
while IFS= read -r member; do
  [[ "${member}" != /* ]] || fail "The appdata archive contains an absolute path"
  case "/${member}/" in */../*) fail "The appdata archive contains a parent path" ;; esac
done < "${STAGE}/members"

STOP_ON_FAILURE=1
"${compose[@]}" stop --timeout 120 "${writers[@]}"
"${compose[@]}" up -d postgres
ready=0
for _ in {1..30}; do
  if "${compose[@]}" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "${ready}" == 1 ]] || fail "Postgres did not become ready"
PG_STAGE="$("${compose[@]}" exec -T postgres mktemp -d /tmp/coginebot-restore.XXXXXX)"
[[ "${PG_STAGE}" == /tmp/coginebot-restore.* && "${PG_STAGE}" != *[[:space:]]* ]] || fail "Cannot create restore staging"
"${compose[@]}" exec -T postgres sh -c 'cat > "$1"' restore "${PG_STAGE}/archive" < "${SRC}/rakazo.dump"
"${compose[@]}" exec -T postgres pg_restore --list "${PG_STAGE}/archive" > "${STAGE}/archive.toc"
# Only the four managed queue policies contain the old database's derived
# grant role. Keep all other entries, including ROW SECURITY and app policies.
awk -v queue="${STAGE}/queue.toc" '
  /^[0-9]+; [0-9]+ [0-9]+ POLICY graphile_worker (_private_jobs|_private_job_queues|_private_tasks|_private_known_crontabs) coginebot_app_queue / {
    print > queue; next
  }
  { print }
' "${STAGE}/archive.toc" > "${STAGE}/restore.toc"
if [[ -s "${STAGE}/queue.toc" ]]; then
  "${compose[@]}" exec -T postgres sh -c 'cat > "$1"' restore "${PG_STAGE}/queue.toc" < "${STAGE}/queue.toc"
  "${compose[@]}" exec -T postgres pg_restore --no-owner --no-privileges --use-list "${PG_STAGE}/queue.toc" --file=- "${PG_STAGE}/archive" > "${STAGE}/queue.sql"
  awk '
    /^CREATE POLICY / {
      if ($0 !~ /^CREATE POLICY coginebot_app_queue ON graphile_worker\.(_private_jobs|_private_job_queues|_private_tasks|_private_known_crontabs) TO coginebot_app_[1-9][0-9]* USING \(true\) WITH CHECK \(true\);$/) exit 1
      role=$7; sub(/^coginebot_app_/, "", role)
      if (length(role)>10 || role+0>4294967295 || seen[$5]++) exit 1
      if (oldRole!="" && oldRole!=role) exit 1
      oldRole=role; count++
    }
    END { if (count!=4) exit 1 }
  ' "${STAGE}/queue.sql" || fail "The archived managed queue policies are not recognized"
fi
"${compose[@]}" exec -T postgres sh -c 'cat > "$1"' restore "${PG_STAGE}/restore.toc" < "${STAGE}/restore.toc"
# Finish and validate the native archive conversion before psql can COMMIT.
# A failed producer must never leave a partially restored database committed.
"${compose[@]}" exec -T postgres pg_restore --no-owner --no-privileges --use-list "${PG_STAGE}/restore.toc" --file=- "${PG_STAGE}/archive" > "${STAGE}/restore.sql"
"${compose[@]}" run --rm --no-deps migrate pnpm --filter @rakazo/api run db:restore prepare
authority_fence_sql="$("${compose[@]}" run --rm --no-deps migrate pnpm --silent --filter @rakazo/api run db:restore fence)"
restore_fence_sql="${authority_fence_sql}"$'\n'"$(cat "${PROJECT_DIR}/scripts/restore-transfer-fence.sql" "${PROJECT_DIR}/scripts/restore-page-share-fence.sql")"
"${compose[@]}" exec -T postgres sh -c \
  'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" --set=ON_ERROR_STOP=on --single-transaction --file=- --command "$1"' \
  restore "${restore_fence_sql}" < "${STAGE}/restore.sql"
MIGRATION_STARTED=1
"${compose[@]}" up --no-deps --no-build --pull never --abort-on-container-exit --exit-code-from migrate migrate
"${compose[@]}" run --rm --no-deps migrate pnpm --filter @rakazo/api run db:restore verify

# Stage on the volume's filesystem so publishing data is a rename, and retain
# the old directory as an operator-controlled rollback copy.
api="$("${compose[@]}" ps --all -q api)"
if [[ -z "${api}" ]]; then
  "${compose[@]}" create --no-deps api
  api="$("${compose[@]}" ps --all -q api)"
fi
[[ -n "${api}" && "${api}" != *[[:space:]]* ]] || fail "The api service must have exactly one container"
appdata="$(docker inspect "${api}" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{println .Source}}{{end}}{{end}}DATA_MOUNT_END')"
[[ "${appdata}" == *$'\n'DATA_MOUNT_END ]] || fail "Cannot identify the api /data mount"
appdata="${appdata%$'\n'DATA_MOUNT_END}"
[[ "${appdata}" == /* && "${appdata}" != *$'\n'* && -d "${appdata}" && ! -L "${appdata}" ]] || fail "The api container must have one non-symlink /data directory mount"
DATA_STAGE="$(mktemp -d "${appdata%/*}/.coginebot-restore.XXXXXX")"
mkdir "${DATA_STAGE}/data"
tar -xzf "${SRC}/appdata.tgz" --numeric-owner -C "${DATA_STAGE}/data"
rollback="$(mktemp -d "${appdata%/*}/.coginebot-rollback.XXXXXX")"
mv -- "${appdata}" "${rollback}/data"
if ! mv -- "${DATA_STAGE}/data" "${appdata}"; then
  mv -- "${rollback}/data" "${appdata}"
  fail "Cannot publish restored appdata"
fi
echo "Previous appdata preserved at ${rollback}/data"
"${compose[@]}" up -d
STOP_ON_FAILURE=0
MIGRATION_STARTED=0
echo "Restore complete from ${SRC}"
