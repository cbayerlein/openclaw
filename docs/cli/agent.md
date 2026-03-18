---
summary: "CLI reference for `openclaw agent` (send one agent turn via the Gateway)"
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
title: "agent"
---

# `openclaw agent`

Run an agent turn via the Gateway (use `--local` for embedded).
Use `--agent <id>` to target a configured agent directly.

Related:

- Agent send tool: [Agent send](/tools/agent-send)

## Examples

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --agent ops --message "Use Opus once" --model opus
openclaw agent --agent ops --message "Use Opus later too" --model opus --persist-model
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --session-id 1234 --message "Summarize inbox" --model openai/gpt-5.2 --thinking medium
openclaw agent --agent ops --new-session --message "Start fresh"
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Notes

- `--model <provider/model|alias>` applies only to the current turn by default.
- Add `--persist-model` to save the model override on the targeted session.
- `--thinking <level>` persists the thinking level on the targeted session.
- `--new-session` starts a fresh session on the selected target.
- `--new-session` cannot be combined with `--session-id`.
- When this command triggers `models.json` regeneration, SecretRef-managed provider credentials are persisted as non-secret markers (for example env var names, `secretref-env:ENV_VAR_NAME`, or `secretref-managed`), not resolved secret plaintext.
- Marker writes are source-authoritative: OpenClaw persists markers from the active source config snapshot, not from resolved runtime secret values.
