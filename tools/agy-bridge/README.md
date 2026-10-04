# agy-bridge

Use **Antigravity CLI (`agy`) models — Gemini 3.x, and whatever else `agy models` lists — as the model inside Claude Code**, while keeping every Claude Code feature: its tools, permission prompts, hooks, subagents, `/compact`, `--resume`, Esc-to-interrupt, and the `/model` picker. Claude models keep working exactly as before.

> **한국어 요약** — Claude Code의 `/model`에서 agy(Antigravity CLI) 모델을 고를 수 있게 해 주는 로컬 브리지입니다. Claude 모델 요청은 Anthropic으로 그대로 넘기고, `agy-*` 모델 요청만 상주하는 `agy` 프로세스로 보냅니다. Claude Code의 도구(Read, Edit, Bash, Agent…)는 MCP로 agy에 연결되므로 권한 확인·hook·UI가 그대로 동작합니다. OAuth 토큰이나 API 키를 따로 쓰지 않고 공식 `agy` CLI만 사용합니다. 설치: `./install.sh --test`. AI 에이전트에게 맡길 때는 이 README의 **"Instructions for AI agents"** 절을 따르게 하세요.

Unofficial project, not affiliated with Anthropic or Google. It drives the official `agy` CLI with your own agy login; it never reads or reuses OAuth tokens or API keys. Check that this use fits the terms of the services you use.

---

## How it works

```
Claude Code ──(Anthropic Messages API)──► agy-bridge  127.0.0.1:47821
                                             │
            model = claude-* ────────────────┼──► api.anthropic.com   (byte-for-byte passthrough)
                                             │
            model = agy-<id> ────────────────┴──► one persistent `agy` process per conversation
                                                   (agy --input-format stream-json --output-format stream-json)
                                                         │
     Claude Code executes the tool ◄── tool_use ◄────────┤ agy calls MCP server "cc_cc"
     (permissions, hooks, UI)      ──► tool_result ─────►│ = Claude Code's own tools, served by the bridge
```

* **Routing.** Claude Code is pointed at the bridge with `ANTHROPIC_BASE_URL`. Requests whose `model` starts with `agy-` go to agy; everything else is proxied untouched (your claude.ai login or API key flows through as-is).
* **Tools.** The bridge exposes the tools of each Claude Code request to agy as an MCP server (`cc_cc`, provided by a workspace plugin). When agy calls one, the bridge ends the streamed reply with a `tool_use` block, Claude Code runs the tool itself, and the `tool_result` of the next request is returned to agy's waiting MCP call, so agy's turn simply continues. agy's built-in tools (shell, file edit, browser…) are blocked by a `PreToolUse` hook and by agy's headless permission policy, so agy can only act through Claude Code.
* **History.** Each Claude Code conversation maps to one agy conversation, matched by fingerprints of the messages (ids of tool calls, text). Only new messages are sent. The mapping is saved to disk, so `--resume`, bridge restarts and idle shutdowns continue the same agy conversation (`agy --conversation <id>`). Rewinds, compaction and model switches from Claude start a new agy conversation seeded with the history.
* **Model picker.** On start the bridge runs `agy models` and writes one `/model` row per model into `~/.claude/settings.json` (`modelPicker.options`, ids `agy-<id>`). New agy models show up after a bridge restart.

---

## Requirements

| Need | Check |
|---|---|
| Linux or macOS, bash, `curl` | |
| Python ≥ 3.10 with `httpx`, `starlette`, `uvicorn` (installer adds them with `pip --user`) | `python3 -c 'import httpx, starlette, uvicorn'` |
| Claude Code, logged in (claude.ai subscription or API key) | `claude --version` |
| Antigravity CLI, logged in | `agy models` prints a list of models |
| systemd user session (recommended; otherwise the installer falls back to `nohup`) | `systemctl --user show-environment` |

Tested with Claude Code 2.1.289 and agy 1.2.16.

---

## Install

```bash
git clone https://github.com/leehogwang/Claude-Plugins.git
cd Claude-Plugins/tools/agy-bridge
./install.sh --test      # install, wire up Claude Code, then run the self-test
```

Then start a **new** Claude Code session, open `/model`, and pick a row labelled `agy · …`
(or `claude --model agy-gemini-3.8-flash-high`). Running sessions keep their old settings until restarted.

`./install.sh` is idempotent; re-run it to update after pulling new code.

---

## Instructions for AI agents

Follow these steps in order. Each has a check; do not continue past a failed check.

1. **Prerequisites.** Run `agy models` and `claude --version`.
   * `agy models` must print tab-separated `id<TAB>Name` lines. If it asks to log in, stop and ask the user to run `agy` once and log in (interactive; you cannot do it for them).
2. **Install.** From `tools/agy-bridge/` run `./install.sh --test`.
   * Expected: lines starting with `==>`, ending with `selftest` output `OK` and `==> Done.`
   * The installer changes Claude Code's settings **only after** the bridge answers on `/agy-bridge/health`, so a failed install never breaks Claude Code.
3. **Verify health.** `curl -s http://127.0.0.1:47821/agy-bridge/health` → `{"ok":true,...}`.
4. **Verify Claude models still work through the bridge.** `claude -p "Reply with exactly: ok" --model haiku < /dev/null` → `ok`.
5. **Verify an agy model end to end with a real tool call.**
   ```bash
   cd "$(mktemp -d)" && echo "value=$RANDOM" > probe.txt && cat probe.txt
   claude -p "Read probe.txt with the Read tool and tell me the value." \
          --model agy-<an id from `agy models`> --allowedTools Read < /dev/null
   ```
   The answer must contain the same `value=` number printed by `cat`.
6. **Tell the user** to start a new Claude Code session and choose an `agy ·` row in `/model`.

Rules while working on this setup:

* Never run `agy` with `--dangerously-skip-permissions` for the bridge; the design relies on agy's own tools staying blocked.
* Do not edit `~/.claude/settings.json` `env` by hand while the bridge is down: with `ANTHROPIC_BASE_URL` set and nothing listening, **every** Claude Code request fails, including Claude models. Use `./install.sh --uninstall` to disconnect cleanly.
* Restart the bridge with `systemctl --user restart agy-bridge` (or re-run `./install.sh`). Avoid `pkill -f bridge.py`-style commands from inside an agent shell: the pattern can match the agent's own shell command line and kill it.
* Logs: `~/.local/share/agy-bridge/bridge.log`. agy's own per-conversation transcripts: `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl`.
* When writing test prompts for Gemini, use realistic content. Random word salad or words like "secret"/"token" can trip Gemini's safety filter and look like a bridge failure.

---

## Using it

* **Pick a model:** `/model` → `agy · Gemini 3.8 Flash (High)` etc. Enter makes it the default for new sessions, `s` uses it for this session only.
* **Switch any time** between Claude and agy models within a conversation; the other side receives the history.
* **Everything else is normal Claude Code:** permission prompts, plan mode, hooks, `/compact`, subagents (`Agent` tool, which inherit the agy model), `--resume`, Esc.

---

## What the installer changes

| Where | Change | Undo |
|---|---|---|
| `~/.local/share/agy-bridge/` | `bridge.py`, `selftest.py`, agy workspace `ws/` with the plugin `ws/.agents/plugins/cc/` (MCP config, hooks); at runtime also `sessions.json`, `bridge.log`, `history/`, `images/`, `inject/` | `--uninstall` (`--purge` also deletes state) |
| `~/.config/systemd/user/agy-bridge.service` | user service, `Restart=always`, enabled at login | `--uninstall` |
| `~/.gemini/antigravity-cli/settings.json` | `permissions.allow` += `mcp(cc_cc/*)` and `read_file(...)` for the bridge's `history/`, `images/` and agy's `mcp/cc_cc` schema folder | `--uninstall` |
| `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL=http://127.0.0.1:47821`, `env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`; the bridge maintains `modelPicker.options` rows whose `model` starts with `agy-` | `--uninstall` |

Each JSON file is backed up once as `<file>.bak-before-agy-bridge` before the first edit.

---

## Uninstall

```bash
./install.sh --uninstall           # disconnect Claude Code, stop service, remove rules; keep conversation state
./install.sh --uninstall --purge   # also delete ~/.local/share/agy-bridge
```

---

## Configuration

Environment variables (set them in the systemd unit or before `./install.sh`):

| Variable | Default | Meaning |
|---|---|---|
| `AGY_BRIDGE_PORT` | `47821` | listen port (installer writes it into the unit, plugin and Claude settings) |
| `AGY_BRIDGE_UPSTREAM` | `https://api.anthropic.com` | where non-agy requests go |
| `AGY_BIN` | `agy` on `PATH` | agy executable |
| `AGY_BRIDGE_TEST_MODEL` | first Flash model | model used by `selftest.py` |

Tunables at the top of `bridge.py`: `MAX_LIVE` (agy processes kept at once, ~250 MB each), `IDLE_KILL` / `SUBAGENT_IDLE` (idle shutdown), `MAX_INPUT` (bytes per agy message), `HIST_CLIP` (chars kept per tool result when replaying history), `BEHAVES_AS` (which Claude model profile Claude Code applies to agy rows).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Every Claude Code request fails with a connection error | Bridge not running. `systemctl --user status agy-bridge`, check `bridge.log`, `systemctl --user restart agy-bridge`. To get Claude Code back immediately: `./install.sh --uninstall`. |
| No `agy ·` rows in `/model` | Bridge could not run `agy models` (not logged in?) — see `bridge.log`, then restart the bridge. Rows with an `[1m]` suffix are hidden by Claude Code on plans without 1M context; the bridge does not use that suffix. |
| "Prompt is too long" on a long session after switching to agy | The row's `behavesAs` profile has a small window. Gemini rows use `claude-opus-5-5` (large window); edit `BEHAVES_AS` if your Claude Code version lacks it. |
| Reply says "This request was blocked by Gemini's filters" | Gemini safety filter, not the bridge. Rephrase. |
| `API Error: agy: …` | agy itself failed (quota, auth, model unavailable). Run `agy -p "hi"` in a terminal to see the real message. |
| `agy denied [...]` | agy blocked one of its own tools in headless mode. Expected for its built-in tools; if it is a `read_file` under `~/.local/share/agy-bridge/`, re-run `./install.sh` to restore the allow rules. |
| Bridge stops when you log out | systemd user services stop with the last session: `loginctl enable-linger $USER`. |

---

## Limitations

* **Single point of failure.** All Claude Code traffic, Claude models included, goes through the local bridge while it is installed.
* **Remote Control** is unavailable while `ANTHROPIC_BASE_URL` points to a non-Anthropic host.
* **Quality is the agy model's.** Claude Code's system prompt is written for Claude; other models sometimes ignore instructions, mis-shape tool arguments (Claude Code reports the error and the model retries), or do in sequence what Claude would do in parallel.
* **Esc restarts agy.** agy has no in-band interrupt (SIGINT ends the process), so an interrupted turn restarts agy from the saved conversation (~4 s, done right away so it overlaps with your typing).
* **Parallel tool calls** reach Claude Code together only when the model planned them in the same step; the bridge learns the plan from agy's transcript file (internal format — if it changes, calls simply run one by one).
* **Effort/thinking settings** and token/cost figures in Claude Code are not meaningful for agy models (usage is estimated).
* **Images** are saved under `~/.local/share/agy-bridge/images/` and opened by the model from there (agy's stdin accepts text only).
* Relies on `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, an undocumented Claude Code variable that keeps first-party features on behind a custom base URL. If a Claude Code update drops it, things still work but some first-party-only features may switch off.

---

## Design notes (why it is built this way)

These are the non-obvious facts the code depends on, found by testing; keep them in mind before changing it.

| Fact about agy / Claude Code | Consequence in `bridge.py` |
|---|---|
| `agy -p --input-format stream-json` keeps one conversation open and reads `{"event":"user","message":{"role":"user","content":"..."}}` per line; only text content is accepted. | One long-lived process per conversation; images are saved to files. |
| agy **aborts MCP tool calls after 3 minutes**. Claude Code tools (subagents, long builds, waiting for the user to approve) can take longer. | At 150 s the bridge answers "still running, call `wait_for_result`"; the real result is delivered to that follow-up call. |
| agy **silently truncates a single user message beyond ~200 KB**. | Messages are capped at 150 KB. Longer histories are written to `inject/<session>.json` and inserted as several messages by the plugin's `PreInvocation` hook (`inject.py`, `injectSteps`) right before the model runs. (Replaying history as "reply OK" turns was tried and rejected: Gemini acted on the history and invented results.) |
| agy runs the MCP calls of one model step **one at a time**. | The bridge reads the step's plan from agy's `transcript_full.jsonl`, matched by the step index in the MCP `progressToken`, and sends all planned calls to Claude Code in one reply; later identical calls are answered from those results. |
| agy loads plugins (MCP servers, hooks) from `.agents/plugins/` of its working directory. Headless mode auto-denies tools that need permission unless `settings.json` `permissions.allow` lists them; a hook's `permissionOverrides` does **not** cover MCP calls. | agy runs in `~/.local/share/agy-bridge/ws`, whose plugin `cc` provides the MCP server and hooks; the installer adds narrow allow rules. |
| agy exits on SIGINT and takes ~4 s to start. | Esc = stop and immediately restart with `--conversation`. |
| Claude Code sends `x-claude-code-request-class` (`main`, `subagent`, `compaction`, …) and `x-claude-code-agent-id` headers. | Conversations are matched per agent id; compaction and other one-off requests get a throwaway agy conversation with tools disabled. |
| Claude Code hides `modelPicker` rows with `[1m]` on plans without 1M context, and an unknown model is assumed to have 200k context. | Rows carry `behavesAs` (Gemini → `claude-opus-5-5`) instead of `[1m]`. |
| With a custom `ANTHROPIC_BASE_URL` Claude Code treats the endpoint as third-party and turns some features off, unless `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`. | The installer sets it. Gateway model discovery is skipped in that mode, hence the `modelPicker` rows. |
| agy's MCP client probes `/.well-known/oauth-protected-resource`. | Answered with 404 locally instead of being forwarded to Anthropic. |

## Files

| File | Role |
|---|---|
| `bridge.py` | the bridge (Starlette app): Anthropic API, passthrough, MCP server, session manager |
| `agy-plugin/cc/hook.py` | agy `PreToolUse` hook: allow only `cc_cc` MCP calls and reads of the bridge's folders |
| `agy-plugin/cc/inject.py` | agy `PreInvocation` hook: insert queued long history |
| `agy-plugin/cc/hooks.json`, `plugin.json` | agy plugin manifest and hook wiring (`mcp_config.json` is generated by the installer) |
| `install.sh` | install / update / `--test` / `--uninstall [--purge]` |
| `selftest.py` | speaks the Messages API to the running bridge: tool round trip, interrupt + continue; `--slow` also checks the 3-minute MCP limit |
