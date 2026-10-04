"""agy PreToolUse gate for the Claude Code bridge: only Claude Code's tools (MCP server cc_cc) may run."""
import json, os, sys

d = json.load(sys.stdin)
tc = d.get('toolCall') or {}
name, args = tc.get('name'), tc.get('args') or {}
readable = [os.path.expanduser(p) for p in (
    '~/.gemini/antigravity-cli/mcp/cc_cc',     # Claude Code tool schemas
    '~/.gemini/antigravity-cli/brain',         # large tool outputs agy saved for itself
    '~/.local/share/agy-bridge/images',        # images the user attached
    '~/.local/share/agy-bridge/history')]      # transcripts too long to send inline
path = os.path.realpath(str(args.get('AbsolutePath', '')))
if name == 'call_mcp_tool' and args.get('ServerName') == 'cc_cc':
    out = {'decision': 'allow'}
elif name == 'view_file' and any(path.startswith(r + '/') for r in readable):
    out = {'decision': 'allow', 'permissionOverrides': ['read_file(%s)' % os.path.dirname(path)]}
else:
    out = {'decision': 'deny', 'reason': 'Disabled in Claude Code: use the cc_cc MCP tools (call_mcp_tool, ServerName "cc_cc") instead.'}
print(json.dumps(out))
