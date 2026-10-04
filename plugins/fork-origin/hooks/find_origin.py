import sys, os, glob, json, subprocess

# <session id>: the session this one was forked from, by the messages the fork copied from it.
# A fork's transcript starts with the original's messages under the same uuids; of the other
# transcripts holding the last of them, the most recently written is the original as it runs now
# (its `continued-in` records followed, when the original moved on to a new id).
mine = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{sys.argv[1]}.jsonl'))
if not mine: sys.exit(f'no transcript for session {sys.argv[1]}')
mine = max(mine, key=os.path.getmtime)
# the fork notice arrives as a user message right after the copied history
leaf, forked = None, False
with open(mine, encoding='utf-8', errors='replace') as f:
    for line in f:
        try: m = json.loads(line)
        except ValueError: continue
        if 'fork-source' in line:
            forked = True
            if m.get('type') == 'user': break  # delivered: the copied history ends here
            continue  # still queued (the fork just started): the copied history is all there is
        leaf = m.get('uuid') or leaf
if not forked or not leaf: sys.exit('not a fork')
holders = subprocess.run(['grep', '-l', '--', leaf, *glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl'))],
                         capture_output=True, text=True).stdout.split()
holders = [h for h in holders if os.path.abspath(h) != os.path.abspath(mine)]
if not holders: sys.exit('the original session was not found')
best = max(holders, key=os.path.getmtime)
sid = os.path.basename(best)[:-6]
for _ in range(10):  # follow continued-in
    nxt = None
    with open(best, encoding='utf-8', errors='replace') as f:
        for line in f:
            if '"continued-in"' in line:
                try: nxt = json.loads(line).get('continuedInSessionId')
                except ValueError: pass
    path = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{nxt}.jsonl')) if nxt else []
    if not path or nxt == sys.argv[1]: break
    best, sid = path[0], nxt
print(sid)
