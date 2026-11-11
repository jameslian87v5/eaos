## Agent Bridge Collaboration

Use the new Agent Bridge only.

Do not write new events to `.codex-bridge/`.
Do not use `node scripts/bridge.mjs`.

Use:

```bash
node agent-bridge/bridge.mjs --config agent-bridge/agent-bridge.workspace.json ...
```

Runtime directory:

```text
.agent-bridge/workspaces/simple-chatapp/
```

Agent names:

```text
codex
claude-code
```

If you are Codex receiving work:

1. Read `.agent-bridge/workspaces/simple-chatapp/inflight/<event_id>.json`.
2. Verify `"to": "codex"`.
3. If `bodyFile` is present, read it first.
4. Inspect referenced files and git diff when relevant.
5. Write `.agent-bridge/workspaces/simple-chatapp/reviews/<event_id>.review.md`.
6. Write `.agent-bridge/workspaces/simple-chatapp/acks/<event_id>.json`.

If you are Codex sending work to Claude Code:

1. Create an event in `.agent-bridge/workspaces/simple-chatapp/queue/`.
2. Set `"from": "codex"` and `"to": "claude-code"`.
3. For non-trivial requests, write `.agent-bridge/workspaces/simple-chatapp/artifacts/<event_id>.request.md` and include `bodyFile`.

Non-trivial request Markdown must include:

- Context
- Request
- Constraints
- Relevant files
- Expected output

Do not put required follow-up work only inside a review. If the other agent must act, create a new queue event with `replyTo` and `threadId`.
