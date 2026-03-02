# Update Plan Plugin

Adds an optional `update_plan` agent tool for compact multi-step progress updates.

The tool validates:

- `plan` must be an array of `{ step, status }`
- `status` must be one of `pending`, `in_progress`, `completed`
- `step` must be a non-empty string
- at most one step may be `in_progress`

The latest plan is persisted locally under:

- `<stateDir>/plugins/update-plan/last-plan.json`
- `<stateDir>/plugins/update-plan/sessions/<session>.json` (when `sessionKey` is available)

`stateDir` is resolved from `api.runtime.state.resolveStateDir()`.

## Enable

```json
{
  "plugins": {
    "entries": {
      "update-plan": { "enabled": true }
    }
  }
}
```

## Allowlist (optional tool)

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["update_plan"] }
      }
    ]
  }
}
```
