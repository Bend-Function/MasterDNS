#!/bin/sh
set -eu

ACTION="${1:-install}"
if [ "$#" -gt 0 ]; then shift; fi
API_URL=""
INSTALL_TOKEN=""
INTERFACE=""
IPV4=""
IPV6=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) API_URL="${2:?missing value for --url}"; shift 2 ;;
    --token) INSTALL_TOKEN="${2:?missing value for --token}"; shift 2 ;;
    --interface) INTERFACE="${2:?missing value for --interface}"; shift 2 ;;
    --ipv4) IPV4="${2:?missing value for --ipv4}"; shift 2 ;;
    --ipv6) IPV6="${2:?missing value for --ipv6}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root" >&2
  exit 1
fi

CONFIG_DIR=/etc/masterdns-ddns
CONFIG_FILE=$CONFIG_DIR/config
AGENT_PATH=/usr/local/bin/masterdns-ddns
SERVICE_FILE=/etc/systemd/system/masterdns-ddns.service
TIMER_FILE=/etc/systemd/system/masterdns-ddns.timer

install_dependencies() {
  missing=""
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  command -v python3 >/dev/null 2>&1 || missing="$missing python3"
  [ -z "$missing" ] && return
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl python3 iproute2
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl python3 iproute
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl python3 iproute
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache ca-certificates curl python3 iproute2
  else
    echo "Install curl, python3, and iproute2 before continuing" >&2
    exit 1
  fi
}

create_user() {
  if id masterdns-ddns >/dev/null 2>&1; then return; fi
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin masterdns-ddns
  elif command -v adduser >/dev/null 2>&1; then
    adduser -S -D -H -h /nonexistent -s /sbin/nologin masterdns-ddns
  else
    echo "No supported system-user command was found" >&2
    exit 1
  fi
}

read_config_value() {
  key="$1"
  sed -n "s/^${key}='\(.*\)'$/\1/p" "$CONFIG_FILE" | head -n 1
}

install_agent_binary() {
  curl -fsS --connect-timeout 10 --max-time 30 "${API_URL%/}/api/v1/ddns/agent.sh" -o "$AGENT_PATH.tmp"
  chmod 0755 "$AGENT_PATH.tmp"
  mv "$AGENT_PATH.tmp" "$AGENT_PATH"
}

case "$ACTION" in
  status)
    systemctl --no-pager status masterdns-ddns.timer masterdns-ddns.service
    exit 0
    ;;
  uninstall)
    systemctl disable --now masterdns-ddns.timer >/dev/null 2>&1 || true
    systemctl stop masterdns-ddns.service >/dev/null 2>&1 || true
    rm -f "$SERVICE_FILE" "$TIMER_FILE" "$AGENT_PATH"
    rm -f "$CONFIG_FILE"
    rmdir "$CONFIG_DIR" 2>/dev/null || true
    systemctl daemon-reload
    if command -v userdel >/dev/null 2>&1; then userdel masterdns-ddns 2>/dev/null || true; fi
    echo "MasterDNS DDNS Agent uninstalled"
    exit 0
    ;;
  update)
    [ -r "$CONFIG_FILE" ] || { echo "Agent is not installed" >&2; exit 1; }
    API_URL="$(read_config_value MASTERDNS_API_URL)"
    [ -n "$API_URL" ] || { echo "Installed API URL is missing" >&2; exit 1; }
    install_dependencies
    install_agent_binary
    systemctl start masterdns-ddns.service
    echo "MasterDNS DDNS Agent updated"
    exit 0
    ;;
  install) ;;
  *) echo "Usage: install.sh {install|update|status|uninstall} [options]" >&2; exit 2 ;;
esac

[ -n "$API_URL" ] || { echo "--url is required" >&2; exit 2; }
[ -n "$INSTALL_TOKEN" ] || { echo "--token is required" >&2; exit 2; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd is required" >&2; exit 1; }

install_dependencies
create_user

EXCHANGE_PAYLOAD="$(python3 - "$INSTALL_TOKEN" <<'PY'
import json
import sys
print(json.dumps({"installToken": sys.argv[1]}, separators=(",", ":")))
PY
)"
EXCHANGE_RESPONSE="$(curl -fsS --connect-timeout 10 --max-time 30 -H 'Content-Type: application/json' --data "$EXCHANGE_PAYLOAD" "${API_URL%/}/api/v1/ddns/exchange")"
RUNTIME_TOKEN="$(printf '%s' "$EXCHANGE_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runtimeToken"])')"
[ -n "$RUNTIME_TOKEN" ] || { echo "Server did not return a runtime token" >&2; exit 1; }

install_agent_binary
install -d -m 0700 -o masterdns-ddns -g masterdns-ddns "$CONFIG_DIR"
umask 077
{
  printf "MASTERDNS_API_URL='%s'\n" "${API_URL%/}"
  printf "MASTERDNS_RUNTIME_TOKEN='%s'\n" "$RUNTIME_TOKEN"
  [ -z "$INTERFACE" ] || printf "MASTERDNS_INTERFACE='%s'\n" "$INTERFACE"
  [ -z "$IPV4" ] || printf "MASTERDNS_IPV4='%s'\n" "$IPV4"
  [ -z "$IPV6" ] || printf "MASTERDNS_IPV6='%s'\n" "$IPV6"
} > "$CONFIG_FILE"
chown masterdns-ddns:masterdns-ddns "$CONFIG_FILE"
chmod 0600 "$CONFIG_FILE"

cat > "$SERVICE_FILE" <<'EOF'
[Unit]
Description=MasterDNS DDNS heartbeat
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=masterdns-ddns
Group=masterdns-ddns
ExecStart=/usr/local/bin/masterdns-ddns
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

cat > "$TIMER_FILE" <<'EOF'
[Unit]
Description=Run MasterDNS DDNS heartbeat every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
RandomizedDelaySec=5s
Persistent=true
Unit=masterdns-ddns.service

[Install]
WantedBy=timers.target
EOF

chmod 0644 "$SERVICE_FILE" "$TIMER_FILE"
systemctl daemon-reload
systemctl enable --now masterdns-ddns.timer
systemctl start masterdns-ddns.service
echo "MasterDNS DDNS Agent installed"
