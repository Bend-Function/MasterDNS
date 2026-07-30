#!/bin/sh
set -eu

ACTION="${1:-install}"
if [ "$#" -gt 0 ]; then shift; fi

API_URL=""
ALLOW_INSECURE_LOOPBACK=false
ALLOW_INSECURE_LOOPBACK_REQUESTED=false
INTERFACE=""
IPV4=""
IPV6=""
INSTALL_TOKEN=""
CURL_PROTO="=https"
CURL_NO_PROXY="${NO_PROXY:-${no_proxy:-}}"

CONFIG_DIR=/etc/masterdns-ddns
CONFIG_FILE=$CONFIG_DIR/config
AGENT_PATH=/usr/local/bin/masterdns-ddns
SERVICE_FILE=/etc/systemd/system/masterdns-ddns.service
TIMER_FILE=/etc/systemd/system/masterdns-ddns.timer

STAGED_AGENT=""
AGENT_INSTALL_TMP=""
CONFIG_TMP=""
SERVICE_TMP=""
TIMER_TMP=""
AUTH_CONFIG=""
TTY_ECHO_DISABLED=false
TTY_STATE=""

restore_tty() {
  if [ "$TTY_ECHO_DISABLED" = true ]; then
    if [ -n "$TTY_STATE" ]; then
      stty "$TTY_STATE" < /dev/tty >/dev/null 2>&1 || true
    else
      stty echo < /dev/tty >/dev/null 2>&1 || true
    fi
    TTY_ECHO_DISABLED=false
    TTY_STATE=""
    printf '\n' > /dev/tty 2>/dev/null || true
  fi
}

cleanup() {
  restore_tty
  [ -z "$STAGED_AGENT" ] || rm -f "$STAGED_AGENT"
  [ -z "$AGENT_INSTALL_TMP" ] || rm -f "$AGENT_INSTALL_TMP"
  [ -z "$CONFIG_TMP" ] || rm -f "$CONFIG_TMP"
  [ -z "$SERVICE_TMP" ] || rm -f "$SERVICE_TMP"
  [ -z "$TIMER_TMP" ] || rm -f "$TIMER_TMP"
  [ -z "$AUTH_CONFIG" ] || rm -f "$AUTH_CONFIG"
}

on_signal() {
  trap - EXIT HUP INT TERM
  cleanup
  exit 1
}

trap cleanup EXIT
trap on_signal HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) API_URL="${2:?missing value for --url}"; shift 2 ;;
    --allow-insecure-loopback)
      ALLOW_INSECURE_LOOPBACK=true
      ALLOW_INSECURE_LOOPBACK_REQUESTED=true
      shift
      ;;
    --token)
      echo "--token is no longer accepted; the installer prompts securely on /dev/tty" >&2
      exit 2
      ;;
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

install_dependencies() {
  missing=""
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  command -v python3 >/dev/null 2>&1 || missing="$missing python3"
  command -v ip >/dev/null 2>&1 || missing="$missing iproute2"
  command -v stty >/dev/null 2>&1 || missing="$missing coreutils"
  [ -z "$missing" ] && return

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl python3 iproute2 coreutils
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl python3 iproute coreutils
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl python3 iproute coreutils
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache ca-certificates curl python3 iproute2 coreutils
  else
    echo "Install curl, python3, iproute2, and coreutils before continuing" >&2
    exit 1
  fi
}

group_exists() {
  if command -v getent >/dev/null 2>&1; then
    getent group masterdns-ddns >/dev/null 2>&1
  else
    awk -F: '$1 == "masterdns-ddns" { found = 1 } END { exit !found }' /etc/group
  fi
}

create_user() {
  if ! group_exists; then
    if command -v groupadd >/dev/null 2>&1; then
      groupadd --system masterdns-ddns
    elif command -v addgroup >/dev/null 2>&1; then
      addgroup -S masterdns-ddns
    else
      echo "No supported system-group command was found" >&2
      exit 1
    fi
  fi

  if id masterdns-ddns >/dev/null 2>&1; then return; fi
  if command -v useradd >/dev/null 2>&1; then
    nologin_shell="$(command -v nologin || printf '/usr/sbin/nologin')"
    useradd --system --gid masterdns-ddns --no-create-home --home-dir /nonexistent --shell "$nologin_shell" masterdns-ddns
  elif command -v adduser >/dev/null 2>&1; then
    adduser -S -D -H -G masterdns-ddns -h /nonexistent -s /sbin/nologin masterdns-ddns
  else
    echo "No supported system-user command was found" >&2
    exit 1
  fi
}

read_config_value() {
  config_key="$1"
  sed -n "s/^${config_key}='\(.*\)'$/\1/p" "$CONFIG_FILE" | head -n 1
}

validate_config_value() {
  config_label="$2"
  if ! printf '%s' "$1" | python3 -c '
import sys

label = sys.argv[1]
value = sys.stdin.read()
if len(value) > 2048 or chr(39) in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
    raise SystemExit(f"{label} contains unsupported characters")
' "$config_label"; then
    exit 2
  fi
}

validate_token() {
  printf '%s' "$1" | python3 -c '
import re
import sys

token = sys.stdin.read()
if re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token) is None:
    raise SystemExit("Token has an invalid format")
'
}

validate_optional_address() {
  address_family="$2"
  [ -z "$1" ] && return 0
  printf '%s' "$1" | python3 -c '
import ipaddress
import sys

expected_version = int(sys.argv[1])
try:
    address = ipaddress.ip_address(sys.stdin.read())
except ValueError:
    raise SystemExit(f"IPv{expected_version} address is invalid") from None
if address.version != expected_version:
    raise SystemExit(f"Expected an IPv{expected_version} address")
' "$address_family"
}

validate_api_url() {
  python3 - "$API_URL" "$ALLOW_INSECURE_LOOPBACK" <<'PY'
import ipaddress
import sys
from urllib.parse import urlsplit

raw_url, allow_insecure = sys.argv[1:]
if not raw_url or any(char.isspace() or ord(char) < 32 for char in raw_url):
    raise SystemExit("API URL contains whitespace or control characters")

try:
    parsed = urlsplit(raw_url)
    port = parsed.port
except ValueError as error:
    raise SystemExit(f"Invalid API URL: {error}") from None

if parsed.scheme not in {"https", "http"} or not parsed.hostname:
    raise SystemExit("--url must be an absolute HTTPS URL")
if parsed.username is not None or parsed.password is not None:
    raise SystemExit("API URL must not include credentials")
if parsed.query or parsed.fragment or "?" in raw_url or "#" in raw_url:
    raise SystemExit("API URL must not include a query string or fragment")
if port is not None and not (1 <= port <= 65535):
    raise SystemExit("API URL port is invalid")

if parsed.scheme == "http":
    hostname = parsed.hostname.rstrip(".").lower()
    try:
        is_loopback = ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        is_loopback = hostname == "localhost"
    if not is_loopback or allow_insecure != "true":
        raise SystemExit("HTTP is allowed only for a loopback URL with --allow-insecure-loopback")
PY
  validation_status=$?
  [ "$validation_status" -eq 0 ] || return "$validation_status"

  while [ "${API_URL%/}" != "$API_URL" ]; do API_URL="${API_URL%/}"; done
  case "$API_URL" in
    https://*) CURL_PROTO="=https" ;;
    http://*) CURL_PROTO="=http"; CURL_NO_PROXY="*" ;;
  esac
}

validate_agent() {
  candidate="$1"
  [ -s "$candidate" ] || { echo "Downloaded Agent is empty" >&2; return 1; }
  [ "$(sed -n '1p' "$candidate")" = "#!/bin/sh" ] || {
    echo "Downloaded Agent has an invalid executable header" >&2
    return 1
  }
  grep -Fq 'MASTERDNS_DDNS_CONFIG' "$candidate" || {
    echo "Downloaded content is not the MasterDNS DDNS Agent" >&2
    return 1
  }
  grep -Fq 'MASTERDNS_ALLOW_INSECURE_LOOPBACK' "$candidate" || {
    echo "Downloaded Agent does not enforce the required URL policy" >&2
    return 1
  }
  grep -Fq -- '--proto "$CURL_PROTO"' "$candidate" || {
    echo "Downloaded Agent does not enforce the required curl protocol policy" >&2
    return 1
  }
  sh -n "$candidate" || {
    echo "Downloaded Agent failed shell syntax validation" >&2
    return 1
  }
}

stage_agent() {
  STAGED_AGENT="$(mktemp /tmp/masterdns-ddns-agent.XXXXXX)"
  curl -q -fsS \
    --proto "$CURL_PROTO" \
    --proto-redir "$CURL_PROTO" \
    --noproxy "$CURL_NO_PROXY" \
    --connect-timeout 10 \
    --max-time 30 \
    "${API_URL}/api/v1/ddns/agent.sh" \
    -o "$STAGED_AGENT"
  validate_agent "$STAGED_AGENT"
}

install_staged_agent() {
  [ -n "$STAGED_AGENT" ] || { echo "No validated Agent is staged" >&2; exit 1; }
  install -d -m 0755 -o root -g root "$(dirname "$AGENT_PATH")"
  AGENT_INSTALL_TMP="$(mktemp "${AGENT_PATH}.XXXXXX")"
  install -m 0755 -o root -g root "$STAGED_AGENT" "$AGENT_INSTALL_TMP"
  mv -f "$AGENT_INSTALL_TMP" "$AGENT_PATH"
  AGENT_INSTALL_TMP=""
}

read_install_token() {
  [ -r /dev/tty ] && [ -w /dev/tty ] || {
    echo "A controlling terminal is required to enter the install token" >&2
    exit 1
  }
  printf 'MasterDNS install token: ' > /dev/tty
  TTY_STATE="$(stty -g < /dev/tty)"
  TTY_ECHO_DISABLED=true
  stty -echo < /dev/tty
  if ! IFS= read -r INSTALL_TOKEN < /dev/tty; then
    restore_tty
    echo "Could not read the install token" >&2
    exit 1
  fi
  restore_tty
  validate_token "$INSTALL_TOKEN"
}

exchange_install_token() {
  EXCHANGE_RESPONSE="$(
    printf '%s' "$INSTALL_TOKEN" |
      python3 -c 'import json,sys; print(json.dumps({"installToken": sys.stdin.read()}, separators=(",", ":")))' |
      curl -q -fsS \
        --proto "$CURL_PROTO" \
        --proto-redir "$CURL_PROTO" \
        --noproxy "$CURL_NO_PROXY" \
        --connect-timeout 10 \
        --max-time 30 \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        "${API_URL}/api/v1/ddns/exchange"
  )"
  INSTALL_TOKEN=""
  RUNTIME_TOKEN="$(printf '%s' "$EXCHANGE_RESPONSE" | python3 -c '
import json
import sys

try:
    value = json.load(sys.stdin).get("runtimeToken")
except (AttributeError, json.JSONDecodeError):
    raise SystemExit("Server returned an invalid exchange response") from None
if not isinstance(value, str):
    raise SystemExit("Server did not return a runtime token")
print(value, end="")
')"
  EXCHANGE_RESPONSE=""
  validate_token "$RUNTIME_TOKEN"
}

write_config() {
  install -d -m 0750 -o root -g masterdns-ddns "$CONFIG_DIR"
  CONFIG_TMP="$(mktemp "$CONFIG_DIR/.config.XXXXXX")"
  umask 077
  {
    printf "MASTERDNS_API_URL='%s'\n" "$API_URL"
    printf "MASTERDNS_ALLOW_INSECURE_LOOPBACK='%s'\n" "$ALLOW_INSECURE_LOOPBACK"
    printf "MASTERDNS_RUNTIME_TOKEN='%s'\n" "$RUNTIME_TOKEN"
    [ -z "$INTERFACE" ] || printf "MASTERDNS_INTERFACE='%s'\n" "$INTERFACE"
    [ -z "$IPV4" ] || printf "MASTERDNS_IPV4='%s'\n" "$IPV4"
    [ -z "$IPV6" ] || printf "MASTERDNS_IPV6='%s'\n" "$IPV6"
  } > "$CONFIG_TMP"
  chown root:masterdns-ddns "$CONFIG_TMP"
  chmod 0640 "$CONFIG_TMP"
  mv -f "$CONFIG_TMP" "$CONFIG_FILE"
  CONFIG_TMP=""
  RUNTIME_TOKEN=""
}

write_service_files() {
  SERVICE_TMP="$(mktemp "${SERVICE_FILE}.XXXXXX")"
  cat > "$SERVICE_TMP" <<'EOF'
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
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$SERVICE_TMP"
  chown root:root "$SERVICE_TMP"
  mv -f "$SERVICE_TMP" "$SERVICE_FILE"
  SERVICE_TMP=""

  TIMER_TMP="$(mktemp "${TIMER_FILE}.XXXXXX")"
  cat > "$TIMER_TMP" <<'EOF'
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
  chmod 0644 "$TIMER_TMP"
  chown root:root "$TIMER_TMP"
  mv -f "$TIMER_TMP" "$TIMER_FILE"
  TIMER_TMP=""
}

best_effort_revoke() {
  [ -r "$CONFIG_FILE" ] || return 0
  command -v curl >/dev/null 2>&1 || {
    echo "Warning: curl is unavailable; runtime token was not revoked remotely" >&2
    return 0
  }
  command -v python3 >/dev/null 2>&1 || {
    echo "Warning: python3 is unavailable; runtime token was not revoked remotely" >&2
    return 0
  }

  API_URL="$(read_config_value MASTERDNS_API_URL)"
  ALLOW_INSECURE_LOOPBACK="$(read_config_value MASTERDNS_ALLOW_INSECURE_LOOPBACK)"
  RUNTIME_TOKEN="$(read_config_value MASTERDNS_RUNTIME_TOKEN)"
  [ -n "$ALLOW_INSECURE_LOOPBACK" ] || ALLOW_INSECURE_LOOPBACK=false
  case "$ALLOW_INSECURE_LOOPBACK" in
    true|false) ;;
    *)
      echo "Warning: installed URL policy is invalid; runtime token was not revoked remotely" >&2
      return 0
      ;;
  esac
  if [ -z "$API_URL" ] || [ -z "$RUNTIME_TOKEN" ]; then
    echo "Warning: installed DDNS credentials are incomplete; runtime token was not revoked remotely" >&2
    return 0
  fi
  if ! validate_api_url || ! validate_token "$RUNTIME_TOKEN"; then
    echo "Warning: installed DDNS credentials are invalid; runtime token was not revoked remotely" >&2
    return 0
  fi

  AUTH_CONFIG="$(mktemp /tmp/masterdns-ddns-curl.XXXXXX)"
  chmod 0600 "$AUTH_CONFIG"
  printf 'header = "Authorization: Bearer %s"\n' "$RUNTIME_TOKEN" > "$AUTH_CONFIG"
  if ! curl -q -fsS \
    --config "$AUTH_CONFIG" \
    --proto "$CURL_PROTO" \
    --proto-redir "$CURL_PROTO" \
    --noproxy "$CURL_NO_PROXY" \
    --connect-timeout 10 \
    --max-time 30 \
    -H 'Content-Type: application/json' \
    --request POST \
    --data '{}' \
    "${API_URL}/api/v1/ddns/revoke" >/dev/null; then
    echo "Warning: the remote runtime token could not be revoked; continuing local uninstall" >&2
  fi
  rm -f "$AUTH_CONFIG"
  AUTH_CONFIG=""
  RUNTIME_TOKEN=""
}

case "$ACTION" in
  status)
    command -v systemctl >/dev/null 2>&1 || { echo "systemd is required" >&2; exit 1; }
    systemctl --no-pager status masterdns-ddns.timer masterdns-ddns.service
    exit 0
    ;;
  uninstall)
    best_effort_revoke
    if command -v systemctl >/dev/null 2>&1; then
      systemctl disable --now masterdns-ddns.timer >/dev/null 2>&1 || true
      systemctl stop masterdns-ddns.service >/dev/null 2>&1 || true
    fi
    rm -f "$SERVICE_FILE" "$TIMER_FILE" "$AGENT_PATH" "$CONFIG_FILE"
    rmdir "$CONFIG_DIR" 2>/dev/null || true
    if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload; fi
    if command -v userdel >/dev/null 2>&1; then
      userdel masterdns-ddns 2>/dev/null || true
    elif command -v deluser >/dev/null 2>&1; then
      deluser masterdns-ddns 2>/dev/null || true
    fi
    if command -v groupdel >/dev/null 2>&1; then
      groupdel masterdns-ddns 2>/dev/null || true
    elif command -v delgroup >/dev/null 2>&1; then
      delgroup masterdns-ddns 2>/dev/null || true
    fi
    echo "MasterDNS DDNS Agent uninstalled"
    exit 0
    ;;
  update)
    [ -r "$CONFIG_FILE" ] || { echo "Agent is not installed" >&2; exit 1; }
    API_URL="$(read_config_value MASTERDNS_API_URL)"
    installed_allowance="$(read_config_value MASTERDNS_ALLOW_INSECURE_LOOPBACK)"
    if [ -n "$installed_allowance" ]; then
      ALLOW_INSECURE_LOOPBACK="$installed_allowance"
    elif [ "$ALLOW_INSECURE_LOOPBACK_REQUESTED" = true ]; then
      ALLOW_INSECURE_LOOPBACK=true
    else
      ALLOW_INSECURE_LOOPBACK=false
    fi
    RUNTIME_TOKEN="$(read_config_value MASTERDNS_RUNTIME_TOKEN)"
    INTERFACE="$(read_config_value MASTERDNS_INTERFACE)"
    IPV4="$(read_config_value MASTERDNS_IPV4)"
    IPV6="$(read_config_value MASTERDNS_IPV6)"
    case "$ALLOW_INSECURE_LOOPBACK" in true|false) ;; *) echo "Installed URL policy is invalid" >&2; exit 1 ;; esac
    [ -n "$API_URL" ] || { echo "Installed API URL is missing" >&2; exit 1; }
    [ -n "$RUNTIME_TOKEN" ] || { echo "Installed runtime token is missing" >&2; exit 1; }
    command -v systemctl >/dev/null 2>&1 || { echo "systemd is required" >&2; exit 1; }
    install_dependencies
    validate_api_url
    validate_token "$RUNTIME_TOKEN"
    validate_config_value "$API_URL" "API URL"
    validate_config_value "$INTERFACE" "Interface"
    validate_config_value "$IPV4" "IPv4 address"
    validate_config_value "$IPV6" "IPv6 address"
    validate_optional_address "$IPV4" 4
    validate_optional_address "$IPV6" 6
    create_user
    stage_agent
    write_config
    install_staged_agent
    systemctl start masterdns-ddns.service
    echo "MasterDNS DDNS Agent updated"
    exit 0
    ;;
  install) ;;
  *)
    echo "Usage: install.sh {install|update|status|uninstall} [--url URL] [--allow-insecure-loopback] [address options]" >&2
    exit 2
    ;;
esac

[ -n "$API_URL" ] || { echo "--url is required" >&2; exit 2; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd is required" >&2; exit 1; }
install_dependencies
validate_api_url
validate_config_value "$API_URL" "API URL"
validate_config_value "$INTERFACE" "Interface"
validate_config_value "$IPV4" "IPv4 address"
validate_config_value "$IPV6" "IPv6 address"
validate_optional_address "$IPV4" 4
validate_optional_address "$IPV6" 6

# Validate the exact executable that will be installed before consuming the one-time token.
stage_agent
create_user
read_install_token
exchange_install_token

validate_config_value "$RUNTIME_TOKEN" "Runtime token"
write_config
install_staged_agent
write_service_files

systemctl daemon-reload
systemctl enable --now masterdns-ddns.timer
systemctl start masterdns-ddns.service
echo "MasterDNS DDNS Agent installed"
