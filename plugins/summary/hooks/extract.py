import sys, os, json, glob, re

# <session id> [from]: a header line {"mtime", "records", "chunks"}, then the conversation from record `from` on,
# as text: every prompt and everything Claude wrote (no tool output). Long ones come in chunks split by \f.
CHUNK = 240_000  # characters per chunk: well inside Haiku's context

def records(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            try: yield json.loads(line)
            except ValueError: yield {}

def prompt_of(m):
    if m.get('type') != 'user' or m.get('isMeta') or m.get('isSidechain'): return None
    c = (m.get('message') or {}).get('content')
    if isinstance(c, list):
        c = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    if not isinstance(c, str) or not c.strip(): return None
    cmd = re.search(r'<command-name>(.*?)</command-name>.*?<command-args>(.*?)</command-args>', c, re.S)
    if cmd:
        if cmd.group(1) in ('/clear', '/model', '/effort', '/config', '/status', '/cost', '/exit', '/resume'): return None  # housekeeping
        return f'{cmd.group(1)} {cmd.group(2)}'.strip()
    if c.startswith('<'): return None  # system notices, task notifications
    return re.sub(r'<pasted_content.*?</pasted_content[^>]*>', '[pasted text]', c, flags=re.S).strip()

def main(session, start):
    found = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{session}.jsonl'))
    if not found: sys.exit(f'no transcript for session {session}')
    path = max(found, key=os.path.getmtime)
    parts, n = [], 0
    for n, m in enumerate(records(path), 1):
        if n <= start: continue
        q = prompt_of(m)
        if q:
            parts.append('USER: ' + q)
            continue
        if m.get('type') != 'assistant' or m.get('isSidechain'): continue
        for x in (m.get('message') or {}).get('content', []) or []:
            if not isinstance(x, dict): continue
            if x.get('type') == 'text' and x.get('text', '').strip(): parts.append('CLAUDE: ' + x['text'].strip())
            if x.get('type') == 'tool_use':
                i = x.get('input') or {}
                if x['name'] in ('Edit', 'Write') and i.get('file_path'): parts.append(f"  (edited {i['file_path']})")
                if x['name'] == 'ExitPlanMode': parts.append('  (plan) ' + i.get('plan', '').strip())
                if x['name'] == 'AskUserQuestion': parts.append('  (asked) ' + ' / '.join(q.get('question', '') for q in i.get('questions', [])))
                if x['name'] == 'Bash' and 'git commit' in i.get('command', ''): parts.append('  (commit) ' + i['command'][:300])
    chunks, cur = [], ''
    for p in parts:
        if cur and len(cur) + len(p) > CHUNK:
            chunks.append(cur); cur = ''
        cur += p + '\n'
    if cur: chunks.append(cur)
    print(json.dumps(dict(mtime=int(os.path.getmtime(path) * 1000), records=n, chunks=len(chunks))))
    print('\f'.join(chunks), end='')

if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 0)
