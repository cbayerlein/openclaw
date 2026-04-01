# PRD: Plan and Edit Guardrails for OpenClaw Agents

## Status

Draft for later clean reimplementation on top of a fresh upstream-stable base.

## Problem

OpenClaw agents driven by GPT-5.4-class models do not consistently behave like the Codex harness in two areas:

1. Planning discipline
2. Edit-tool discipline

The historical custom patch series (`update-plan` and `apply-patch-preference`) attempted to push the runtime toward:

- explicit task planning before multi-step work
- visible progress state while work is ongoing
- preference for structured file edits instead of free-form shell editing
- reduced drift between what the model claims it will do and what it actually does

The old implementation is now mixed into a drifted branch and is not trustworthy enough to carry forward unchanged.

## Goals

- Reintroduce Codex-like planning discipline for OpenClaw agents.
- Make planning state machine-readable and observable.
- Bias agents toward safe, structured edit primitives.
- Keep the behavior configurable per deployment.
- Preserve compatibility with upstream OpenClaw architecture and plugin boundaries.

## Non-Goals

- Recreate the old patch set line-by-line.
- Force planning for trivial one-shot tasks.
- Add hard blockers that make agents unusable when a tool is temporarily unavailable.
- Encode provider-specific hacks into unrelated core surfaces.

## Users

- Operator running OpenClaw as a coding/reliability assistant
- Maintainer debugging agent behavior
- Future upstream contributor evaluating whether some subset is generally useful

## User Stories

- As an operator, I want the agent to publish a concise plan before it starts large work so I can see intent and catch wrong assumptions early.
- As an operator, I want progress state to update as work advances so long-running tasks are inspectable.
- As an operator, I want file edits to prefer structured patching over ad hoc shell writes.
- As a maintainer, I want to distinguish "model did not plan" from "plan tool unavailable" from "plan created but never updated".
- As a maintainer, I want this feature to be easy to disable or scope down per deployment.

## Desired Behavior

### Planning

- For substantial tasks, the agent should create a short plan before broad exploration or edits.
- Plan items should have stable statuses:
  - `pending`
  - `in_progress`
  - `completed`
- Only one step may be `in_progress` at a time.
- Plans should be revisable as new facts are discovered.
- Small/trivial tasks should be allowed to skip planning.

### Edit Guardrails

- When editing files, the agent should prefer the structured patch tool over shell-based rewrites.
- The system should be able to detect obvious bypass attempts, such as replacing files through heredocs or language-side file writes when a structured patch would suffice.
- The policy should allow exceptions for:
  - formatters
  - generated output
  - large binary or asset updates
  - cases where structured patching is genuinely impractical

### Visibility

- Plan creation and updates should be inspectable in logs and, where appropriate, UI/control surfaces.
- Violations or bypass attempts should be visible to operators.
- The policy should support soft-enforcement first, then harder enforcement if desired.

## Functional Requirements

### FR1: Planning Tool Contract

- Provide a planning interface with:
  - create/update behavior
  - stable statuses
  - concise explanation field
- Validate plan status values strictly.
- Reject malformed state transitions where appropriate.

### FR2: Policy Modes

- Support at least three policy levels:
  - `off`
  - `advisory`
  - `enforced`
- `off`: no planning/edit preference behavior
- `advisory`: violations logged but not blocked
- `enforced`: selected violations block or redirect the action

### FR3: Task Classification

- Detect whether a task is trivial or substantial.
- Signals may include:
  - number of files touched
  - duration
  - use of search/exploration tools
  - multi-step shell or tool activity
- Classification must be conservative and overridable.

### FR4: Structured Edit Preference

- Detect file-writing operations outside the structured patch path.
- In advisory mode, emit diagnostics.
- In enforced mode, reject or require an explicit exception path.

### FR5: Observability

- Emit structured events for:
  - plan created
  - plan updated
  - policy violation
  - enforcement block
  - explicit exception used
- Include agent/session identifiers and timestamps.

### FR6: Configurability

- Config must support:
  - enable/disable
  - planning mode
  - edit-guard mode
  - trivial-task thresholds
  - exception allowlist for known safe commands

### FR7: Compatibility

- Must work with GPT-5.4-class coding models.
- Must not assume a specific provider implementation.
- Must not require custom fork-only plugin SDK exports unless intentionally introduced and documented.

## Architecture Direction

- Prefer a clean, explicit plugin or runtime seam over hidden monkeypatching.
- Keep planning and edit-guard logic separable:
  - planning state contract
  - enforcement policy
  - observability surface
- Avoid embedding this as a pile of heuristics across unrelated files.

## UX Considerations

- Plans should be short and high-signal.
- Diagnostics should explain:
  - what policy fired
  - why it fired
  - how to proceed
- Operator-facing wording should distinguish recommendation from enforcement.

## Open Questions

- Should planning state live only in runtime events, or also persist per session?
- Should edit-guard enforcement happen at tool dispatch time, shell wrapper time, or both?
- Should the feature apply to all agent lanes or only coding-oriented lanes?
- Should subagents inherit the same policy automatically?
- Is upstream alignment best achieved through a plugin, a core optional feature, or a hybrid seam?

## Recommended Implementation Order

1. Define the clean config and event model.
2. Reimplement plan contract with advisory mode only.
3. Reimplement structured edit preference with advisory diagnostics.
4. Add UI/log visibility.
5. Add enforced mode behind explicit config.
6. Validate against real GPT-5.4 coding sessions.

## Acceptance Criteria

- A substantial coding task produces an inspectable plan before broad edits.
- Plan updates remain valid and machine-readable throughout the run.
- Structured patch preference is observable in logs/events.
- Advisory mode does not break normal operation.
- Enforced mode blocks obvious non-structured file writes while allowing known safe exceptions.
- The feature can be fully disabled without side effects.
