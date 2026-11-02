import sys, os, json, glob, re, html, difflib, subprocess, shutil, time

# <session id> <from record> <cli> [<previous snapshot>]: writes the Claude Code conversation from record `from` on to a text file and
# prints {"records": N, "path": "<conversation file>", "diffs": "<diff file>", "chars": N, "notes": "<notes file>",
# "snap": "<new snapshot>", "errors": [...]}
# (a path is empty when there is nothing new). Every prompt, what the person ran in their terminal, and everything
# Claude wrote (no tool output) go to the conversation file; every file change goes to the diff file, whole: nothing
# is cut. (If the conversation is long, the AI that reads it is told to summarise it; the diffs are never summarised.)

def prompt_of(m):
    if m.get('type') != 'user' or m.get('isMeta') or m.get('isSidechain'): return None
    c = (m.get('message') or {}).get('content')
    if isinstance(c, list):
        c = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    if not isinstance(c, str) or not c.strip(): return None
    cmd = re.search(r'<command-name>(.*?)</command-name>.*?<command-args>(.*?)</command-args>', c, re.S)
    if cmd:
        if cmd.group(1) in ('/clear', '/model', '/effort', '/config', '/status', '/cost', '/exit', '/resume'): return None
        return f'{cmd.group(1)} {cmd.group(2)}'.strip()
    sh = re.search(r'<bash-input>(.*?)</bash-input>', c, re.S)
    if sh: return 'ran in their terminal: ' + sh.group(1).strip()
    out = re.search(r'<bash-stdout>(.*?)</bash-stdout>\s*<bash-stderr>(.*?)</bash-stderr>', c, re.S)
    if out:
        t = html.unescape(re.sub(r'\x1b\[[0-9;]*m', '', (out.group(1) + out.group(2)).strip()))
        return 'its output: ' + (t if t else '(nothing)')
    if c.startswith('<'): return None
    return re.sub(r'<pasted_content.*?</pasted_content[^>]*>', '[pasted text]', c, flags=re.S).strip()

def diff(path, old, new):
    d = list(difflib.unified_diff(old.splitlines(), new.splitlines(), 'before', 'after', lineterm='', n=1))[2:]
    return f'(edited {path})\n```diff\n' + '\n'.join(d) + '\n```'

# what Claude changed or ran: files as diffs, commands as they were typed (no tool output)
def change_of(name, i):
    p = i.get('file_path')
    if name == 'Edit' and p: return [(p, diff(p, i.get('old_string', ''), i.get('new_string', '')))]
    if name == 'MultiEdit' and p: return [(p, diff(p, e.get('old_string', ''), e.get('new_string', ''))) for e in i.get('edits', [])]
    if name == 'Write' and p:
        body = (i.get('content') or '').splitlines()
        return [(p, f'(wrote {p}, {len(body)} lines)\n```\n' + '\n'.join(body) + '\n```')]
    if name == 'Bash' and i.get('command'): return [(None, '(ran) ' + i['command'].strip())]
    return []


BIG = 300_000   # a file larger than this is not diffed, only named
MANY = 3000     # more changed files than this: not snapshotted

def git(cwd, *a):
    return subprocess.run(['git', '-C', cwd, *a], capture_output=True, text=True, errors='replace', timeout=60)

# What changed in the working tree by any means (a shell command, another AI, an editor): the transcript only shows Edit/Write.
# Each turn keeps a copy of every file that differs from git's HEAD; the next turn diffs against that copy.
def snapshot(cwd, d, session, cli, prev, covered):
    r = git(cwd, 'rev-parse', '--show-toplevel')
    if r.returncode: return None, '', [], []        # not a git folder: only the transcript's diffs
    root = r.stdout.strip()
    head = git(root, 'rev-parse', '--verify', '-q', 'HEAD').returncode == 0
    names = set(git(root, 'ls-files', '-o', '--exclude-standard', '-z').stdout.split('\0'))
    if head: names |= set(git(root, 'diff', '--name-only', '-z', 'HEAD').stdout.split('\0'))
    names.discard('')
    if len(names) > MANY: return root, '', [], [f'{len(names)} changed files: too many to snapshot, the working tree changes are not included']
    def read(rel):  # text, or None if it is binary or too big
        p = os.path.join(root, rel)
        if not os.path.isfile(p): return ''
        if os.path.getsize(p) > BIG: return None
        b = open(p, 'rb').read()
        return None if b'\0' in b[:8000] else b.decode('utf-8', 'replace')
    def head_text(rel):
        r = git(root, 'show', f'HEAD:{rel}') if head else None
        return r.stdout if r is not None and r.returncode == 0 else ''
    base = f'{d}/snap'
    tag = str(int(time.time() * 1000))
    new = f'{base}/{session}-{cli}-{tag}'
    old = f'{base}/{session}-{cli}-{prev}' if prev else ''
    have_old = bool(old) and os.path.isdir(old)
    stored = set()
    if have_old:
        for dp, _, fs in os.walk(old):
            for fn in fs: stored.add(os.path.relpath(os.path.join(dp, fn), old))
    out, notes, now = [], [], {}
    for rel in sorted(names | stored):
        cur = read(rel)
        if cur is None:
            notes.append(f'(changed, but binary or too large to diff: {rel})')
            continue
        now[rel] = cur
        if have_old: before = open(os.path.join(old, rel), encoding='utf-8', errors='replace').read() if rel in stored else head_text(rel)
        elif os.path.join(root, rel) in covered: continue
        else: before = head_text(rel)
        if before == cur: continue
        body = '\n'.join(difflib.unified_diff(before.splitlines(), cur.splitlines(), f'a/{rel}', f'b/{rel}', lineterm='', n=1))
        out.append(f'(changed {rel})\n```diff\n{body}\n```')
    for rel in names:
        if rel in now and rel in names:
            p = os.path.join(new, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, 'w', encoding='utf-8').write(now[rel])
    os.makedirs(new, exist_ok=True)
    for dn in glob.glob(f'{base}/{session}-{cli}-*'):   # older ones are not needed any more
        if dn not in (new, old): shutil.rmtree(dn, ignore_errors=True)
    return root, tag, out, notes

def main(session, start, cli, prev=''):
    found = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{session}.jsonl'))
    if not found: sys.exit(f'no transcript for session {session}')
    path = max(found, key=os.path.getmtime)
    parts, changes, n, cwd, covered = [], [], 0, '', set()
    with open(path, encoding='utf-8', errors='replace') as f:
        for n, line in enumerate(f, 1):
            if n <= start: continue
            try: m = json.loads(line)
            except ValueError: continue
            cwd = m.get('cwd') or cwd
            q = prompt_of(m)
            if q:
                parts.append('USER: ' + q)
                continue
            if m.get('type') != 'assistant' or m.get('isSidechain'): continue
            for x in (m.get('message') or {}).get('content', []) or []:
                if not isinstance(x, dict): continue
                if x.get('type') == 'text' and x.get('text', '').strip(): parts.append('CLAUDE: ' + x['text'].strip())
                if x.get('type') == 'tool_use':
                    for p, c in change_of(x['name'], x.get('input') or {}):
                        changes.append((p, c))
                        if p: covered.add(p)
                        parts.append(f'  [change {len(changes)}: {c.splitlines()[0]}, in full in the diff file]')
    d = os.path.expanduser('~/.cache/claude-call'); os.makedirs(d, exist_ok=True)
    errors, tag, extra, notes_ = [], '', [], []
    try:
        root, tag, extra, notes_ = snapshot(cwd or os.getcwd(), d, session, cli, prev, covered)
        if root and prev and os.path.isdir(f'{d}/snap/{session}-{cli}-{prev}'):
            # the snapshot saw every file change since last turn: the transcript's diffs of files in this repo would repeat it
            changes = [(p, c) for p, c in changes if not (p and p.startswith(root + os.sep))]
    except Exception as e:
        errors.append(f'working tree changes: {e}')
    text = '\n\n'.join(parts)
    out = dout = ''
    all_changes = [c for _, c in changes] + extra + notes_
    if text:
        out = f'{d}/{session}-{cli}-{start}.md'
        with open(out, 'w', encoding='utf-8') as f: f.write(text + '\n')
    if all_changes:
        dout = f'{d}/{session}-{cli}-{start}.diff.md'
        with open(dout, 'w', encoding='utf-8') as f: f.write('\n\n'.join(f'## change {k}\n{c}' for k, c in enumerate(all_changes, 1)) + '\n')
    print(json.dumps(dict(records=n, path=out, diffs=dout, chars=len(text), notes=f'{d}/{session}-{cli}-notes.md', snap=tag, errors=errors)))

if __name__ == '__main__':
    main(*sys.argv[1:2], int(sys.argv[2]), *sys.argv[3:5])
