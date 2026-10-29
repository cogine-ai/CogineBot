#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C

PROJECT_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${PROJECT_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
COMPOSE_FILE="${PROJECT_DIR}/infra/compose/docker-compose.prod.yml"
ENV_FILE="${PROJECT_DIR}/.env"
BACKUP_ROOT="/var/backups/rakazo"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_DIR="${BACKUP_ROOT}/${STAMP}"
MIN_FREE_GB="${RAKAZO_BACKUP_MIN_FREE_GB-5}"
MAX_GB="${RAKAZO_BACKUP_MAX_GB-50}"
REQUIRE_VOLUME="${RAKAZO_BACKUP_REQUIRE_VOLUME-0}"
MAX_INTEGER=9223372036854775807

fail() {
  echo "$*" >&2
  exit 1
}

# Validate before arithmetic: shell integers otherwise wrap on oversized input.
is_uint() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  ((${#1} < 19)) || { ((${#1} == 19)) && [[ "$1" < "9223372036854775808" ]]; }
}
for value in "${MIN_FREE_GB}" "${MAX_GB}"; do
  is_uint "${value}" && [[ "${value}" != 0 ]] && ((value <= MAX_INTEGER / 1024 / 1024)) ||
    fail "Backup space limits must be positive whole GiB within the supported integer range"
done
[[ "${REQUIRE_VOLUME}" == 0 || "${REQUIRE_VOLUME}" == 1 ]] || fail "RAKAZO_BACKUP_REQUIRE_VOLUME must be 0 or 1"
reserve_kb=$((MIN_FREE_GB * 1024 * 1024))
budget_kb=$((MAX_GB * 1024 * 1024))

valid_stamp() {
  local name="$1" year month day days
  [[ "${name}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  year=$((10#${name:0:4}))
  month=$((10#${name:4:2}))
  day=$((10#${name:6:2}))
  ((year > 0 && month >= 1 && month <= 12 && day >= 1 && 10#${name:9:2} < 24 && 10#${name:11:2} < 60 && 10#${name:13:2} < 60)) || return 1
  case "${month}" in
    2) days=28; if ((year % 4 == 0 && (year % 100 != 0 || year % 400 == 0))); then days=29; fi ;;
    4|6|9|11) days=30 ;;
    *) days=31 ;;
  esac
  ((day <= days))
}
valid_stamp "${STAMP}" || fail "Cannot determine a valid backup timestamp"

# Read the filesystem device on GNU and BSD hosts.
device_id() {
  local value
  if value="$(stat -c %d -- "$1" 2>/dev/null)"; then
    :
  else
    value="$(stat -f %d "$1")" || return 1
  fi
  is_uint "${value}" || return 1
  printf '%s\n' "${value}"
}
if [[ "${REQUIRE_VOLUME}" == 1 ]]; then
  mountpoint -q /var/backups || fail "/var/backups must be a mounted backup volume"
  backup_device="$(device_id /var/backups)" || fail "Cannot identify the backup filesystem"
  root_device="$(device_id /)" || fail "Cannot identify the root filesystem"
  [[ "${backup_device}" != "${root_device}" ]] || fail "/var/backups must be on a separate filesystem"
fi

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

# Archive the appdata volume from the host, not through `compose exec api`.
#
# The api image runs as `USER node` (uid 1000) with `cap_drop: ALL`, while the
# supervisor creates each bot computer's home under /data as root with mode 600
# (receipts, taught skills, connector tokens). Inside a cap-dropped container
# uid 1000 cannot read those files, so `tar` exits 2 and the archive it leaves
# behind is missing exactly the bot state a restore needs. Root on the host has
# CAP_DAC_OVERRIDE and reads all of it.
#
# Ask the running container where /data actually is, rather than rebuilding the
# volume name from a project name. `compose config` reports this file's `name:`
# key and ignores an operator's `-p` or COMPOSE_PROJECT_NAME, so reconstructing
# "<project>_appdata" would inspect the default project's volume on any stack
# started under another name, and silently archive the wrong one. This uses the
# same compose invocation as the pg_dump below, so both target one stack.
api="$("${compose[@]}" ps -q api)"
[[ -n "${api}" && "${api}" != *[[:space:]]* ]] || fail "The api service must have exactly one running container"
appdata="$(docker inspect "${api}" \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{println .Source}}{{end}}{{end}}DATA_MOUNT_END')"
[[ "${appdata}" == *$'\n'DATA_MOUNT_END ]] || fail "Cannot identify the api /data mount"
appdata="${appdata%$'\n'DATA_MOUNT_END}"
[[ "${appdata}" == /* && "${appdata}" != *$'\n'* && -d "${appdata}" ]] || fail "The api container must have exactly one /data directory mount"

[[ ! -L "${BACKUP_ROOT}" && ! -L "${BACKUP_ROOT%/*}" ]] || fail "The backup root must not be a symbolic link"
if [[ -e "${BACKUP_ROOT}" ]]; then
  [[ -d "${BACKUP_ROOT}" && -O "${BACKUP_ROOT}" ]] || fail "The backup root must be an owned directory"
fi
install -d -m 700 "${BACKUP_ROOT}"
[[ -d "${BACKUP_ROOT}" && ! -L "${BACKUP_ROOT}" && -O "${BACKUP_ROOT}" ]] || fail "The backup root must be an owned directory"
backup_device="$(device_id "${BACKUP_ROOT}")" || fail "Cannot identify the backup filesystem"
[[ ! -L "${BACKUP_ROOT}/.lock" ]] || fail "The backup lock must not be a symbolic link"
if [[ -e "${BACKUP_ROOT}/.lock" ]]; then
  [[ -f "${BACKUP_ROOT}/.lock" && -O "${BACKUP_ROOT}/.lock" ]] || fail "The backup lock must be an owned regular file"
fi
# Descendants retain this descriptor, so an orphan writer still holds the lock.
exec 8>>"${BACKUP_ROOT}/.lock"
flock -n 8 || fail "Another Rakazo backup is running"
[[ ! -e "${SNAPSHOT_DIR}" && ! -L "${SNAPSHOT_DIR}" ]] || fail "A snapshot already exists for this timestamp"

safe_snapshot() {
  [[ "$1" == "${BACKUP_ROOT}/"* && "${1%/*}" == "${BACKUP_ROOT}" && -d "$1" && ! -L "$1" && -O "$1" ]] || return 1
  valid_stamp "${1##*/}" || return 1
  [[ "$(device_id "$1")" == "${backup_device}" ]]
}
complete_snapshot() {
  [[ -f "$1/SHA256SUMS" && ! -L "$1/SHA256SUMS" ]]
}
size_kb() {
  local value
  value="$(du -sk "$1" | awk 'NR == 1 { print $1 } END { if (NR != 1) exit 1 }')" || return 1
  is_uint "${value}" || return 1
  printf '%s\n' "${value}"
}
space() {
  free_kb="$(df -Pk "${BACKUP_ROOT}" | awk 'NR == 2 { print $4 } END { if (NR != 2) exit 1 }')" || fail "Cannot read available backup space"
  is_uint "${free_kb}" || fail "Invalid available backup space"
  used_kb="$(size_kb "${BACKUP_ROOT}")" || fail "Cannot read backup storage usage"
}

# Only regular completion receipts count; legacy receipts need no size metadata.
last=""
for dir in "${BACKUP_ROOT}"/*; do
  [[ -d "${dir}" && ! -L "${dir}" && -O "${dir}" ]] || continue
  valid_stamp "${dir##*/}" || continue
  safe_snapshot "${dir}" || fail "A snapshot is on an unexpected filesystem"
  if complete_snapshot "${dir}" && [[ "${dir}" > "${last}" ]]; then last="${dir}"; fi
done
source_kb="$(size_kb "${appdata}")" || fail "Cannot read appdata source usage"
need_kb="${source_kb}"
if [[ -n "${last}" ]]; then
  last_kb="$(size_kb "${last}")" || fail "Cannot read the previous snapshot size"
  last_source=""
  if [[ -f "${last}/SOURCE_SIZE_KB" && ! -L "${last}/SOURCE_SIZE_KB" ]]; then
    last_source="$(cat "${last}/SOURCE_SIZE_KB")"
  fi
  if is_uint "${last_source}" && [[ "${last_source}" != 0 && -f "${last}/appdata.tgz" && ! -L "${last}/appdata.tgz" && -f "${last}/rakazo.dump" && ! -L "${last}/rakazo.dump" ]]; then
    archive_kb="$(size_kb "${last}/appdata.tgz")" || fail "Cannot read the previous archive size"
    dump_kb="$(size_kb "${last}/rakazo.dump")" || fail "Cannot read the previous dump size"
    need_kb="$(awk -v archive="${archive_kb}" -v dump="${dump_kb}" -v current="${source_kb}" -v previous="${last_source}" \
      'BEGIN { printf "%.0f\n", dump + archive * current / previous }')" || fail "Cannot estimate backup growth"
    is_uint "${need_kb}" || fail "The backup growth estimate exceeds the supported integer range"
  fi
  ((last_kb <= need_kb)) || need_kb="${last_kb}"
fi
((need_kb <= MAX_INTEGER - need_kb / 4 - 1024 * 1024)) || fail "The backup estimate exceeds the supported integer range"
need_kb=$((need_kb + need_kb / 4 + 1024 * 1024))
# Failed or malformed measurements must not authorize deletion of old snapshots.
space

# Preserve every complete snapshot in the seven-day window and the newest one
# regardless of age or budget. Cleanup never trades a protected copy for space.
cleanup_history() {
  local dir expired
  for dir in "${BACKUP_ROOT}"/*; do
    safe_snapshot "${dir}" || continue
    if ! complete_snapshot "${dir}"; then
      rm -rf -- "${dir}"
    elif [[ "${dir}" != "${last}" ]]; then
      expired="$(find "${dir}" -maxdepth 0 -mtime +6 -print)" || fail "Cannot determine snapshot retention age"
      if [[ -n "${expired}" ]]; then rm -rf -- "${dir}"; fi
    fi
  done
}
cleanup_history
space
if ((free_kb < reserve_kb || need_kb > free_kb - reserve_kb || used_kb > budget_kb || need_kb > budget_kb - used_kb)); then
  echo "Backup storage needs about $((need_kb / 1024))MB plus ${MIN_FREE_GB}GiB reserve, within a ${MAX_GB}GiB backup budget." >&2
  fail "Keeping protected snapshots; increase backup capacity or reduce the source data"
fi

mkdir -m 700 -- "${SNAPSHOT_DIR}"
# The EXIT trap owns this directory only after this run successfully creates it.
verified=0
cleanup() {
  if [[ "${verified}" != 1 ]] && safe_snapshot "${SNAPSHOT_DIR}"; then
    rm -rf -- "${SNAPSHOT_DIR}"
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Recompute before every output; metadata and checksums also consume the budget.
output_limit() {
  space
  ((free_kb > reserve_kb && used_kb < budget_kb)) || fail "Backup storage budget exhausted"
  limit_kb=$((free_kb - reserve_kb))
  remaining_kb=$((budget_kb - used_kb))
  ((limit_kb <= remaining_kb)) || limit_kb="${remaining_kb}"
}
output_limit
(ulimit -c 0 || exit 1; ulimit -f "${limit_kb}" || exit 1; printf '%s\n' "${source_kb}" > "${SNAPSHOT_DIR}/SOURCE_SIZE_KB")

output_limit
(ulimit -c 0 || exit 1; ulimit -f "${limit_kb}" || exit 1; exec "${compose[@]}" exec -T postgres sh -c \
  'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "${SNAPSHOT_DIR}/rakazo.dump")

# Bots write while this runs. GNU tar exits 1 for "file changed as we read it",
# which is expected on a live system and still yields a usable archive; only a
# fatal error (2) fails the backup.
rc=0
output_limit
(ulimit -c 0 || exit 1; ulimit -f "${limit_kb}" || exit 1; exec tar -czf "${SNAPSHOT_DIR}/appdata.tgz" --numeric-owner -C "${appdata}" .) || rc=$?
if [[ "${rc}" -gt 1 ]]; then
  echo "appdata archive failed with tar exit ${rc}" >&2
  exit "${rc}"
fi

"${compose[@]}" exec -T postgres pg_restore --list \
  < "${SNAPSHOT_DIR}/rakazo.dump" >/dev/null
tar -tzf "${SNAPSHOT_DIR}/appdata.tgz" >/dev/null

output_limit
(ulimit -c 0 || exit 1; ulimit -f "${limit_kb}" || exit 1; cd "${SNAPSHOT_DIR}"; sha256sum rakazo.dump appdata.tgz SOURCE_SIZE_KB > SHA256SUMS.pending)
chmod 600 "${SNAPSHOT_DIR}"/*
space
((free_kb >= reserve_kb && used_kb <= budget_kb)) || fail "Backup storage budget exhausted after writing metadata"
sync -- "${SNAPSHOT_DIR}"/*
# Publish the completion marker only after every output is verified and synced.
mv "${SNAPSHOT_DIR}/SHA256SUMS.pending" "${SNAPSHOT_DIR}/SHA256SUMS"
sync -- "${SNAPSHOT_DIR}"
verified=1
# Keep a newer receipt when the host clock moves backwards.
if [[ "${SNAPSHOT_DIR}" > "${last}" ]]; then last="${SNAPSHOT_DIR}"; fi
cleanup_history

echo "Verified Rakazo backup written to ${SNAPSHOT_DIR}"
