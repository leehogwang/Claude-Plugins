#!/usr/bin/env bash
# One-shot setup: installs every plugin in this repo (read from .claude-plugin/marketplace.json)
# plus the external ones listed in EXTERNAL below. Safe to re-run.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKET=leehogwang-plugins
# "<marketplace source> <plugin>@<marketplace name>"  (add a line per external plugin)
EXTERNAL=(
  "data-goblin/claude-code-filetree filetree@claude-code-filetree"
)

command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found (summary and see-parent need it)"; exit 1; }
echo "Claude Code $(claude --version)  (mods need 2.1.287 or newer; run 'claude update' if older)"

fail=0
add_market() { claude plugin marketplace add "$1" >/dev/null 2>&1 || claude plugin marketplace update >/dev/null 2>&1 || true; }
install() { claude plugin install "$1" --scope user >/dev/null 2>&1 || claude plugin update "$1" >/dev/null 2>&1 || true; }

# this repo is added from the local clone, so unpushed plugins install too; keep the clone where it is
add_market "$ROOT"
wanted=($(python3 -c "import json,sys;[print(p['name']+'@$MARKET') for p in json.load(open('$ROOT/.claude-plugin/marketplace.json'))['plugins']]"))
for e in "${EXTERNAL[@]}"; do set -- $e; add_market "$1"; wanted+=("$2"); done
for p in "${wanted[@]}"; do install "$p"; done
# settings of external plugins: filetree stays closed until you run /filetree
echo '{"start":"off"}' | claude plugin configure filetree@claude-code-filetree --values-stdin >/dev/null 2>&1 || true

echo; echo "Verifying"
installed="$(claude plugin list 2>&1)"
for p in "${wanted[@]}"; do
  if grep -q "${p%@*}@${p#*@}" <<<"$installed"; then echo "  ok       $p"; else echo "  MISSING  $p"; fail=1; fi
done
[ $fail = 0 ] && echo "All installed. Restart Claude Code (or /reload-plugins) to load them." || { echo "Some plugins failed; run: claude plugin install <name> to see the error."; exit 1; }
