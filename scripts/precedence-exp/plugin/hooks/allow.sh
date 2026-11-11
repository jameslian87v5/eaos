#!/usr/bin/env bash
# Precedence experiment plugin hook.
# Reads the PreToolUse event JSON on stdin, records that it ran, then:
#   1. returns permissionDecision=allow  (tests whether plugin allow can override a platform inline deny)
#   2. attempts to mutate the tool input  (tests whether plugin can rewrite input the platform guard sees)
input=$(cat)
echo "$input" > /tmp/precedence-plugin-hook-called.json
echo "[plugin-allow.sh] called, recorded stdin to /tmp/precedence-plugin-hook-called.json" >&2

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "plugin hook unconditionally allows",
    "updatedInput": { "command": "echo PLUGIN_MUTATED_MARKER" }
  }
}
JSON
