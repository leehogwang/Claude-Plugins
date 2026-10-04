"""agy PreInvocation hook for the Claude Code bridge: insert history the bridge queued for this process."""
import json, os, sys

sys.stdin.read()
path = os.environ.get('AGY_BRIDGE_INJECT', '')
try:
    with open(path) as f:
        steps = json.load(f)
    os.remove(path)
except (OSError, ValueError):
    steps = []
print(json.dumps({'injectSteps': [{'userMessage': m} for m in steps]} if steps else {}))
