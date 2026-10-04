"""Self-check for agy-bridge, speaking the Anthropic Messages API like Claude Code does.

  python3 selftest.py            # tool round trip + interrupt/continue
  python3 selftest.py --slow     # also: tool result arrives after agy's 3-minute MCP deadline
"""
import json, os, secrets, shutil, subprocess, sys, time
import httpx

URL = f"http://127.0.0.1:{os.environ.get('AGY_BRIDGE_PORT', '47821')}/v1/messages"


def default_model():
    """AGY_BRIDGE_TEST_MODEL, else the first Gemini Flash model `agy models` lists."""
    if os.environ.get('AGY_BRIDGE_TEST_MODEL'):
        return os.environ['AGY_BRIDGE_TEST_MODEL']
    agy = shutil.which('agy') or os.path.expanduser('~/.local/bin/agy')
    ids = [l.split('\t')[0] for l in subprocess.run([agy, 'models'], capture_output=True, text=True).stdout.splitlines() if '\t' in l]
    return 'agy-' + next((i for i in ids if 'flash' in i), ids[0])


MODEL = default_model()
TOOLS = [{'name': 'Bash', 'description': 'Run a shell command and return its output.',
          'input_schema': {'type': 'object', 'properties': {'command': {'type': 'string'}}, 'required': ['command']}}]
SYSTEM = [{'type': 'text', 'text': 'You are a helpful assistant. Be brief.'}]


def call(messages, stop_after=None):
    """Stream one request; return the assistant content blocks (or None if we hung up early)."""
    body = {'model': MODEL, 'max_tokens': 4096, 'stream': True, 'system': SYSTEM, 'tools': TOOLS, 'messages': messages}
    blocks, t0 = {}, time.time()
    with httpx.stream('POST', URL, json=body, timeout=None) as r:
        for line in r.iter_lines():
            if not line.startswith('data: '):
                continue
            ev = json.loads(line[6:])
            if ev['type'] == 'content_block_start':
                blocks[ev['index']] = dict(ev['content_block'])
            elif ev['type'] == 'content_block_delta':
                d, b = ev['delta'], blocks[ev['index']]
                if d['type'] == 'text_delta':
                    b['text'] += d['text']
                else:
                    b['input'] = json.loads(d['partial_json'])
            elif ev['type'] == 'error':
                raise SystemExit(f'bridge error: {ev}')
            if stop_after and ev['type'] == 'content_block_delta' and time.time() - t0 > stop_after:
                return None   # simulate Esc mid-stream
    return [blocks[i] for i in sorted(blocks)]


def tool_round(delay):
    token = secrets.token_hex(4)
    msgs = [{'role': 'user', 'content': f'Run the command `show-greeting` with the Bash tool and tell me exactly what it printed.'}]
    out = call(msgs)
    uses = [b for b in out if b['type'] == 'tool_use']
    assert uses and uses[0]['name'] == 'Bash', out
    print(f'  tool_use: {uses[0]["input"]}  (answering in {delay}s)')
    time.sleep(delay)
    msgs += [{'role': 'assistant', 'content': out},
             {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': u['id'], 'content': f'GREETING-{token}'} for u in uses]}]
    while True:   # agy may need wait_for_result round trips; those are invisible here
        out = call(msgs)
        uses = [b for b in out if b['type'] == 'tool_use']
        if not uses:
            break
        msgs += [{'role': 'assistant', 'content': out},
                 {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': u['id'], 'content': f'GREETING-{token}'} for u in uses]}]
    text = ''.join(b.get('text', '') for b in out)
    assert token in text, text
    print(f'  final: {text.strip()[:120]}')
    return msgs + [{'role': 'assistant', 'content': out}]


def interrupt(msgs):
    msgs = msgs + [{'role': 'user', 'content': 'Write a 400-word story about a lighthouse keeper.'}]
    assert call(msgs, stop_after=2) is None
    print('  hung up mid-stream')
    word = secrets.token_hex(3)
    msgs += [{'role': 'user', 'content': f'[Request interrupted by user]\nForget the story. Reply with only the word {word}.'}]
    out = call(msgs)
    text = ''.join(b.get('text', '') for b in out)
    assert word in text, text
    print(f'  after interrupt: {text.strip()[:80]}')


if __name__ == '__main__':
    print(f'model {MODEL}')
    print('tool round trip')
    msgs = tool_round(1)
    print('interrupt + continue')
    interrupt(msgs)
    if '--slow' in sys.argv:
        print('tool result after 200s (past agy MCP deadline)')
        tool_round(200)
    print('OK')
