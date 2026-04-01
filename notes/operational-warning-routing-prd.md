# PRD: Operational Warning and Alert Routing

## Status

Draft for later clean reimplementation on top of a fresh upstream-stable base.

## Problem

Operationally noisy failures currently risk leaking into user-facing chats:

- tool failures such as `exec` / `bash`
- heartbeat run issues
- cron job failures
- scheduler/runtime faults
- other non-user-actionable diagnostics

The desired behavior is to keep primary chats clean while still delivering important operational signals to a dedicated destination such as a Telegram warnings group.

The current custom branch already contains a partial implementation for structured tool warning routing, but it does not fully cover the broader operational-alert intent.

## Goals

- Route operational warnings away from normal user chats.
- Deliver them to a dedicated operator channel when configured.
- Deduplicate noisy repeats.
- Preserve fallback behavior when routing fails.
- Use one consistent alert pipeline for tool warnings, heartbeat issues, and cron/runtime failures.

## Non-Goals

- Replace normal business/user replies with alerts.
- Build a full observability platform or metrics system.
- Spam operator channels with low-value duplicates.
- Introduce transport-specific logic for every channel surface.

## Users

- Operator monitoring OpenClaw in production
- Maintainer debugging failed automation or tools
- End users who should not see internal operational noise in ordinary chats

## User Stories

- As an operator, I want `exec` failures to go to a warnings group instead of the main chat.
- As an operator, I want heartbeat and cron failures routed the same way.
- As an operator, I want repeated identical failures deduplicated.
- As a maintainer, I want structured alert events that can be tested and extended.
- As a maintainer, I want routing failure to degrade gracefully rather than losing the signal silently.

## Desired Behavior

### Core Routing

- User-facing chats should stay free of operational noise by default when a warning route is configured.
- Alerts should be routed to a dedicated target:
  - channel type
  - destination id
- Routing should support fallback behavior:
  - deliver to operator target only
  - deliver to user chat only
  - deliver to both
  - deliver to user chat only if operator route fails

### Alert Types

- Tool warnings:
  - `exec`
  - `bash`
  - mutating-tool failures
  - selected recoverable/non-recoverable tool failures
- Heartbeat warnings:
  - run failures
  - delivery failures
  - repeated degraded health
- Cron warnings:
  - isolated run failures
  - schedule errors
  - retry exhaustion
- Runtime warnings:
  - startup failures worth operator visibility
  - routing failures inside the warning pipeline itself

### Deduplication

- Deduplicate repeated alerts by stable fingerprint.
- Dedupe window must be configurable.
- Different error texts for the same coarse action should not collapse incorrectly.

## Functional Requirements

### FR1: Unified Alert Event Type

- Introduce a single structured event family for operational alerts.
- Required fields:
  - `kind`
  - `severity`
  - `text`
  - `fingerprint`
  - `ts`
  - source metadata
- Optional source metadata examples:
  - `toolName`
  - `jobId`
  - `agentId`
  - `sessionKey`
  - `subsystem`

### FR2: Routing Policy

- Config must support:
  - enabled/disabled
  - target channel
  - target id
  - source filters
  - severity filters
  - fallback mode
  - dedupe window

### FR3: Source Coverage

- Tool warnings must emit into the unified alert pipeline.
- Heartbeat runner must emit into the same pipeline.
- Cron isolated runs and scheduler/service-level errors must emit into the same pipeline.

### FR4: Routing Execution

- Routing must be transport-agnostic and reuse existing reply-routing seams where possible.
- Operator-channel delivery must not mirror into user-facing sessions unless configured.
- Failures in the alert route must themselves be logged with minimal recursion risk.

### FR5: Dedupe

- Fingerprint generation must include enough detail to avoid over-collapsing distinct failures.
- Rate limiting must be bounded in memory.

### FR6: User-Chat Fallback

- Policy must support:
  - no fallback
  - fallback on route missing
  - fallback on route failure
  - always also surface in user chat

### FR7: Testing

- Unit tests must cover:
  - exec-only routing
  - broad routing
  - dedupe behavior
  - route failure fallback
  - missing-route fallback
  - heartbeat/cron source mapping

## Architecture Direction

- Keep alert generation separate from alert routing.
- Prefer a small reusable alert-routing module over bespoke per-subsystem delivery code.
- Reuse existing channel routing helpers instead of duplicating Telegram-specific delivery logic.
- Make the event model additive so upstream adoption remains plausible.

## Config Direction

- Replace narrowly named tool-only settings with a broader operational-alert config.
- Maintain a compatibility migration path from any existing `messages.toolWarnings.*` settings.

Suggested target shape:

```json
{
  "messages": {
    "operationalAlerts": {
      "enabled": true,
      "target": "telegram",
      "to": "-1001234567890",
      "sources": ["tool", "heartbeat", "cron", "runtime"],
      "severities": ["warn", "critical"],
      "fallback": "on-route-failure",
      "dedupeWindowMs": 600000
    }
  }
}
```

## Migration Notes

- Existing tool-warning routing logic can be the implementation seed, not the final design.
- Legacy config such as `messages.toolWarnings.*` should map forward.
- Existing operator expectations for Telegram warning-group delivery should be preserved.

## Open Questions

- Should alert routing support multiple targets from day one?
- Should there be severity escalation behavior after repeated identical alerts?
- Should alerts also appear in a web/control UI event feed?
- Should heartbeat and cron alerts use separate default severities?

## Recommended Implementation Order

1. Define unified alert event schema.
2. Generalize existing tool-warning routing into source-agnostic alert routing.
3. Add heartbeat event emission.
4. Add cron/service event emission.
5. Add compatibility migration from `messages.toolWarnings`.
6. Validate with a dedicated Telegram warning-group setup.

## Acceptance Criteria

- `exec` failures can be routed to a dedicated Telegram warnings group without appearing in the main chat.
- Heartbeat and cron failures can use the same route.
- Repeated identical failures are deduplicated within a configured time window.
- Routing failure degrades according to explicit fallback policy.
- Existing user-facing reply delivery remains unchanged for non-operational content.
