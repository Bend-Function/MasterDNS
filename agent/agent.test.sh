#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -P "$(dirname "$0")" && pwd)"
AGENT="$SCRIPT_DIR/masterdns-ddns"
INSTALLER="$SCRIPT_DIR/install.sh"
TEST_ROOT="$(mktemp -d /tmp/masterdns-agent-test.XXXXXX)"
FAKE_BIN="$TEST_ROOT/bin"
CONFIG="$TEST_ROOT/config"
CAPTURE="$TEST_ROOT/payload.json"
ARGS="$TEST_ROOT/curl.args"

cleanup() {
  case "$TEST_ROOT" in
    /tmp/masterdns-agent-test.*) rm -rf "$TEST_ROOT" ;;
  esac
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir "$FAKE_BIN"
cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/sh
case "$*" in
  *api.ipify.org*|*api6.ipify.org*) exit 22 ;;
esac
cat > "$CAPTURE_PATH"
printf '%s\n' "$*" > "$ARGS_PATH"
printf '{}'
EOF
chmod 0755 "$FAKE_BIN/curl"

write_config() {
  test_url="$1"
  test_allowance="$2"
  test_ipv4="${3:-}"
  test_ipv6="${4:-}"
  {
    printf "MASTERDNS_API_URL='%s'\n" "$test_url"
    printf "MASTERDNS_ALLOW_INSECURE_LOOPBACK='%s'\n" "$test_allowance"
    printf "MASTERDNS_RUNTIME_TOKEN='%s'\n" 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    [ -z "$test_ipv4" ] || printf "MASTERDNS_IPV4='%s'\n" "$test_ipv4"
    [ -z "$test_ipv6" ] || printf "MASTERDNS_IPV6='%s'\n" "$test_ipv6"
  } > "$CONFIG"
}

run_agent() {
  CAPTURE_PATH="$CAPTURE" \
  ARGS_PATH="$ARGS" \
  MASTERDNS_DDNS_CONFIG="$CONFIG" \
  PATH="$FAKE_BIN:$PATH" \
    sh "$AGENT" >/dev/null
}

sh -n "$INSTALLER"
sh -n "$AGENT"

if installer_output="$(sh "$INSTALLER" install --token secret 2>&1)"; then
  fail "installer accepted --token"
fi
case "$installer_output" in
  *'no longer accepted'*) ;;
  *) fail "installer did not explain the secure token prompt" ;;
esac
grep -Fq -- "--data '{}'" "$INSTALLER" || fail "uninstall revoke must send a valid JSON body"
if grep -Fq '. "$CONFIG_FILE"' "$AGENT"; then
  fail "Agent must not execute its config file as shell code"
fi

stage_line="$(grep -n '^stage_agent$' "$INSTALLER" | tail -n 1 | cut -d: -f1)"
prompt_line="$(grep -n '^read_install_token$' "$INSTALLER" | tail -n 1 | cut -d: -f1)"
[ -n "$stage_line" ] && [ -n "$prompt_line" ] && [ "$stage_line" -lt "$prompt_line" ] || {
  fail "installer must download and validate the Agent before reading the install token"
}

write_config 'https://masterdns.example.test' false
run_agent
python3 - "$CAPTURE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    payload = json.load(stream)
assert "ipv4" not in payload
assert "ipv6" not in payload
assert payload["agentVersion"] == "1.1.0"
PY
grep -Fq -- '--proto =https' "$ARGS" || fail "HTTPS curl protocol restriction was not applied"

write_config 'http://localhost:3000' true '192.0.2.10' '2001:db8::10'
run_agent
python3 - "$CAPTURE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    payload = json.load(stream)
assert payload["ipv4"] == "192.0.2.10"
assert payload["ipv6"] == "2001:db8::10"
PY
grep -Fq -- '--proto =http' "$ARGS" || fail "loopback HTTP curl protocol restriction was not applied"
grep -Fq -- '--noproxy *' "$ARGS" || fail "loopback HTTP must bypass every configured proxy"

write_config 'http://localhost:3000' false '192.0.2.10'
if run_agent 2>/dev/null; then
  fail "loopback HTTP worked without explicit allowance"
fi

write_config 'http://masterdns.example.test' true '192.0.2.10'
if run_agent 2>/dev/null; then
  fail "non-loopback HTTP was accepted"
fi

write_config 'https://masterdns.example.test?' false '192.0.2.10'
if run_agent 2>/dev/null; then
  fail "an API URL with an empty query delimiter was accepted"
fi

echo "MasterDNS DDNS Agent script tests passed"
