import sys, os, json, glob, re

# <session id>: one JSON object: the session's working directory and its conversation as
# [{"who": "user" | "claude", "text": ...}], prompts and Claude's words only (no tool output).
def prompt_of(m):
    if m.get('type') != 'user' or m.get('isMeta') or m.get('isSidechain'): return None
    c = (m.get('message') or {}).get('content')
    if isinstance(c, list):
        c = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    if not isinstance(c, str) or not c.strip(): return None
    cmd = re.search(r'<command-name>(.*?)</command-name>.*?<command-args>(.*?)</command-args>', c, re.S)
    if cmd: return f'{cmd.group(1)} {cmd.group(2)}'.strip()
    if c.startswith('<'): return None
    return re.sub(r'<pasted_content.*?</pasted_content[^>]*>', '[pasted text]', c, flags=re.S).strip()

found = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{sys.argv[1]}.jsonl'))
if not found: sys.exit(f'no transcript for session {sys.argv[1]}')
cwd, turns = None, []
with open(max(found, key=os.path.getmtime), encoding='utf-8', errors='replace') as f:
    for line in f:
        try: m = json.loads(line)
        except ValueError: continue
        cwd = cwd or m.get('cwd')
        q = prompt_of(m)
        if q: turns.append(dict(who='user', text=q)); continue
        if m.get('type') == 'assistant' and not m.get('isSidechain'):
            for x in (m.get('message') or {}).get('content', []) or []:
                if isinstance(x, dict) and x.get('type') == 'text' and x.get('text', '').strip():
                    turns.append(dict(who='claude', text=x['text'].strip()))
print(json.dumps(dict(cwd=cwd, turns=turns), ensure_ascii=False))
