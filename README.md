# Claude-Plugins

Claude Code plugins and mods, one folder each under `plugins/`. The repository is also a plugin
marketplace named `leehogwang-plugins`, so any plugin here installs with two commands.

## Plugins

| Plugin | What it does | Command |
| --- | --- | --- |
| [summary](plugins/summary) | Summarizes the session you are in, in a side pane: goal, what got done, decisions, what is in progress, what is open, ideas proposed but never built (todo), what to remember, files touched | `/summary` |
| [see-parent](plugins/see-parent) | After `/fork`, keeps the session you forked from open in a pane: its conversation, and an input that runs your message as a prompt in that session | `/parent` |
| [call](plugins/call) | Lists the AI CLIs installed here (claude, codex, agy, opencode) and opens the one you pick in a side pane, in the folder you work in. Run several at once and switch between them | `/call` |
| [replay-theater](plugins/replay-theater) | Records the file edits Claude makes in a turn, then lets you step through them one diff at a time. From [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater) (Apache-2.0), copied here unchanged | `/replay` |
| [filetree](https://github.com/data-goblin/claude-code-filetree) (external) | IDE-style file tree pane with git status, and shimmer on files Claude reads, writes and commits. Installed from its own repo by `install.sh` | `/filetree` |

## Install

```sh
git clone git@github.com:leehogwang/Claude-Plugins.git ~/Claude-Plugins
~/Claude-Plugins/install.sh
```

`install.sh` is safe to re-run. It adds this repo as a marketplace (from the local clone, so keep the clone
where it is), installs every plugin listed in `.claude-plugin/marketplace.json` plus the external ones listed
in `EXTERNAL` at the top of the script, then checks that each one shows up in `claude plugin list`.
Restart Claude Code (or run `/reload-plugins`) afterwards.

Try one without installing: `claude --plugin-dir ~/Claude-Plugins/plugins/summary`

## When each one runs

- `summary`: only when you type `/summary`. Nothing runs on its own and no model call is made until then.
- `see-parent`: opens its pane by itself right after `/fork`. Otherwise only on `/parent`.
- `call`: only on `/call` (`/call codex` opens one directly). Each message runs one turn of that CLI; nothing runs until you write.
- `replay-theater`: records edits quietly during each turn (it never blocks or changes them); the replay opens on `/replay` or the hint above the prompt.
- `filetree`: closed at session start (`install.sh` sets "Open at start" to off); the pane opens only with `/filetree`.

## Panes come back

`summary`, `see-parent` and `call` remember, per session, that their pane was open. Leave a session and enter it again (resume) and they open again by
themselves there (a session where you never opened one stays as it was); close one by hand and it stays closed next time. `call` also brings back its chats and the ids that continue each CLI's conversation, `summary` its
summary, and `see-parent` its original session. `filetree` is not one of these: it opens only with `/filetree` (see above), and `replay-theater` is drawn per turn.

## summary

- `/summary` opens a pane with the summary of the current session.
- The first run sends the whole conversation (your prompts and everything Claude wrote; no tool output) to Haiku once.
- Later runs send only what came after the last summary, together with that summary.
- Nothing new since the last run: no model call at all.
- The pane shows how many tokens the last update used.
- Needs Claude Code 2.1.287 or newer (mods), and `python3` on `PATH`.

## see-parent

- `/fork` starts a new session as a copy of the one you are in; the original keeps running.
  In the fork, the pane opens on the original: the fork finds it by the messages it copied from it.
- The pane shows the original's conversation (prompts and Claude's words), read again every 3 seconds.
- Type in the pane's input and press Enter:
  - the original still running: your text goes to it as a message from another session (it reads it
    as such, not as your own prompt), and its answer shows up in the pane;
  - the original stopped: your text runs in it as your prompt (`claude -p --resume <id> "<text>"`),
    and the reply streams into the pane.
- Nothing runs, and nothing is spent, until you write to it.
- `/parent` reopens the pane; `/parent <session id>` opens any session the same way.
- "Open in terminal" shows `claude --resume <id>`, to open the original as a full Claude Code elsewhere.
- A tool the original needs approval for cannot be approved from the pane; open it in a terminal.

## call

- `/call` finds which of claude, codex, agy and opencode are installed and opens a pane with a tab for each.
- Type in the pane: the CLI runs one non-interactive turn (`claude -p`, `codex exec`, `agy -p`, `opencode run`) in the
  folder the session works in, and the next message continues the same conversation by its id.
- Each CLI keeps its own chat and works on its own: start a task in codex, switch to claude, come back later (a blue tab means it is working).
- The conversation of the Claude Code session you are in goes along: the first message to a CLI carries it as a file to read
  (`~/.cache/claude-call/`). Every later message brings what happened in Claude Code since that CLI's last turn, so a CLI called
  earlier is up to date the next time you ask it: your prompts, what you ran in your terminal, Claude's words, the commands Claude
  ran, and every file it changed as a complete diff (no tool output). It is delivered with your next message to that CLI, not pushed while it idles.
  Nothing is cut: the whole conversation goes, and every diff goes whole in its own file. In a git folder the diffs also cover what a shell
  command, another AI or an editor changed (the working tree is snapshotted each turn and diffed against the last snapshot; the first
  turn diffs it against HEAD), not only Claude's Edit/Write. Once the conversation given to a CLI since it last summarised adds up to about
  60,000 characters (counted over turns, not per turn), the CLI is told at the start of its turn to write a short summary of it and work
  from that, adding to the notes it already has. The diffs are never summarised.
  If the conversation cannot be read, nothing is sent: the pane says so and offers `↻ retry`.
- What the pane shows for effort is what runs: with none chosen it is medium (else the lowest level the CLI has), and that is sent.
- You see the work on the way (commands, files read or changed, remarks between steps) while a CLI works. When it is done the steps
  fold into one line (`▸ N steps`, click to unfold) above the answer, which is drawn as markdown.
- Several CLIs work at once: ask agy, switch to codex and ask it too; neither is interrupted. A CLI that finishes while another tab is
  shown gets a yellow tab until you open it.
- **Jump buttons:** a small `▼` in the top right corner of the pane scrolls it to its end, a small `▲` in the bottom right corner to its start. They sit in place like the tabs (they scroll with the pane, they do not follow you).
- **Narrow pane:** the pane is narrower than a terminal, so a table too wide for it (markdown with `|`, or drawn with box characters) is shown as a list, one item per row and one sub-item per column; narrow tables stay as they are. Agents are also told the pane width and asked not to draw box tables.
- **Permission first:** every message to an agent starts with a ground rule: before changing code or files, running a command that
  changes something, or doing anything hard to undo, say the plan and wait for your go-ahead (your next message answers). Reading and
  explaining need none. The CLIs run in yolo mode, so this rule in the prompt is the only gate; it is a request the model follows, not a lock.
- **File flags:** the files an agent is changing show in the pane (`✎ dir/file.py  codex`), set as its steps stream in and lifted when its
  turn ends. Two agents on one file show a red `⚠`. Agents are told which files others hold when you message them, and the Claude Code
  session itself is refused an Edit or Write on a flagged file (its own edits are flagged for the agents too, until its turn ends).
  Limits: an agent's own write cannot be stopped from here, and codex reports a change only after it is made.
- Every CLI has its own **model** and **effort**, shown above the input, at its right (with **clear**, which empties this tab's chat). **model** is a dropdown: click it (or focus it and press Enter), then click a model;
  **effort** steps with the ◀ ▶ arrows around its name (`low` … `max`). The colour says it at a glance:
  effort runs from light red (low) to a deeper red (max). agy lists each model once (Gemini 4 Argon, Gemini 3.8 Flash,
  Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B) and offers only the efforts that model has; the two are joined into agy's own id
  when it runs. Typing `/model` or `/effort` in the pane lists the choices; `/model <name>`, `/effort <level>` and `default` set and clear them.
- It is a chat, not a terminal: slash commands, the full-screen UI, approval prompts and Esc do not work in the pane.
  A turn cannot ask you to approve a tool, so every CLI runs in yolo mode: no approval prompts, no sandbox where the CLI has one
  (`--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`, opencode `--auto`). They can edit files and run commands in the working folder without asking. "Open in terminal" shows the
  command that continues the same conversation in a real terminal (`claude --resume <id>`, `codex resume <id>`, ...).
- codex only runs in a git repository (its own rule).

---

## For AI agents

This section is written for an AI coding agent (Claude Code or similar) working in this repository or
installing from it. Follow it as instructions.

### Repository layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per plugin
plugins/<name>/                   one plugin per folder
install.sh                        one-shot setup of everything below
  .claude-plugin/plugin.json      its manifest (name, version, description, author, types)
  hooks/hooks.json                {"modules": ["./register.tsx"]} for a mod
  hooks/register.tsx              the hooks module: export const register: Register = on => { ... }
  hooks/*                         anything else the module uses (e.g. extract.py for summary)
  types/index.d.ts                its $.state contract, when it keeps state
  tests/*.test.ts                 tests run by `claude plugin test`
```

### Typical flow

1. The user hands this repository to you.
2. You run `./install.sh` from the repository root.
3. You check it passed (every line `ok`), then tell the user what was installed, how to use each one
   (the command in the Plugins table and the "When each one runs" notes), and to restart Claude Code.
4. When you add a new mod later, you add it to `install.sh`'s scope (below), run `./install.sh` to verify it,
   and only then tell the user how to use it.

### To install everything for the user

Run `./install.sh`. Do not also pass the same folder with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`; the
plugin would load twice. If a line says `MISSING`, run `claude plugin install <name>@<marketplace>` to see
the real error before reporting.

### To add a new plugin

1. Create `plugins/<name>/` with the layout above. `<name>` uses letters, digits, `-`, `_`, `.` only.
2. Add an entry to `.claude-plugin/marketplace.json`:
   `{ "name": "<name>", "source": "<name>", "description": "<one line>" }`
   (`source` is a bare folder name: `metadata.pluginRoot` is `./plugins`).
3. Make sure `install.sh` installs it. A plugin of this repo is picked up automatically from `marketplace.json`.
   A plugin from another repo goes into the `EXTERNAL` array at the top of `install.sh`
   (`"<github owner/repo> <plugin>@<marketplace name>"`). Every new mod must be reachable through `install.sh`.
4. Add a row for it to the Plugins table in this README, and a line to "When each one runs".
   **Always document how to use it and where it is useful**: the command or trigger, what it shows, and when to reach for it.
5. Check before committing, from the repository root and from the plugin folder:
   - `claude plugin validate .` (marketplace) and `claude plugin validate plugins/<name>` (plugin)
   - `claude plugin test plugins/<name>` (its tests must pass, if it has tests)
   - run `./install.sh` and confirm the new plugin shows `ok`
6. Tell the user the usage and use cases you wrote in step 4 once the check passes.
7. Do not commit `plugins/*/.claude-plugin/types/` or `plugins/*/tsconfig.json`: Claude Code writes them
   each time it loads a mod (`.gitignore` already excludes them).

### To change a plugin

- Bump `version` in its `.claude-plugin/plugin.json` when behaviour changes, so installed copies update.
- Keep its tests passing; add one for the behaviour you change.
- A change to the `summary` summary prompt (`SYSTEM` in `plugins/summary/hooks/register.tsx`) must also bump
  the store key (`summary:vN:`, now v10) so old summaries made with the previous prompt are not reused.

### Rules for this repository

- Commits are authored by the repository owner. Do not add `Co-Authored-By` lines or other AI attribution
  to commit messages.
- Do not put secrets, tokens or personal paths in any file here.
- Plugins must not modify the user's project files unless that is their stated purpose.
