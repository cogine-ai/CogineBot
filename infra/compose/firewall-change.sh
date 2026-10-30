#!/usr/bin/env bash
# Apply UFW changes with an armed rollback, then confirm from another SSH connection.
set -Eeuo pipefail
umask 077

fail() { echo "$*" >&2; exit 1; }
[[ "${EUID}" == 0 ]] || fail "Run as root, preserving SSH_CONNECTION"

BASE=/var/lib/rakazo
STATE="${BASE}/firewall-change"
ETC=/etc
SELF=/usr/local/sbin/rakazo-firewall-change
BIN=/usr/local/sbin

secure_directory() {
  local details owner mode
  [[ -d "$1" && ! -L "$1" ]] || fail "Unsafe firewall directory: $1"
  details="$(stat -c '%u %a' -- "$1")" || fail "Cannot inspect firewall directory: $1"
  read -r owner mode <<<"${details}"
  [[ "${owner}" == 0 && "${mode}" =~ ^[0-7]{3,4}$ ]] || fail "Unsafe firewall directory owner: $1"
  (( (8#${mode} & 0022) == 0 )) || fail "Writable firewall directory: $1"
}

secure_file() {
  local details owner mode links
  [[ -f "$1" && ! -L "$1" ]] || fail "Unsafe firewall state file: $1"
  details="$(stat -c '%u %a %h' -- "$1")" || fail "Cannot inspect firewall state file: $1"
  read -r owner mode links <<<"${details}"
  [[ "${owner}" == 0 && "${mode}" == 600 && "${links}" == 1 ]] || fail "Unsafe firewall state file permissions: $1"
}

valid_token() { [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; }

require_connection() {
  local client port server server_port extra
  [[ -n "${SSH_CONNECTION:-}" && "${SSH_CONNECTION}" != *$'\n'* ]] || fail "SSH_CONNECTION is required; preserve it through sudo"
  read -r client port server server_port extra <<<"${SSH_CONNECTION}"
  [[ -n "${client}" && -n "${server}" && -z "${extra}" && "${port}" =~ ^[0-9]{1,5}$ && "${server_port}" =~ ^[0-9]{1,5}$ ]] || fail "Invalid SSH_CONNECTION"
  (( 10#${port} > 0 && 10#${port} <= 65535 && 10#${server_port} > 0 && 10#${server_port} <= 65535 )) || fail "Invalid SSH_CONNECTION port"
}

require_space() {
  local free
  free="$(df -Pk -- "$1" | awk 'NR == 2 && $4 ~ /^[0-9]+$/ { free=$4 } END { if (NR != 2 || free == "") exit 1; print free }')" || fail "Cannot measure firewall backup capacity"
  [[ "${free}" =~ ^[0-9]{1,15}$ ]] || fail "Invalid firewall backup capacity"
  (( 10#${free} >= 102400 )) || fail "Need at least 100MiB free before changing the firewall"
}

check_config() {
  secure_directory "${ETC}"
  secure_directory "${ETC}/default"
  secure_directory "${ETC}/ufw"
  [[ -f "${ETC}/default/ufw" && ! -L "${ETC}/default/ufw" ]] || fail "Unsafe UFW defaults file"
  # A snapshot must not follow links or wait on a device/FIFO, or import writable rules.
  local unsafe
  unsafe="$(find "${ETC}/ufw" "${ETC}/default/ufw" \( ! -user root -o -perm /022 -o \( ! -type f -a ! -type d \) \) -print -quit)" || fail "Cannot inspect UFW configuration"
  [[ -z "${unsafe}" ]] || fail "UFW configuration must contain only protected regular files and directories"
}

check_mounts() {
  local mounts
  mounts="$(cat /proc/self/mountinfo)" || fail "Cannot inspect UFW mount layout"
  # Recursive restoration must be able to replace the UFW tree and defaults file.
  # A normal /etc filesystem is supported; nested mounts require manual recovery.
  printf '%s\n' "${mounts}" | awk -v ufw="${ETC}/ufw" -v defaults="${ETC}/default/ufw" '
    {
      separator=0
      for (i=7; i<=NF; i++) if ($i == "-") { if (separator) bad=1; separator=i }
      if (NF < 10 || separator != NF-3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+:[0-9]+$/ || $4 !~ /^\// || $5 !~ /^\//) bad=1
      target=$5; escaped=target
      gsub(/\\(040|011|012|134)/, "", escaped)
      if (escaped ~ /\\/) bad=1
      gsub(/\\040/, " ", target); gsub(/\\011/, "\t", target)
      gsub(/\\012/, "\n", target); gsub(/\\134/, "\\", target)
      if (target == ufw || index(target, ufw "/") == 1 || target == defaults) bad=1
    }
    END { exit (bad || NR == 0) }
  ' || fail "UFW mount layout is unreadable or contains a mounted rollback target"
}

check_archive() {
  local entry root_seen=0 defaults_seen=0 listing
  secure_file "$1"
  listing="$(tar -tf "$1")" || fail "Cannot read the firewall snapshot"
  while IFS= read -r entry; do
    [[ -n "${entry}" && "${entry}" != /* && "/${entry}/" != *'/../'* && "/${entry}/" != *'/./'* && "${entry}" != *'//'* ]] || fail "Unsafe firewall snapshot member"
    case "${entry}" in
      ufw|ufw/) root_seen=1 ;;
      ufw/*) ;;
      default/ufw) defaults_seen=1 ;;
      *) fail "Unexpected firewall snapshot member" ;;
    esac
  done <<<"${listing}"
  [[ "${root_seen}" == 1 && "${defaults_seen}" == 1 ]] || fail "Incomplete firewall snapshot"
  tar -tvf "$1" | awk '
    substr($0,1,1) != "-" && substr($0,1,1) != "d" { bad=1 }
    / ufw\/?$/ { root++; if (substr($0,1,1) != "d") bad=1 }
    / default\/ufw$/ { defaults++; if (substr($0,1,1) != "-") bad=1 }
    END { exit (bad || root != 1 || defaults != 1) }
  ' || fail "Firewall snapshot contains links, special files or invalid root types"
}

publish() {
  local name="$1" value="$2"
  printf '%s\n' "${value}" >"${STATE}/${name}.pending"
  secure_file "${STATE}/${name}.pending"
  # The rename may have succeeded before an interrupted client reports an error.
  if ! mv -fT -- "${STATE}/${name}.pending" "${STATE}/${name}"; then
    secure_file "${STATE}/${name}"
    [[ "$(cat "${STATE}/${name}")" == "${value}" ]] || fail "Could not publish firewall ${name}"
  fi
}

action="${1:-}"; shift || true
case "${action}" in
  apply) (($# > 0)) || fail "Usage: firewall-change apply COMMAND [ARGS...]"; require_connection ;;
  confirm) (($# == 1)) && valid_token "$1" || fail "Usage: firewall-change confirm TOKEN"; require_connection ;;
  rollback) (($# == 1)) && valid_token "$1" || fail "Usage: firewall-change rollback TOKEN" ;;
  *) fail "Usage: firewall-change {apply COMMAND...|confirm TOKEN|rollback TOKEN}" ;;
esac

for directory in /var /var/lib; do secure_directory "${directory}"; done
if [[ ! -e "${BASE}" && ! -L "${BASE}" ]]; then mkdir -m 700 -- "${BASE}"; fi
secure_directory "${BASE}"
if [[ ! -e "${STATE}" && ! -L "${STATE}" ]]; then mkdir -m 700 -- "${STATE}"; fi
secure_directory "${STATE}"
[[ "$(stat -c '%a' -- "${STATE}")" == 700 ]] || fail "Firewall state directory must have mode 700"
if [[ ! -e "${STATE}/lock" && ! -L "${STATE}/lock" ]]; then (set -C; : >"${STATE}/lock"); fi
secure_file "${STATE}/lock"
exec 9<>"${STATE}/lock"
if [[ "${action}" == rollback ]]; then flock 9; else flock -n 9 || fail "Another firewall operation is running"; fi
for name in token token.pending connection connection.pending enabled enabled.pending before.tar before.tar.pending confirmed confirmed.pending; do
  if [[ -e "${STATE}/${name}" || -L "${STATE}/${name}" ]]; then secure_file "${STATE}/${name}"; fi
done

case "${action}" in
  apply)
    [[ ! -e "${STATE}/token" ]] || fail "A firewall change is awaiting confirmation or cleanup"
    for directory in /usr /usr/local "${BIN}"; do secure_directory "${directory}"; done
    [[ -f "${SELF}" && ! -L "${SELF}" && -x "${SELF}" ]] || fail "Install the firewall helper at its protected path"
    read -r script_owner script_mode script_links <<<"$(stat -c '%u %a %h' -- "${SELF}")"
    [[ "${script_owner}" == 0 && "${script_mode}" =~ ^[0-7]{3,4}$ && "${script_links}" == 1 ]] && (( (8#${script_mode} & 0022) == 0 )) || fail "Unsafe installed firewall helper"
    check_config
    check_mounts
    require_space "${ETC}/ufw"
    require_space "${STATE}"
    token="$(cat /proc/sys/kernel/random/uuid)"
    valid_token "${token}" || fail "Could not generate a firewall confirmation token"
    tar -cpf "${STATE}/before.tar.pending" -C "${ETC}" ufw default/ufw
    check_archive "${STATE}/before.tar.pending"
    mv -fT -- "${STATE}/before.tar.pending" "${STATE}/before.tar"
    status="$(LC_ALL=C ufw status)"
    case "${status%%$'\n'*}" in
      'Status: active') enabled=1 ;;
      'Status: inactive') enabled=0 ;;
      *) fail "Could not determine the current firewall state" ;;
    esac
    publish enabled "${enabled}"
    publish connection "${SSH_CONNECTION}"
    rm -f -- "${STATE}/confirmed" "${STATE}/confirmed.pending"
    publish token "${token}"
    unit="rakazo-firewall-rollback-${token}"
    if ! systemd-run --quiet --collect --unit="${unit}" --on-active=180s \
      --timer-property=AccuracySec=1s --timer-property=RemainAfterElapse=no "${SELF}" rollback "${token}" 9>&-; then
      fail "Could not confirm rollback scheduling; firewall was not changed; pending snapshot retained"
    fi
    [[ "$(systemctl show "${unit}.timer" --property=ActiveState --value 9>&-)" == active ]] || fail "Rollback timer is not active; firewall was not changed; pending snapshot retained"
    echo "Rollback armed. After verifying a NEW SSH connection, run:"
    echo "sudo --preserve-env=SSH_CONNECTION ${SELF} confirm ${token}"
    # Children, including long-lived command descendants, must not retain this lock.
    timeout --kill-after=5s 120s "$@" 9>&-
    ;;
  confirm|rollback)
    if [[ "${action}" == confirm && ! -e "${STATE}/token" && -f "${STATE}/confirmed" && "$(cat "${STATE}/confirmed")" == "$1" ]]; then
      secure_file "${STATE}/connection"
      [[ "${SSH_CONNECTION}" != "$(cat "${STATE}/connection")" ]] || fail "Confirm from a fresh SSH connection, preserving SSH_CONNECTION through sudo"
      echo "Firewall confirmation already committed and pending token retired"
      exit 0
    fi
    [[ -f "${STATE}/token" && "$1" == "$(cat "${STATE}/token")" ]] || fail "No pending firewall change with that token"
    token="$1"; unit="rakazo-firewall-rollback-${token}"
    if [[ -f "${STATE}/confirmed" ]]; then
      [[ "$(cat "${STATE}/confirmed")" == "${token}" ]] || fail "Mismatched firewall confirmation state"
    fi
    secure_file "${STATE}/connection"
    secure_file "${STATE}/enabled"
    [[ "$(cat "${STATE}/enabled")" == 0 || "$(cat "${STATE}/enabled")" == 1 ]] || fail "Invalid saved firewall state"
    if [[ "${action}" == confirm ]]; then
      [[ "${SSH_CONNECTION}" != "$(cat "${STATE}/connection")" ]] || fail "Confirm from a fresh SSH connection, preserving SSH_CONNECTION through sudo"
      # This is the confirmation commit point. A queued callback rechecks it under the lock.
      if [[ ! -f "${STATE}/confirmed" ]]; then publish confirmed "${token}"; fi
      if ! systemctl stop "${unit}.timer" 9>&-; then
        echo "Firewall confirmation committed; timer cleanup is incomplete; retry confirm with the same token" >&2
        exit 0
      fi
      if ! rm -f -- "${STATE}/token"; then
        echo "Firewall confirmation committed; state cleanup is incomplete; retry confirm with the same token" >&2
        exit 0
      fi
    else
      if [[ -f "${STATE}/confirmed" && "$(cat "${STATE}/confirmed")" == "${token}" ]]; then
        echo "Firewall confirmation already committed; rollback skipped"
        exit 0
      fi
      check_archive "${STATE}/before.tar"
      secure_directory "${ETC}"
      secure_directory "${ETC}/default"
      if [[ -e "${ETC}/ufw" || -L "${ETC}/ufw" ]]; then secure_directory "${ETC}/ufw"; fi
      [[ ! -L "${ETC}/default/ufw" ]] || fail "Unsafe UFW defaults restore target"
      check_mounts
      # The archive's only directory root is ufw: remove new unconfirmed members too,
      # without deleting any sibling of default/ufw or following directory symlinks.
      tar --recursive-unlink -xpf "${STATE}/before.tar" -C "${ETC}"
      if [[ "$(cat "${STATE}/enabled")" == 1 ]]; then ufw --force enable; else ufw --force disable; fi
      if ! systemctl stop "${unit}.timer" 9>&-; then
        [[ "$(systemctl show "${unit}.timer" --property=ActiveState --value 9>&-)" == inactive ]] || fail "Rollback completed but timer cleanup failed; pending state retained"
      fi
      logger -p authpriv.warning -t rakazo-firewall-change "Restored firewall after an unconfirmed change"
      rm -f -- "${STATE}/token"
    fi
    echo "Firewall change ${action} completed"
    ;;
esac
