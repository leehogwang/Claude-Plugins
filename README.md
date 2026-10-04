# Claude-Plugins

Claude Code plugins and mods, one folder each under `plugins/`. The repository is also a plugin
marketplace named `leehogwang-plugins`, so any plugin here installs with two commands.

## Plugins

| Plugin | What it does | Command |
| --- | --- | --- |
| [history](plugins/history) | Summarizes the session you are in, in a side pane: goal, what got done, decisions, what is in progress, what is open, ideas proposed but never built (todo), what to remember, files touched | `/history` |
| [fork-origin](plugins/fork-origin) | After `/fork`, keeps the session you forked from open in a pane: its conversation, and an input that runs your message as a prompt in that session | `/origin` |

## Tools

Programs that change how Claude Code runs rather than plugins; each has its own installer and README.

| Tool | What it does | Install |
| --- | --- | --- |
| [agy-bridge](tools/agy-bridge) | Use Antigravity CLI (`agy`) models such as Gemini 3.x as the model in Claude Code, from `/model`, with all Claude Code tools and features; Claude models keep working | `tools/agy-bridge/install.sh` |

## Install

```sh
claude plugin marketplace add leehogwang/Claude-Plugins
claude plugin install history@leehogwang-plugins
claude plugin install fork-origin@leehogwang-plugins
```

Then start Claude Code again (or run `/reload-plugins` in a session).

Try one without installing:

```sh
git clone https://github.com/leehogwang/Claude-Plugins.git
claude --plugin-dir Claude-Plugins/plugins/history
```

## history

- `/history` opens a pane with the summary of the current session.
- The first run sends the whole conversation (your prompts and everything Claude wrote; no tool output) to Haiku once.
- Later runs send only what came after the last summary, together with that summary.
- Nothing new since the last run: no model call at all.
- The pane shows how many tokens the last update used.
- Needs Claude Code 2.1.287 or newer (mods), and `python3` on `PATH`.

## fork-origin

- `/fork` starts a new session as a copy of the one you are in; the original keeps running.
  In the fork, the pane opens on the original: the fork finds it by the messages it copied from it.
- The pane shows the original's conversation (prompts and Claude's words), read again every 3 seconds.
- Type in the pane's input and press Enter:
  - the original still running: your text goes to it as a message from another session (it reads it
    as such, not as your own prompt), and its answer shows up in the pane;
  - the original stopped: your text runs in it as your prompt (`claude -p --resume <id> "<text>"`),
    and the reply streams into the pane.
- Nothing runs, and nothing is spent, until you write to it.
- `/origin` reopens the pane; `/origin <session id>` opens any session the same way.
- "터미널에서 열기" shows `claude --resume <id>`, to open the original as a full Claude Code elsewhere.
- A tool the original needs approval for cannot be approved from the pane; open it in a terminal.

---

## For AI agents

This section is written for an AI coding agent (Claude Code or similar) working in this repository or
installing from it. Follow it as instructions.

### Repository layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per plugin
plugins/<name>/                   one plugin per folder
tools/<name>/                     standalone tools (not plugins, not in marketplace.json); see their README
  .claude-plugin/plugin.json      its manifest (name, version, description, author, types)
  hooks/hooks.json                {"modules": ["./register.tsx"]} for a mod
  hooks/register.tsx              the hooks module: export const register: Register = on => { ... }
  hooks/*                         anything else the module uses (e.g. extract.py for history)
  types/index.d.ts                its $.state contract, when it keeps state
  tests/*.test.ts                 tests run by `claude plugin test`
```

### To install a plugin for the user

1. Run `claude plugin marketplace add leehogwang/Claude-Plugins` (once per machine).
2. Run `claude plugin install <plugin>@leehogwang-plugins`.
3. Tell the user to restart Claude Code or run `/reload-plugins`, then the plugin's command (see the table above).
4. Do not also list the same folder in `CLAUDE_CODE_PLUGIN_DIRS` or pass it with `--plugin-dir`; the plugin would load twice.

### To install a tool for the user

Read `tools/<name>/README.md` and follow its "Instructions for AI agents" section. Tools are not plugins:
do not add them to `marketplace.json` and do not install them with `claude plugin install`.

### To add a new plugin

1. Create `plugins/<name>/` with the layout above. `<name>` uses letters, digits, `-`, `_`, `.` only.
2. Add an entry to `.claude-plugin/marketplace.json`:
   `{ "name": "<name>", "source": "<name>", "description": "<one line>" }`
   (`source` is a bare folder name: `metadata.pluginRoot` is `./plugins`).
3. Add a row for it to the Plugins table in this README and, if it needs one, a short section like `## history`.
4. Check before committing, from the repository root and from the plugin folder:
   - `claude plugin validate .` (marketplace) and `claude plugin validate plugins/<name>` (plugin)
   - `claude plugin test plugins/<name>` (its tests must pass)
5. Do not commit `plugins/*/.claude-plugin/types/` or `plugins/*/tsconfig.json`: Claude Code writes them
   each time it loads a mod (`.gitignore` already excludes them).

### To change a plugin

- Bump `version` in its `.claude-plugin/plugin.json` when behaviour changes, so installed copies update.
- Keep its tests passing; add one for the behaviour you change.
- A change to the `history` summary prompt (`SYSTEM` in `plugins/history/hooks/register.tsx`) must also bump
  the store key (`summary:vN:`) so old summaries made with the previous prompt are not reused.

### Rules for this repository

- Commits are authored by the repository owner. Do not add `Co-Authored-By` lines or other AI attribution
  to commit messages.
- Do not put secrets, tokens or personal paths in any file here.
- Plugins must not modify the user's project files unless that is their stated purpose.
