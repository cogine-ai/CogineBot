#!/usr/bin/env bash

set -Eeuo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
SSH_PORT="${SSH_PORT:-22}"
PRESERVE_EXISTING_UFW_RULES="${PRESERVE_EXISTING_UFW_RULES-0}"
[[ "${PRESERVE_EXISTING_UFW_RULES}" == 0 || "${PRESERVE_EXISTING_UFW_RULES}" == 1 ]] || {
  echo "PRESERVE_EXISTING_UFW_RULES must be 0 or 1" >&2
  exit 1
}
[[ "${SSH_PORT}" =~ ^[0-9]{1,5}$ ]] && (( 10#${SSH_PORT} > 0 && 10#${SSH_PORT} <= 65535 )) || {
  echo "SSH_PORT must be an integer between 1 and 65535" >&2
  exit 1
}
SSH_PORT="$((10#${SSH_PORT}))"

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo --preserve-env=DEPLOY_USER,SSH_PORT,SSH_CONNECTION,PRESERVE_EXISTING_UFW_RULES bash "$0" "$@"
fi

[[ -n "${SSH_CONNECTION:-}" ]] || {
  echo "Run host hardening through SSH, preserving SSH_CONNECTION through sudo" >&2
  exit 1
}
read -r ssh_client ssh_client_port ssh_server ssh_server_port ssh_extra <<<"${SSH_CONNECTION}"
[[ "${SSH_CONNECTION}" != *$'\n'* && -n "${ssh_client}" && -n "${ssh_server}" && -z "${ssh_extra}" &&
  "${ssh_client_port}" =~ ^[0-9]{1,5}$ && "${ssh_server_port}" =~ ^[0-9]{1,5}$ ]] &&
  (( 10#${ssh_client_port} > 0 && 10#${ssh_client_port} <= 65535 && 10#${ssh_server_port} > 0 && 10#${ssh_server_port} <= 65535 )) || {
  echo "Invalid SSH_CONNECTION; run host hardening through a verified SSH session" >&2
  exit 1
}

FIREWALL_HELPER_SOURCE="$(dirname "$(readlink -f "$0")")/firewall-change.sh"
[[ -f "${FIREWALL_HELPER_SOURCE}" && ! -L "${FIREWALL_HELPER_SOURCE}" ]] || {
  echo "Firewall helper source is missing or unsafe" >&2; exit 1;
}
# Reject unsafe or different installed callbacks before packages or host settings change.
for directory in /usr /usr/local; do
  [[ -d "${directory}" && ! -L "${directory}" && "$(stat -c '%u' "${directory}")" == 0 ]] &&
    (( (8#$(stat -c '%a' "${directory}") & 0022) == 0 )) || {
    echo "Unsafe firewall helper parent directory" >&2; exit 1;
  }
done
[[ ! -L /usr/local/sbin && ! -L /usr/local/sbin/rakazo-firewall-change ]] || {
  echo "Firewall helper installation must not follow symbolic links" >&2; exit 1;
}
if [[ -e /usr/local/sbin ]]; then
  [[ -d /usr/local/sbin && "$(stat -c '%u' /usr/local/sbin)" == 0 ]] &&
    (( (8#$(stat -c '%a' /usr/local/sbin) & 0022) == 0 )) || {
    echo "Unsafe firewall helper installation directory" >&2; exit 1;
  }
fi
if [[ -e /usr/local/sbin/rakazo-firewall-change ]]; then
  [[ -f /usr/local/sbin/rakazo-firewall-change && -x /usr/local/sbin/rakazo-firewall-change && "$(stat -c '%u %h' /usr/local/sbin/rakazo-firewall-change)" == '0 1' ]] &&
    (( (8#$(stat -c '%a' /usr/local/sbin/rakazo-firewall-change) & 0022) == 0 )) || {
    echo "Unsafe existing firewall helper" >&2; exit 1;
  }
  cmp -s -- "${FIREWALL_HELPER_SOURCE}" /usr/local/sbin/rakazo-firewall-change || {
    echo "Existing firewall helper differs; finish pending changes and upgrade it manually before hardening" >&2
    exit 1
  }
fi

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "Deploy user ${DEPLOY_USER} does not exist" >&2
  exit 1
fi

# Saved configuration must meet the same ownership/write boundary as its rollback snapshot.
protected_ufw_path() {
  local details owner mode
  details="$(stat -c '%u %a' -- "$1")" || return 1
  read -r owner mode <<<"${details}"
  [[ "${owner}" == 0 && "${mode}" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#${mode} & 0022) == 0 ))
}

# Audit saved rules even while UFW is inactive, before any host settings change.
# Only UFW's exact empty report proves that no registered rules were reported.
for config_directory in /etc /etc/ufw /etc/default /lib/ufw /var/lib/ufw; do
  if [[ -e "${config_directory}" || -L "${config_directory}" ]]; then
    [[ -d "${config_directory}" && ! -L "${config_directory}" && -r "${config_directory}" && -x "${config_directory}" ]] &&
      protected_ufw_path "${config_directory}" || {
      echo "Unsafe or unreadable UFW configuration directory; host hardening stopped before changing host configuration." >&2
      exit 1
    }
  fi
done
# Preserving policy never authorizes UFW or package scripts to read unsafe paths.
for rules_file in /etc/ufw/user.rules /etc/ufw/user6.rules /etc/default/ufw /lib/ufw/user.rules /lib/ufw/user6.rules; do
  if [[ -e "${rules_file}" || -L "${rules_file}" ]]; then
    [[ -f "${rules_file}" && ! -L "${rules_file}" && -r "${rules_file}" ]] &&
      protected_ufw_path "${rules_file}" || {
      echo "Unsafe or unreadable saved UFW configuration; host hardening stopped before changing host configuration." >&2
      exit 1
    }
  fi
done
# UFW can read other saved configuration too; reject unsafe nested members before invoking it.
ufw_config_paths=()
[[ ! -e /etc/ufw ]] || ufw_config_paths+=(/etc/ufw)
[[ ! -e /etc/default/ufw ]] || ufw_config_paths+=(/etc/default/ufw)
if (( ${#ufw_config_paths[@]} )); then
  if ! unsafe_saved_config="$(find "${ufw_config_paths[@]}" \( ! -user root -o -perm /022 -o \( ! -type f -a ! -type d \) \) -print -quit)"; then
    echo "Cannot inspect saved UFW configuration; host hardening stopped before changing host configuration." >&2
    exit 1
  fi
  [[ -z "${unsafe_saved_config}" ]] || {
    echo "Unsafe saved UFW configuration; host hardening stopped before changing host configuration." >&2
    exit 1
  }
fi
ufw_audit_reason=""
if command -v ufw >/dev/null 2>&1; then
  # Missing files leave policy unknown; never invoke UFW on an incomplete audit.
  for rules_file in /etc/ufw/user.rules /etc/ufw/user6.rules; do
    if [[ ! -e "${rules_file}" ]]; then
      ufw_audit_reason="Missing saved UFW rules"
      break
    fi
  done
  if [[ -z "${ufw_audit_reason}" ]]; then
    if ! existing_ufw_rules="$(LC_ALL=C ufw show added 2>&1)"; then
      ufw_audit_reason="Unable to audit existing UFW rules"
    elif [[ "${existing_ufw_rules}" != $'Added user rules (see \'ufw status\' for running firewall):\n(None)' ]]; then
      ufw_audit_reason="Existing UFW rules or unrecognized UFW audit output"
    fi
    # UFW omits saved IPv6 rules from its report when IPV6 is disabled.
    for rules_file in /etc/ufw/user.rules /etc/ufw/user6.rules; do
      if LC_ALL=C grep -q '^### tuple ###' "${rules_file}"; then
        ufw_audit_reason="Existing saved UFW rules"
        break
      elif [[ "$?" -ne 1 ]]; then
        ufw_audit_reason="Unable to read saved UFW rules"
        break
      fi
    done
  fi
else
  # A removed package may leave rules behind; installation must not bypass them.
  for config_path in /etc/ufw /etc/default/ufw /lib/ufw/user.rules /lib/ufw/user6.rules /var/lib/ufw; do
    if [[ -e "${config_path}" || -L "${config_path}" ]]; then
      ufw_audit_reason="Cannot audit retained UFW configuration without ufw"
      break
    fi
  done
fi
if [[ -n "${ufw_audit_reason}" && "${PRESERVE_EXISTING_UFW_RULES}" == 0 ]]; then
  echo "${ufw_audit_reason}; host hardening stopped before changing host configuration." >&2
  echo "Review all saved UFW rules, then set PRESERVE_EXISTING_UFW_RULES=1 only to explicitly preserve every existing rule." >&2
  exit 1
fi
if [[ "${PRESERVE_EXISTING_UFW_RULES}" == 1 ]]; then
  if [[ -n "${ufw_audit_reason}" ]]; then
    echo "${ufw_audit_reason}; proceeding with explicit preservation acknowledgment." >&2
  fi
  echo "PRESERVE_EXISTING_UFW_RULES=1: preserving all existing UFW rules as operator-approved exceptions, including public allows. Default deny and the SSH limit do not override earlier allows." >&2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  apparmor \
  apparmor-utils \
  auditd \
  audispd-plugins \
  fail2ban \
  needrestart \
  ufw \
  unattended-upgrades

install -d -m 755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/99-rakazo-hardening.conf <<EOF
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
AuthenticationMethods publickey
PermitEmptyPasswords no
HostbasedAuthentication no
GSSAPIAuthentication no
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
GatewayPorts no
PermitTunnel no
LoginGraceTime 30
MaxAuthTries 3
MaxSessions 4
MaxStartups 10:30:30
ClientAliveInterval 300
ClientAliveCountMax 2
UseDNS no
LogLevel VERBOSE
AllowUsers ${DEPLOY_USER}
EOF
chmod 600 /etc/ssh/sshd_config.d/99-rakazo-hardening.conf
sshd -t

cat >/etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
backend = systemd
port = ${SSH_PORT}
maxretry = 3
findtime = 10m
bantime = 1h
bantime.increment = true
bantime.factor = 2
bantime.maxtime = 1w
banaction = ufw
EOF

cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

cat >/etc/apt/apt.conf.d/52rakazo-unattended-upgrades <<'EOF'
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

cat >/etc/sysctl.d/99-rakazo-hardening.conf <<'EOF'
fs.protected_fifos = 2
fs.protected_hardlinks = 1
fs.protected_regular = 2
fs.protected_symlinks = 1
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
kernel.perf_event_paranoid = 3
kernel.unprivileged_bpf_disabled = 1
kernel.yama.ptrace_scope = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.default.log_martians = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_rfc1337 = 1
net.ipv4.tcp_syncookies = 1
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.default.accept_source_route = 0
EOF
sysctl --system >/dev/null

install -d -m 750 /etc/audit/rules.d
cat >/etc/audit/rules.d/50-rakazo.rules <<'EOF'
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/ssh/sshd_config.d/ -p wa -k sshd_config
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d/ -p wa -k sudoers
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/gshadow -p wa -k identity
EOF
augenrules --load >/dev/null

# An identical existing callback is reused: never replace a potentially armed version.
if [[ ! -e /usr/local/sbin/rakazo-firewall-change ]]; then
  install -d -m 755 /usr/local/sbin
  install -m 755 -- "${FIREWALL_HELPER_SOURCE}" /usr/local/sbin/rakazo-firewall-change
fi
/usr/local/sbin/rakazo-firewall-change apply /bin/bash -euo pipefail -c '
  ufw default deny incoming
  ufw default allow outgoing
  ufw limit "$1/tcp" comment "Rate-limited SSH"
  ufw allow 80/tcp comment "HTTP for ACME redirect"
  ufw allow 443/tcp comment "HTTPS"
  ufw allow 443/udp comment "HTTP/3"
  ufw --force enable
' -- "${SSH_PORT}"

systemctl enable --now apparmor auditd fail2ban unattended-upgrades
systemctl restart fail2ban
systemctl reload ssh

echo "Host hardening applied. Verify a fresh SSH session and confirm the armed firewall change before closing the current one."
