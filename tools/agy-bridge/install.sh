#!/usr/bin/env bash
# agy-bridge installer. Idempotent: safe to re-run (also how you update).
#   ./install.sh               install / update, then wire Claude Code to the bridge
#   ./install.sh --test        same, then run selftest.py against the live bridge
#   ./install.sh --uninstall   undo everything (keeps conversation state unless --purge)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HOME/.local/share/agy-bridge"
PLUGIN="$ROOT/ws/.agents/plugins/cc"
PORT="${AGY_BRIDGE_PORT:-47821}"
URL="http://127.0.0.1:$PORT"
UNIT="$HOME/.config/systemd/user/agy-bridge.service"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
AGY_SETTINGS="$HOME/.gemini/antigravity-cli/settings.json"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Edit a JSON file in place with a Python snippet operating on `d` (backup made once).
edit_json() {  # file python-snippet
  local f="$1"
  mkdir -p "$(dirname "$f")"; [ -f "$f" ] || echo '{}' > "$f"
  [ -f "$f.bak-before-agy-bridge" ] || cp "$f" "$f.bak-before-agy-bridge"
  F="$f" python3 - "$2" <<'PY'
import json, os, sys
f = os.environ['F']
d = json.load(open(f))
exec(sys.argv[1])
tmp = f + '.agy-bridge.tmp'
open(tmp, 'w').write(json.dumps(d, indent=2, ensure_ascii=False) + '\n')
os.replace(tmp, f)
PY
}

agy_rules() {  # the agy permission rules the bridge needs, one per line
  echo "mcp(cc_cc/*)"
  echo "read_file($ROOT/history)"
  echo "read_file($ROOT/images)"
  echo "read_file($HOME/.gemini/antigravity-cli/mcp/cc_cc)"
}

uninstall() {
  say "Disconnecting Claude Code from the bridge"
  [ -f "$CLAUDE_SETTINGS" ] && edit_json "$CLAUDE_SETTINGS" "
env = d.get('env', {})
for k in ('ANTHROPIC_BASE_URL', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL'):
    if k == 'ANTHROPIC_BASE_URL' and env.get(k) != '$URL':
        continue   # not ours
    env.pop(k, None)
p = d.get('modelPicker')
if p:
    p['options'] = [o for o in p.get('options', []) if not str(o.get('model', '')).startswith('agy-')]
    if not p['options']:
        d.pop('modelPicker')
if str(d.get('model', '')).startswith('agy-'):
    d.pop('model')
"
  say "Stopping the service"
  systemctl --user disable --now agy-bridge.service 2>/dev/null || true
  rm -f "$UNIT"; systemctl --user daemon-reload 2>/dev/null || true
  say "Removing agy permission rules"
  [ -f "$AGY_SETTINGS" ] && edit_json "$AGY_SETTINGS" "
rules = set('''$(agy_rules)'''.split())
a = d.get('permissions', {}).get('allow', [])
d.setdefault('permissions', {})['allow'] = [r for r in a if r not in rules]
"
  if [ "${1:-}" = "--purge" ]; then rm -rf "$ROOT"; say "Removed $ROOT"
  else rm -rf "$ROOT/ws" "$ROOT"/*.py; say "Kept conversation state in $ROOT (use --uninstall --purge to delete)"; fi
  say "Uninstalled. Restart open Claude Code sessions."
}

if [ "${1:-}" = "--uninstall" ]; then uninstall "${2:-}"; exit 0; fi

say "Checking requirements"
PY="$(command -v python3)" || die "python3 not found"
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || die "python3 >= 3.10 required"
command -v claude >/dev/null || die "Claude Code (claude) not found in PATH"
AGY="$(command -v agy || true)"
if [ -z "$AGY" ] && [ -x "$HOME/.local/bin/agy" ]; then AGY="$HOME/.local/bin/agy"; fi
[ -n "$AGY" ] || die "agy (Antigravity CLI) not found"
"$AGY" models >/dev/null 2>&1 || die "'agy models' failed - log in to agy first (run: agy)"
if ! "$PY" -c 'import httpx, starlette, uvicorn' 2>/dev/null; then
  say "Installing Python packages: httpx starlette uvicorn"
  "$PY" -m pip install --user --quiet httpx starlette uvicorn || "$PY" -m pip install --user --quiet --break-system-packages httpx starlette uvicorn
fi

say "Installing files into $ROOT"
mkdir -p "$PLUGIN"
install -m 644 "$SRC/bridge.py" "$SRC/selftest.py" "$ROOT/"
install -m 644 "$SRC"/agy-plugin/cc/{plugin.json,hooks.json,hook.py,inject.py} "$PLUGIN/"
printf '{"mcpServers":{"cc":{"url":"%s/mcp"}}}\n' "$URL" > "$PLUGIN/mcp_config.json"

say "Allowing the bridge's MCP server and read-only folders in agy ($AGY_SETTINGS)"
edit_json "$AGY_SETTINGS" "
a = d.setdefault('permissions', {}).setdefault('allow', [])
for r in '''$(agy_rules)'''.split():
    if r not in a:
        a.append(r)
"

say "Starting the bridge"
if systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=agy-bridge: agy (Antigravity CLI) models for Claude Code
After=network-online.target

[Service]
ExecStart=$PY %h/.local/share/agy-bridge/bridge.py
Environment=PATH=$(dirname "$AGY"):%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=AGY_BRIDGE_PORT=$PORT
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable agy-bridge.service >/dev/null 2>&1
  systemctl --user restart agy-bridge.service
else
  say "No systemd user session: starting with nohup (add this to your login script to keep it running)"
  echo "  AGY_BRIDGE_PORT=$PORT nohup $PY $ROOT/bridge.py >/dev/null 2>&1 &"
  pkill -f "$ROOT/bridge.py" 2>/dev/null || true
  AGY_BRIDGE_PORT=$PORT nohup "$PY" "$ROOT/bridge.py" >/dev/null 2>&1 &
fi
for _ in $(seq 1 30); do curl -fsS "$URL/agy-bridge/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$URL/agy-bridge/health" >/dev/null || die "bridge did not come up - see $ROOT/bridge.log (Claude Code was NOT changed)"

say "Pointing Claude Code at the bridge ($CLAUDE_SETTINGS)"
edit_json "$CLAUDE_SETTINGS" "
d.setdefault('env', {}).update({'ANTHROPIC_BASE_URL': '$URL', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL': '1'})
"
for _ in $(seq 1 30); do grep -q '"agy-' "$CLAUDE_SETTINGS" && break; sleep 1; done   # bridge fills /model picker
grep -q '"agy-' "$CLAUDE_SETTINGS" || say "warning: agy models not in /model yet - check $ROOT/bridge.log"

if [ "${1:-}" = "--test" ]; then say "Running selftest"; "$PY" "$ROOT/selftest.py"; fi

say "Done. Start a NEW Claude Code session and pick an 'agy ·' model in /model."
command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "no" ] && \
  echo "   Tip: 'loginctl enable-linger $USER' keeps the bridge running while you are logged out."
exit 0
