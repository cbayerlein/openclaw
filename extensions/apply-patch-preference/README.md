# Apply Patch Preference Plugin

Adds an optional global guardrail to prefer `apply_patch` for patch-style file edits.

It does not register an agent tool; it only enforces tool-call behavior.

## Enable

```json
{
  "plugins": {
    "entries": {
      "apply-patch-preference": { "enabled": true }
    }
  }
}
```

## Mode

```json
{
  "plugins": {
    "entries": {
      "apply-patch-preference": {
        "enabled": true,
        "config": { "enforcementMode": "block" }
      }
    }
  }
}
```

Modes:

- `off` (default): no guardrail
- `warn`: log when `edit` or patch-style in-place `exec` is used
- `block`: block `edit` and patch-style in-place `exec`; prefer `apply_patch`
