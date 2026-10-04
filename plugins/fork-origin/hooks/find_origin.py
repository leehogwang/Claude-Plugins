import sys, os, glob, json, re, subprocess

# <session id>: the session this one was forked from. A fork is told, in a <fork-source> notice,
# the name of the session it copies and the time up to which the two share their history; the
# last message of that shared history is in both transcripts under the same uuid.
PROJECTS = os.path.expanduser('~/.claude/projects')
NOTICE = re.compile(r"self-reported name is '(.*?)'\. The conversation up to (\S+?Z) is shared history")

def transcript(sid):
    found = glob.glob(f'{PROJECTS}/*/{sid}.jsonl')
    return max(found, key=os.path.getmtime) if found else None

mine = transcript(sys.argv[1])
if not mine: sys.exit(f'no transcript for session {sys.argv[1]}')
records = []
with open(mine, encoding='utf-8', errors='replace') as f:
    for line in f:
        try: records.append(json.loads(line))
        except ValueError: pass

# the latest notice is this session's own (earlier ones came with history copied from a fork)
name = upto = None
for m in records:
    # the notice itself: queued, or delivered as a plain user message (tool output quoting one is not)
    text = m.get('content') if m.get('type') == 'queue-operation' else (m.get('message') or {}).get('content') if m.get('type') == 'user' else None
    if not isinstance(text, str): continue
    for found in NOTICE.finditer(text):
        name, upto = found.group(1), found.group(2)
if not upto: sys.exit('not a fork')
leaf = None
for m in records:
    if m.get('uuid') and m.get('timestamp') and m['timestamp'] <= upto: leaf = m['uuid']
if not leaf: sys.exit('the shared history was not found')

holders = subprocess.run(['grep', '-l', '--', leaf, *glob.glob(f'{PROJECTS}/*/*.jsonl')], capture_output=True, text=True).stdout.split()
holders = [h for h in holders if os.path.abspath(h) != os.path.abspath(mine)]
if not holders: sys.exit('the original session was not found')

def names(path):  # the titles a transcript has gone by
    out = set()
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if '"agent-name"' in line or '"custom-title"' in line or '"ai-title"' in line:
                try: m = json.loads(line)
                except ValueError: continue
                out |= {m.get('agentName'), m.get('customTitle'), m.get('aiTitle')}
    return out

named = [h for h in holders if name in names(h)]
best = max(named or holders, key=os.path.getmtime)
print(os.path.basename(best)[:-6])
