import sys, os, json, glob, re, html, difflib

# <session id> <from record> <cli>: writes the Claude Code conversation from record `from` on to a text file and
# prints {"records": N, "path": "<file>"} ("path" empty when there is nothing new). Every prompt, what the person
# ran in their terminal, and everything Claude wrote (no tool output), so another AI can read it as background.
CAP = 400_000  # characters kept (the latest ones)
DIFF = 60      # lines kept of one diff

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
    if sh: return 'ran in their terminal: ' + sh.group(1).strip()[:300]
    out = re.search(r'<bash-stdout>(.*?)</bash-stdout>\s*<bash-stderr>(.*?)</bash-stderr>', c, re.S)
    if out:
        t = html.unescape(re.sub(r'\x1b\[[0-9;]*m', '', (out.group(1) + out.group(2)).strip()))
        return 'its output: ' + (t[-400:] if t else '(nothing)')
    if c.startswith('<'): return None
    return re.sub(r'<pasted_content.*?</pasted_content[^>]*>', '[pasted text]', c, flags=re.S).strip()

def diff(path, old, new):
    d = list(difflib.unified_diff(old.splitlines(), new.splitlines(), 'before', 'after', lineterm='', n=1))[2:]
    more = f'\n... ({len(d) - DIFF} more lines)' if len(d) > DIFF else ''
    return f'  (edited {path})\n```diff\n' + '\n'.join(d[:DIFF]) + more + '\n```'

# what Claude changed or ran: files as diffs, commands as they were typed (no tool output)
def change_of(name, i):
    p = i.get('file_path')
    if name == 'Edit' and p: return [diff(p, i.get('old_string', ''), i.get('new_string', ''))]
    if name == 'MultiEdit' and p: return [diff(p, e.get('old_string', ''), e.get('new_string', '')) for e in i.get('edits', [])]
    if name == 'Write' and p:
        body = (i.get('content') or '').splitlines()
        return [f'  (wrote {p}, {len(body)} lines)\n```\n' + '\n'.join(body[:DIFF]) + ('\n...' if len(body) > DIFF else '') + '\n```']
    if name == 'Bash' and i.get('command'): return ['  (ran) ' + i['command'].strip()[:300]]
    return []

def main(session, start, cli):
    found = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{session}.jsonl'))
    if not found: sys.exit(f'no transcript for session {session}')
    path = max(found, key=os.path.getmtime)
    parts, n = [], 0
    with open(path, encoding='utf-8', errors='replace') as f:
        for n, line in enumerate(f, 1):
            if n <= start: continue
            try: m = json.loads(line)
            except ValueError: continue
            q = prompt_of(m)
            if q:
                parts.append('USER: ' + q)
                continue
            if m.get('type') != 'assistant' or m.get('isSidechain'): continue
            for x in (m.get('message') or {}).get('content', []) or []:
                if not isinstance(x, dict): continue
                if x.get('type') == 'text' and x.get('text', '').strip(): parts.append('CLAUDE: ' + x['text'].strip())
                if x.get('type') == 'tool_use': parts.extend(change_of(x['name'], x.get('input') or {}))
    text = '\n\n'.join(parts)[-CAP:]
    out = ''
    if text:
        d = os.path.expanduser('~/.cache/claude-call'); os.makedirs(d, exist_ok=True)
        out = f'{d}/{session}-{cli}-{start}.md'
        with open(out, 'w', encoding='utf-8') as f: f.write(text + '\n')
    print(json.dumps(dict(records=n, path=out)))

if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]), sys.argv[3])
