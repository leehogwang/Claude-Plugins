#!/usr/bin/env python3
"""agy-bridge: lets Claude Code use agy (Antigravity CLI) models as if they were API models.

- Requests for Claude models pass through untouched to api.anthropic.com.
- Requests for `agy-<model>` go to one persistent `agy` process per Claude Code conversation.
  Claude Code's own tools are exposed back to agy as the MCP server `cc_cc`; when agy calls one,
  the bridge ends the Anthropic response with a matching tool_use block, Claude Code executes it
  (permissions, hooks, UI and all), and the tool_result is handed back to agy's pending MCP call.
- Conversations are matched by message fingerprints and persisted, so resume/restart continue the
  same agy conversation (`agy --conversation`); compaction/rewind start a new one seeded with history.
"""
import asyncio, base64, contextlib, hashlib, json, logging, os, re, shutil, time, uuid
from pathlib import Path

import httpx, uvicorn
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

ROOT = Path.home() / '.local/share/agy-bridge'
WS, IMG, STATE = ROOT / 'ws', ROOT / 'images', ROOT / 'sessions.json'
HIST = ROOT / 'history'    # full transcripts too long to send inline
INJECT = ROOT / 'inject'   # history for the agy PreInvocation hook to insert (see ws/.agents/plugins/cc)
CLAUDE_SETTINGS = Path.home() / '.claude/settings.json'
PORT = int(os.environ.get('AGY_BRIDGE_PORT', '47821'))
UPSTREAM = os.environ.get('AGY_BRIDGE_UPSTREAM', 'https://api.anthropic.com')
AGY = os.environ.get('AGY_BIN') or shutil.which('agy') or str(Path.home() / '.local/bin/agy')
PREFIX = 'agy-'
MCP_SERVER = 'cc_cc'      # plugin "cc" + server "cc", as agy names it
MCP_HOLD = 150            # agy aborts MCP calls after 180s; answer "still running" before that
MAX_INPUT = 150_000       # bytes per agy user message; agy truncates beyond ~200KB
HIST_CLIP = 20_000        # chars kept from each tool input/result when replaying history
TOOL_GRACE = 0.1          # after a tool call, wait this long for more before ending the response
IDLE_KILL = 1200          # stop idle agy processes (conversation stays resumable)
SUBAGENT_IDLE = 180       # subagent conversations rarely come back
MAX_LIVE = 4              # agy processes (~250MB each) kept running at once
KEEP_DAYS = 30            # forget conversation mappings unused this long
# Client-side profile Claude Code applies to agy models. Gemini has a 1M window, so it borrows a
# large-window model's profile ('[1m]' ids are hidden from the picker on plans without 1M).
BEHAVES_AS = {'gemini': 'claude-opus-5-5'}
BEHAVES_AS_DEFAULT = 'claude-sonnet-4-6'
PERSIST_CLASSES = {None, 'main', 'subagent', 'workflow', 'teammate'}

logging.basicConfig(filename=ROOT / 'bridge.log', level=logging.INFO,
                    format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('agy-bridge')
logging.getLogger('httpx').setLevel(logging.WARNING)
http = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=30))

SESSIONS: dict[str, 'Session'] = {}   # sid -> session
BY_CONV: dict[str, 'Session'] = {}    # agy conversation id -> session
TOOLS: dict[str, dict] = {}           # Claude Code tools, as MCP tool defs

SEED = """You are now the model behind Claude Code (Anthropic's agentic coding CLI), connected through a bridge. \
Treat <claude_code_system_prompt> below as your system prompt and follow it exactly; it overrides your usual persona and habits.

How this session works:
- Your built-in tools (run_command, view_file, write_to_file, list_dir, grep_search, browser_*, subagents, ...) are DISABLED here and will fail.
- Act ONLY through the MCP server "cc_cc" (call_mcp_tool with ServerName "cc_cc"). Its tools are Claude Code's own tools (Read, Edit, Write, Bash, Grep, Glob, Agent, TodoWrite, ...) and run in the user's real environment. Use the exact parameter names from <claude_code_tools>.
- A Claude Code tool missing from the cc_cc list (e.g. one just loaded via ToolSearch) can be called with the cc_cc tool "call_tool" and arguments {"name": "<tool>", "input": {...}}.
- If a tool result says the tool is still running, call the cc_cc tool "wait_for_result" with that call_id, without commentary. Never re-run the tool.
- Your plain-text replies are shown directly to the user in Claude Code. Messages you receive later are the user's turns (with Claude Code's <system-reminder> context) or tool results.
- The schemas in <claude_code_tools> are complete; call the tools directly without viewing their MCP schema files.
- view_file is the one built-in tool still allowed, and only for: images the user attached, transcript files the bridge points you to, and large outputs agy saved for you.

<claude_code_system_prompt>
{system}
</claude_code_system_prompt>

<claude_code_tools>
{tools}
</claude_code_tools>
"""


# ---------- message helpers ----------

def blocks(content):
    return [{'type': 'text', 'text': content}] if isinstance(content, str) else (content or [])


def fingerprint(msg):
    parts = []
    for b in blocks(msg.get('content')):
        t = b.get('type')
        if t == 'text' and b.get('text', '').strip():
            parts.append(('t', b['text'].strip()))
        elif t == 'tool_use':
            parts.append(('u', b.get('id')))
        elif t == 'tool_result':
            parts.append(('r', b.get('tool_use_id')))
        elif t == 'image':
            parts.append(('i', hashlib.sha1(json.dumps(b.get('source'), sort_keys=True).encode()).hexdigest()))
    if msg['role'] == 'assistant' and any(p[0] == 'u' for p in parts):
        parts = [p for p in parts if p[0] == 'u']   # tool ids identify it; text may be reformatted
    return hashlib.sha1(json.dumps([msg['role'], parts]).encode()).hexdigest()[:20]


def save_image(src):
    if src.get('type') != 'base64':
        return src.get('url', '(image)')
    data = base64.b64decode(src['data'])
    ext = (src.get('media_type') or 'image/png').split('/')[-1]
    IMG.mkdir(parents=True, exist_ok=True)
    p = IMG / f'{hashlib.sha1(data).hexdigest()[:16]}.{ext}'
    p.write_bytes(data)
    return str(p)


def result_text(content):
    out = []
    for b in blocks(content):
        if b.get('type') == 'text':
            out.append(b['text'])
        elif b.get('type') == 'image':
            out.append(f'[image saved at {save_image(b.get("source", {}))}]')
        else:
            out.append(json.dumps(b))
    return '\n'.join(out)


def clip(text, n):
    """Keep the head and tail of text within about n chars."""
    return text if not n or len(text) <= n else f'{text[:n // 2]}\n[... {len(text) - n} chars omitted ...]\n{text[-n // 2:]}'


def nbytes(text):
    return len(text.encode())


def spill(name, text):
    HIST.mkdir(parents=True, exist_ok=True)
    path = HIST / name
    path.write_text(text)
    return path


def fit(text, name, limit):
    """Keep a message under agy's input limit; the full text goes to a file agy may view."""
    if nbytes(text) <= limit:
        return text
    path = spill(name, text)
    return f'(This message was too long to send whole; full text: {path} - read it with view_file.)\n' + clip(text, limit // 4)


def render(msgs, limit=None):
    return '\n\n'.join(render_parts(msgs, limit))


def render_parts(msgs, limit=None):
    """Render Claude Code messages as plain-text pieces for agy; limit shortens tool traffic and long texts."""
    out, called = [], {}
    for m in msgs:
        for b in blocks(m.get('content')):
            t = b.get('type')
            if t == 'text':
                text = clip(b['text'], limit and limit * 4)
                out.append(text if m['role'] == 'user' else f'[assistant]: {text}')
            elif t == 'image':
                out.append(f'[user attached an image, saved at {save_image(b.get("source", {}))} - open it with view_file]')
            elif t == 'tool_use':
                called[b.get('id')] = f'{b.get("name")} {clip(json.dumps(b.get("input"), ensure_ascii=False), 300)}'
                out.append(f'[assistant called tool {b.get("name")} (id {b.get("id")})]: {clip(json.dumps(b.get("input")), limit)}')
            elif t == 'tool_result':
                err = ' (error)' if b.get('is_error') else ''
                what = called.get(b.get('tool_use_id'), b.get('tool_use_id'))
                out.append(f'[tool result{err} of {what}]:\n{clip(result_text(b.get("content")), limit)}')
    return out


def pack(pieces, limit):
    """Group text pieces into chunks of at most limit bytes."""
    chunks, cur = [], ''
    for piece in pieces:
        if nbytes(piece) > limit:
            piece = clip(piece, limit // 4)
        if cur and nbytes(cur) + nbytes(piece) + 2 > limit:
            chunks.append(cur)
            cur = ''
        cur = f'{cur}\n\n{piece}' if cur else piece
    return chunks + [cur] if cur else chunks


def mcp_content(block):
    content = []
    for b in blocks(block.get('content')):
        if b.get('type') == 'text':
            content.append({'type': 'text', 'text': b['text']})
        elif b.get('type') == 'image' and b.get('source', {}).get('type') == 'base64':
            content.append({'type': 'image', 'data': b['source']['data'], 'mimeType': b['source'].get('media_type', 'image/png')})
        else:
            content.append({'type': 'text', 'text': json.dumps(b)})
    return {'content': content or [{'type': 'text', 'text': '(no output)'}], 'isError': bool(block.get('is_error'))}


def system_text(system):
    return system if isinstance(system, str) else '\n\n'.join(b.get('text', '') for b in system or [])


def update_tools(tools):
    for t in tools or []:
        if 'input_schema' in t and t.get('name') != 'DeferredToolPlaceholder':
            TOOLS[t['name']] = {'name': t['name'], 'description': t.get('description', ''), 'inputSchema': t['input_schema']}


def mcp_tool_list():
    return list(TOOLS.values()) + [
        {'name': 'call_tool', 'description': 'Call a Claude Code tool that is not in this list (e.g. loaded later via ToolSearch).',
         'inputSchema': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'input': {'type': 'object'}}, 'required': ['name']}},
        {'name': 'wait_for_result', 'description': 'Keep waiting for a Claude Code tool call that is still running.',
         'inputSchema': {'type': 'object', 'properties': {'call_id': {'type': 'string'}}, 'required': ['call_id']}},
    ]


# ---------- sessions ----------

class Call:
    def __init__(self, name, args):
        self.id = 'toolu_agy_' + uuid.uuid4().hex[:20]
        self.name, self.input = name, args
        self.fut = asyncio.get_running_loop().create_future()
        self.delivered = False   # result handed to agy through an MCP response


class Session:
    def __init__(self, model, agent=None, persistent=True, sid=None, conv=None, fps=()):
        self.sid = sid or uuid.uuid4().hex[:12]
        self.model, self.agent, self.persistent, self.conv = model, agent, persistent, conv
        self.fps = list(fps)
        self.proc = None
        self.q: asyncio.Queue = asyncio.Queue()
        self.lock = asyncio.Lock()
        self.calls: dict[str, Call] = {}
        self.busy = False          # an agy turn is running (possibly blocked on tool calls)
        self.streaming = False     # a Claude Code request is being answered right now
        self.last = time.time()
        self.proc_model = None
        self.dropped_tail = False
        self.tools_ok = True       # this request lets the model call Claude Code tools
        self.planned: list[Call] = []   # rest of agy's current step, already sent to Claude Code
        if conv:
            BY_CONV[conv] = self

    def to_json(self):
        return {'sid': self.sid, 'model': self.model, 'agent': self.agent, 'conv': self.conv, 'fps': self.fps, 'last': self.last}

    async def ensure_proc(self):
        if self.proc and self.proc.returncode is None and self.proc_model == self.model:
            return
        await self.stop()
        live = [x for x in SESSIONS.values() if x is not self and x.proc]
        idle = sorted((x for x in live if not x.busy and not x.lock.locked()), key=lambda x: x.last)
        for x in idle[:max(0, len(live) + 1 - MAX_LIVE)]:
            log.info('session %s: stopping agy to stay under %d processes', x.sid, MAX_LIVE)
            await x.stop()
        args = [AGY, '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', self.model[len(PREFIX):]]
        if self.conv:
            args += ['--conversation', self.conv]
        self.proc = await asyncio.create_subprocess_exec(
            *args, '-p=', cwd=WS, env={**os.environ, 'AGY_BRIDGE_INJECT': str(INJECT / f'{self.sid}.json')},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=1 << 26)
        self.proc_model = self.model
        self.q = asyncio.Queue()
        asyncio.create_task(self._read(self.proc))
        asyncio.create_task(self._drain_err(self.proc))
        log.info('session %s: started agy pid=%s model=%s conv=%s', self.sid, self.proc.pid, self.model, self.conv)

    async def stop(self):
        p, self.proc = self.proc, None
        if p and p.returncode is None:
            p.terminate()
            try:
                await asyncio.wait_for(p.wait(), 10)
            except asyncio.TimeoutError:
                p.kill()
        self.busy = False
        for c in self.calls.values():
            if not c.fut.done():
                c.fut.cancel()
        self.calls.clear()
        self.planned = []

    async def _drain_err(self, p):
        async for line in p.stderr:
            log.info('agy[%s] stderr: %s', self.sid, line.decode(errors='replace').rstrip()[:500])

    async def _read(self, p):
        async for line in p.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            kind = ev.get('event')
            body = ev.get(kind) if isinstance(ev.get(kind), dict) else {}
            conv = body.get('conversation_id')
            if conv and conv != self.conv:
                self.conv = conv
                BY_CONV[conv] = self
                save_state()
            if kind == 'step_update':
                if body.get('step_type') == 'agent_response' and body.get('text_delta'):
                    self.q.put_nowait(('text', body.get('step_index'), body['text_delta']))
                elif body.get('step_type') == 'tool' and body.get('state') == 'ERROR':
                    log.info('agy[%s] tool %s failed: %s', self.sid, body.get('tool_name'), json.dumps(body.get('tool_info', {}).get('error'))[:300])
            elif kind == 'result':
                self.q.put_nowait(('done', body))
        if self.proc is p:
            self.q.put_nowait(('done', {'status': 'ERROR', 'error': f'agy exited ({p.returncode})'}))

    async def send(self, text):
        line = json.dumps({'event': 'user', 'message': {'role': 'user', 'content': text}}) + '\n'
        self.proc.stdin.write(line.encode())
        await self.proc.stdin.drain()
        self.busy = True


def save_state():
    data = [s.to_json() for s in SESSIONS.values() if s.persistent and s.conv]
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.replace(STATE)


def load_state():
    try:
        for d in json.loads(STATE.read_text()):
            if time.time() - d.get('last', time.time()) > KEEP_DAYS * 86400:
                continue
            s = Session(d['model'], d.get('agent'), sid=d['sid'], conv=d['conv'], fps=d['fps'])
            s.last = d.get('last', s.last)
            SESSIONS[s.sid] = s
    except (OSError, ValueError, KeyError):
        pass


def common_prefix(a, b):
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def pick_session(fps, model, agent, cls):
    """Return (session, k): k = number of request messages agy already has."""
    if cls not in PERSIST_CLASSES:
        return Session(model, agent, persistent=False), 0
    best, best_k = None, 0
    for s in SESSIONS.values():
        if s.agent != agent or s.streaming:   # a concurrent request on the same history is a fork
            continue
        k = common_prefix(s.fps, fps)
        # usable if agy's history is a prefix of the request, or only its tail was dropped
        # (interrupted / regenerated reply) — anything bigger (rewind, compaction) starts fresh.
        if k and k >= len(s.fps) - 2 and k > best_k:
            best, best_k = s, k
    if best is None:
        best = Session(model, agent)
        SESSIONS[best.sid] = best
    elif best_k < len(best.fps):
        best.fps = best.fps[:best_k]
        best.dropped_tail = True  # agy saw a reply Claude Code no longer has
    best.model = model
    return best, best_k


# ---------- Anthropic side ----------

def sse(event, data):
    return f'event: {event}\ndata: {json.dumps(data)}\n\n'


async def agy_turn(body, headers):
    model = re.sub(r'\[.*\]$', '', body['model'])
    msgs = body.get('messages', [])
    fps = [fingerprint(m) for m in msgs]
    agent = headers.get('x-claude-code-agent-id')
    cls = headers.get('x-claude-code-request-class')
    update_tools(body.get('tools'))
    s, k = pick_session(fps, model, agent, cls)
    s.streaming = True
    try:
        await s.lock.acquire()   # may wait for the previous request's cleanup (e.g. restart after Esc)
    except BaseException:
        s.streaming = False
        raise
    s.tools_ok = bool(body.get('tools')) and cls != 'compaction'
    return s, k, msgs, fps


async def feed(s, k, msgs, fps, body):
    """Hand the new part of the conversation to agy."""
    s.last = time.time()
    await s.ensure_proc()
    delta = msgs[k:]
    results = [b for m in delta if m['role'] == 'user' for b in blocks(m.get('content')) if b.get('type') == 'tool_result']
    waiting = [b for b in results if b.get('tool_use_id') in s.calls and not s.calls[b['tool_use_id']].fut.done()]
    if s.busy and waiting:
        # Continue the running agy turn: hand results to the blocked MCP calls.
        others = [dict(m, content=[b for b in blocks(m.get('content')) if b not in waiting]) for m in delta]
        extra = render(others).strip()
        for i, b in enumerate(waiting):
            res = mcp_content(b)
            if extra and i == len(waiting) - 1:
                res['content'].append({'type': 'text', 'text': extra})
            s.calls[b['tool_use_id']].fut.set_result(res)
    else:
        if s.busy:   # turn still running but Claude Code moved on (interrupt) — restart from the saved conversation
            await s.stop()
            await s.ensure_proc()
        if not s.conv or k == 0 and not s.fps:
            # Full schemas are in agy's MCP schema files; keep the inline copy short.
            tools = json.dumps([{'name': t['name'], 'description': clip(t['description'], 1500), 'input_schema': t['inputSchema']}
                                for t in TOOLS.values()]) if s.tools_ok else '(no tools for this request)'
            head = SEED.replace('{system}', system_text(body.get('system'))).replace('{tools}', tools)
            turn = fit(render(msgs[-1:]), f'{s.sid}-turn.md', MAX_INPUT - 4000)
            if s.persistent:
                ask = ('The conversation so far is history you already handled. Reply to the current user turn below:\n\n'
                       '<current_user_turn>\n' + turn + '\n</current_user_turn>')
            else:   # one-off request (e.g. compaction summary): answer it, don't resume the work
                ask = ('This is a one-off request about the conversation so far. Do not continue the earlier work'
                       + ('' if s.tools_ok else ' and do not call any tools; reply with plain text only')
                       + '. Respond only to this request:\n\n<request>\n' + turn + '\n</request>')
            parts = pack(render_parts(msgs[:-1], HIST_CLIP), MAX_INPUT - 2000)
            if len(parts) <= 1 and nbytes(head) + nbytes(''.join(parts)) + nbytes(ask) < MAX_INPUT:
                hist = f'\n<conversation_so_far>\n{parts[0]}\n</conversation_so_far>\n\n' if parts else ''
                text = head + hist + ask
            else:
                # Too big for one message (agy truncates ~200KB): the cc plugin's PreInvocation hook
                # inserts these as separate messages right before the model runs, so it reads them all at once.
                n = len(parts)
                inject = ([head + f'\n\nThe earlier conversation follows as {n} read-only transcript parts.']
                          + [f'<conversation_so_far part="{i + 1}/{n}">\n{p}\n</conversation_so_far>' for i, p in enumerate(parts)]
                          + [ask])
                INJECT.mkdir(parents=True, exist_ok=True)
                (INJECT / f'{s.sid}.json').write_text(json.dumps(inject))
                log.info('session %s: history goes in via hook (%d parts)', s.sid, n)
                text = "[Claude Code bridge: loading this session's context]"
        else:
            text = fit(render(delta), f'{s.sid}-{int(time.time())}.md', MAX_INPUT)
            if s.dropped_tail:
                text = '[Note: your previous reply was interrupted or discarded by the user; continue from here.]\n\n' + text
                s.dropped_tail = False
        await s.send(text)
    s.fps = fps


async def run(body, headers):
    """Yield Anthropic SSE events for agy output until a tool call or the end of the turn."""
    s, k, msgs, fps = await agy_turn(body, headers)
    msg_id = 'msg_agy_' + uuid.uuid4().hex[:20]
    est = len(json.dumps(body)) // 4
    content, text, calls, idx = [], None, [], -1
    stop, step, finished = 'end_turn', None, False
    usage_out = 0
    feeding = None
    try:
        yield sse('message_start', {'type': 'message_start', 'message': {
            'id': msg_id, 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [],
            'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': est, 'output_tokens': 0}}})
        feeding = asyncio.ensure_future(feed(s, k, msgs, fps, body))
        while not (await asyncio.wait({feeding}, timeout=10))[0]:
            yield sse('ping', {'type': 'ping'})   # history replay can take a while
        feeding.result()
        while True:
            try:
                ev = await asyncio.wait_for(s.q.get(), TOOL_GRACE if calls else 15)
            except asyncio.TimeoutError:
                if calls:
                    stop = 'tool_use'
                    break
                yield sse('ping', {'type': 'ping'})
                continue
            if ev[0] == 'text':
                _, st, delta = ev
                if text is None:
                    idx += 1
                    text = {'type': 'text', 'text': ''}
                    content.append(text)
                    yield sse('content_block_start', {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'text', 'text': ''}})
                elif step is not None and st != step:
                    delta = '\n\n' + delta
                step = st
                text['text'] += delta
                yield sse('content_block_delta', {'type': 'content_block_delta', 'index': idx, 'delta': {'type': 'text_delta', 'text': delta}})
            elif ev[0] == 'tool':
                c = ev[1]
                if text is not None:
                    yield sse('content_block_stop', {'type': 'content_block_stop', 'index': idx})
                    text = None
                idx += 1
                calls.append(c)
                content.append({'type': 'tool_use', 'id': c.id, 'name': c.name, 'input': c.input})
                yield sse('content_block_start', {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'tool_use', 'id': c.id, 'name': c.name, 'input': {}}})
                yield sse('content_block_delta', {'type': 'content_block_delta', 'index': idx, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(c.input)}})
                yield sse('content_block_stop', {'type': 'content_block_stop', 'index': idx})
            elif ev[0] == 'done':
                r = ev[1]
                s.busy = False
                usage_out = (r.get('usage') or {}).get('output_tokens', 0)
                if r.get('denied_actions') and not content:   # agy blocked one of its own tools and gave up
                    r = dict(r, status='ERROR', error=f'agy denied {json.dumps(r["denied_actions"])}')
                if r.get('status') != 'SUCCESS':
                    err = r.get('error') or r.get('status')
                    log.warning('session %s: agy turn failed: %s', s.sid, err)
                    if not content:
                        yield sse('error', {'type': 'error', 'error': {'type': 'api_error', 'message': f'agy: {err}'}})
                        finished = True
                        return
                    if text is None:
                        idx += 1
                        text = {'type': 'text', 'text': ''}
                        content.append(text)
                        yield sse('content_block_start', {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'text', 'text': ''}})
                    note = f'\n\n[agy error: {err}]'
                    text['text'] += note
                    yield sse('content_block_delta', {'type': 'content_block_delta', 'index': idx, 'delta': {'type': 'text_delta', 'text': note}})
                break
        if calls:
            stop = 'tool_use'
        if text is not None:
            yield sse('content_block_stop', {'type': 'content_block_stop', 'index': idx})
        if not content:   # Claude Code rejects empty assistant messages
            content.append({'type': 'text', 'text': '(no response)'})
            yield sse('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})
            yield sse('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': '(no response)'}})
            yield sse('content_block_stop', {'type': 'content_block_stop', 'index': 0})
        s.fps.append(fingerprint({'role': 'assistant', 'content': content}))
        yield sse('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None},
                                    'usage': {'input_tokens': est, 'output_tokens': usage_out or sum(len(json.dumps(b)) for b in content) // 4}})
        yield sse('message_stop', {'type': 'message_stop'})
        finished = True
    except Exception as e:
        log.exception('session %s: turn failed', s.sid)
        yield sse('error', {'type': 'error', 'error': {'type': 'api_error', 'message': f'agy-bridge: {e}'}})
        finished = None   # stop agy as well
    finally:
        if feeding and not feeding.done():
            feeding.cancel()
        # A task, not an await: when the client disconnects this scope is cancelled.
        asyncio.get_running_loop().create_task(finish(s, finished))


async def finish(s, finished):
    s.streaming = False
    try:
        if not finished:   # client went away (Esc) or failure: stop agy, conversation stays resumable
            log.info('session %s: turn aborted, stopping agy', s.sid)
            await s.stop()
            if s.persistent and s.conv:
                await s.ensure_proc()   # agy takes ~4s to start; do it while the user types
        if s.persistent:
            save_state()
        elif not s.busy:
            await s.stop()
            BY_CONV.pop(s.conv, None)
    finally:
        s.last = time.time()
        s.lock.release()


async def collect(gen):
    """Turn the SSE stream into a non-streaming Messages response."""
    msg, blocks_ = None, {}
    async for chunk in gen:
        ev = json.loads(chunk.split('data: ', 1)[1])
        t = ev['type']
        if t == 'message_start':
            msg = ev['message']
        elif t == 'content_block_start':
            blocks_[ev['index']] = dict(ev['content_block'])
        elif t == 'content_block_delta':
            d = ev['delta']
            b = blocks_[ev['index']]
            if d['type'] == 'text_delta':
                b['text'] += d['text']
            else:
                b['input'] = json.loads(d['partial_json'])
        elif t == 'message_delta':
            msg.update(ev['delta'])
            msg['usage'] = ev['usage']
        elif t == 'error':
            return JSONResponse(ev, status_code=500)
    msg['content'] = [blocks_[i] for i in sorted(blocks_)]
    return JSONResponse(msg)


def is_agy(body):
    return isinstance(body, dict) and str(body.get('model', '')).startswith(PREFIX)


async def messages(req):
    raw = await req.body()
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    if not is_agy(body):
        return await passthrough(req, raw)
    gen = run(body, req.headers)
    if body.get('stream'):
        return StreamingResponse(gen, media_type='text/event-stream', headers={'cache-control': 'no-cache'})
    return await collect(gen)


async def count_tokens(req):
    raw = await req.body()
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    if not is_agy(body):
        return await passthrough(req, raw)
    return JSONResponse({'input_tokens': len(raw) // 4})


HOP = {'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive'}


async def passthrough(req, raw=None):
    raw = await req.body() if raw is None else raw
    url = UPSTREAM + req.url.path + (f'?{req.url.query}' if req.url.query else '')
    headers = {k: v for k, v in req.headers.items() if k.lower() not in HOP}
    up = await http.send(http.build_request(req.method, url, headers=headers, content=raw), stream=True)
    return StreamingResponse(up.aiter_raw(), status_code=up.status_code,
                             headers={k: v for k, v in up.headers.items() if k.lower() not in HOP},
                             background=BackgroundTask(up.aclose))


# ---------- MCP side (agy -> Claude Code tools) ----------

async def await_call(c):
    try:
        res = await asyncio.wait_for(asyncio.shield(c.fut), MCP_HOLD)
    except asyncio.TimeoutError:
        return {'content': [{'type': 'text', 'text':
                f'[bridge] {c.name} is still running in Claude Code (call_id {c.id}). Its result is not available yet. '
                f'Call the cc_cc tool wait_for_result with {{"call_id": "{c.id}"}} to keep waiting. Do not run it again.'}]}
    except asyncio.CancelledError:
        return {'content': [{'type': 'text', 'text': 'The user interrupted this tool call.'}], 'isError': True}
    c.delivered = True
    return res


def planned_siblings(meta, name, args):
    """The cc_cc calls agy planned in the same step after this one, or None if agy hasn't logged the plan yet.

    agy runs a step's MCP calls one at a time; reading its plan lets Claude Code run them together.
    The plan is matched by step index (progressToken "<id>:<step>"), so a repeated identical call
    from another step can never be mistaken for this one. Anything unexpected turns this off.
    """
    try:
        step = int(str(meta['progressToken']).rsplit(':', 1)[1])
        path = Path(meta['antigravity.google/artifacts_dir']) / '.system_generated/logs/transcript_full.jsonl'
        with open(path, 'rb') as f:
            f.seek(max(0, path.stat().st_size - 4_000_000))
            lines = f.read().splitlines()
    except (KeyError, ValueError, IndexError, OSError):
        return []
    for line in reversed(lines):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get('type') != 'PLANNER_RESPONSE' or not isinstance(r.get('step_index'), int) or r['step_index'] >= step:
            continue
        calls = [norm_call(t) for t in r.get('tool_calls') or []]
        pos = step - r['step_index'] - 1   # each planned call runs as its own step, in order
        if pos >= len(calls) or calls[pos] != (name, args):
            return None
        return [c for c in calls[pos + 1:] if c and c[0] != 'wait_for_result']
    return None


def norm_call(t):
    """(tool, input) for a cc_cc call in agy's plan, else None."""
    a = t.get('args') or {}
    if t.get('name') != 'call_mcp_tool' or a.get('ServerName') != MCP_SERVER:
        return None
    n, i = a.get('ToolName'), a.get('Arguments') or {}
    try:
        i = json.loads(i) if isinstance(i, str) else i
    except ValueError:
        return None
    if n == 'call_tool' and isinstance(i, dict):
        n, i = i.get('name'), i.get('input') or {}
    return n, i


async def mcp_call(params):
    conv = (params.get('_meta') or {}).get('antigravity.google/conversation_id')
    s = BY_CONV.get(conv)
    if not s:
        return {'content': [{'type': 'text', 'text': 'No Claude Code session is attached to this conversation.'}], 'isError': True}
    name, args = params.get('name'), params.get('arguments') or {}
    if not s.tools_ok:
        return {'content': [{'type': 'text', 'text': 'Tools are not available for this request. Reply with plain text only.'}], 'isError': True}
    if name == 'wait_for_result':
        c = s.calls.get(args.get('call_id'))
        if not c:
            return {'content': [{'type': 'text', 'text': 'Unknown call_id.'}], 'isError': True}
        return await await_call(c)
    if name == 'call_tool':
        name, args = args.get('name'), args.get('input') or {}
    for c in s.planned:   # sent to Claude Code together with an earlier call of this step
        if c.name == name and c.input == args:
            s.planned.remove(c)
            return await await_call(c)
    s.planned = []
    siblings, t0 = None, time.time()
    while siblings is None and time.time() - t0 < 1:   # agy logs its plan a moment after starting the call
        siblings = planned_siblings(params.get('_meta') or {}, name, args)
        if siblings is None:
            await asyncio.sleep(0.03)
    log.info('session %s: plan lookup %.2fs, %s siblings', s.sid, time.time() - t0, 'no' if siblings is None else len(siblings))
    c = Call(name, args)
    s.calls[c.id] = c
    s.q.put_nowait(('tool', c))
    for n, a in siblings or []:
        p = Call(n, a)
        s.calls[p.id] = p
        s.planned.append(p)
        s.q.put_nowait(('tool', p))
    if s.planned:
        log.info('session %s: sending %d planned tool calls together', s.sid, len(s.planned) + 1)
    return await await_call(c)


async def mcp(req):
    body = await req.json()
    if 'id' not in body:
        return Response(status_code=202)
    m, params = body.get('method'), body.get('params') or {}
    if m == 'initialize':
        result = {'protocolVersion': params.get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'claude-code', 'version': '1'},
                  'instructions': "Claude Code's tools. Use these instead of your built-in tools."}
    elif m == 'tools/list':
        result = {'tools': mcp_tool_list()}
    elif m == 'tools/call':
        result = await mcp_call(params)
    else:
        result = {}
    return JSONResponse({'jsonrpc': '2.0', 'id': body['id'], 'result': result},
                        headers={'mcp-session-id': req.headers.get('mcp-session-id') or uuid.uuid4().hex})


# ---------- housekeeping ----------

async def reaper():
    while True:
        await asyncio.sleep(60)
        for s in list(SESSIONS.values()):
            if s.proc and not s.busy and not s.lock.locked() and time.time() - s.last > (SUBAGENT_IDLE if s.agent else IDLE_KILL):
                log.info('session %s: idle, stopping agy', s.sid)
                await s.stop()


async def sync_model_picker():
    """Mirror `agy models` into Claude Code's /model picker (keeps non-agy rows)."""
    try:
        p = await asyncio.create_subprocess_exec(AGY, 'models', stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(p.communicate(), 60)
        rows = [l.split('\t', 1) for l in out.decode().splitlines() if '\t' in l]
        if not rows:
            return
        settings = json.loads(CLAUDE_SETTINGS.read_text())
        picker = settings.setdefault('modelPicker', {})
        keep = [o for o in picker.get('options', []) if not str(o.get('model', '')).startswith(PREFIX)]
        new = keep + [{'model': PREFIX + mid, 'label': f'agy · {name}', 'description': f'{name} via Antigravity CLI', 'behavesAs': BEHAVES_AS.get(mid.split('-')[0], BEHAVES_AS_DEFAULT)} for mid, name in rows]
        if picker.get('options') != new:
            picker['options'] = new
            tmp = CLAUDE_SETTINGS.with_suffix('.agy-bridge.tmp')
            tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + '\n')
            tmp.replace(CLAUDE_SETTINGS)
            log.info('model picker updated: %d agy models', len(rows))
    except Exception:
        log.exception('model picker sync failed')


@contextlib.asynccontextmanager
async def lifespan(app):
    load_state()
    tasks = [asyncio.create_task(reaper()), asyncio.create_task(sync_model_picker())]
    log.info('agy-bridge listening on 127.0.0.1:%d', PORT)
    yield
    for t in tasks:
        t.cancel()
    for s in SESSIONS.values():
        await s.stop()


async def health(req):
    return JSONResponse({'ok': True, 'sessions': len(SESSIONS), 'live': sum(1 for s in SESSIONS.values() if s.proc)})


app = Starlette(lifespan=lifespan, routes=[
    Route('/v1/messages', messages, methods=['POST']),
    Route('/v1/messages/count_tokens', count_tokens, methods=['POST']),
    Route('/mcp', mcp, methods=['POST']),
    Route('/mcp', lambda r: Response(status_code=405), methods=['GET', 'DELETE']),
    Route('/agy-bridge/health', health),
    Route('/.well-known/{path:path}', lambda r: Response(status_code=404)),   # agy's MCP OAuth probes
    Route('/{path:path}', passthrough, methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
])

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=PORT, log_level='warning')
