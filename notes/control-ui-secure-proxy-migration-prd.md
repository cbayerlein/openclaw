# PRD: Migrate Control UI to a Standard-Compliant Secure Reverse-Proxy Setup

## Status

Draft for later implementation after the current upgrade/rebase work is stabilized.

## Problem

The current host uses a workable but non-standard compatibility setup for the OpenClaw Control UI:

- Apache terminates TLS on `:443`
- Apache proxies internally to the gateway over plain HTTP on `127.0.0.1:18789`
- OpenClaw is configured with:
  - `gateway.controlUi.allowInsecureAuth = true`
  - `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true`
- Security audit suppression is enabled with:
  - `OPENCLAW_SECURITY_AUDIT_ALLOW_INSECURE_HTTP_GATEWAY=1`

This setup is operationally acceptable for the current host, but it depends on compatibility toggles and an audit override that should ideally be removed.

## Goals

- Remove the need for `gateway.controlUi.allowInsecureAuth = true`
- Remove the need for `OPENCLAW_SECURITY_AUDIT_ALLOW_INSECURE_HTTP_GATEWAY=1`
- If possible, remove the need for `dangerouslyAllowHostHeaderOriginFallback`
- Keep external access through the reverse proxy working
- Preserve operator usability during migration

## Non-Goals

- Replace Apache unless there is a strong technical reason
- Move the gateway off loopback
- Redesign the whole host deployment model
- Force a user-service migration if systemd system service remains the better fit

## Current Host Facts

- Gateway runs as a **systemd system service**: `openclaw-gateway.service`
- Effective gateway command:
  - `/usr/bin/node /root/openclaw/dist/entry.js gateway --port 18789`
- Service environment file:
  - `/etc/openclaw/gateway.env`
- Active state/config path:
  - `/var/lib/openclaw/state/openclaw.json`
- Reverse proxy:
  - Apache on `:80` and `:443`
  - external HTTPS
  - internal proxy target `http://127.0.0.1:18789`
  - forwarded headers include `X-Forwarded-Proto=https` and `X-Forwarded-Port=443`

## User Stories

- As an operator, I want the Control UI to work through the reverse proxy without compatibility flags.
- As an operator, I want security audit output to be clean without suppressing findings that are no longer relevant.
- As a maintainer, I want the deployment to align with upstream expectations as closely as practical.
- As a maintainer, I want a rollback path if the stricter setup breaks browser access.

## Desired End State

- OpenClaw Control UI works behind Apache with standard forwarded-header handling.
- `gateway.controlUi.allowInsecureAuth` is removed or set to `false`.
- `OPENCLAW_SECURITY_AUDIT_ALLOW_INSECURE_HTTP_GATEWAY` is removed.
- If possible, `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback` is removed.
- `openclaw security audit` no longer reports the suppressed insecure-auth finding because the underlying cause is gone.

## Open Design Question

There are two plausible end states:

### Option A: Keep Apache TLS termination, make OpenClaw trust the proxied secure context cleanly

This is the preferred direction if upstream OpenClaw can be configured to correctly recognize:

- secure external origin
- trusted proxy headers
- canonical host/origin

without `allowInsecureAuth` and without host-header fallback bypasses.

### Option B: Move part of the secure-context responsibility into OpenClaw or a different local proxy arrangement

This is only a fallback if Option A is not possible without invasive OpenClaw changes.

## Functional Requirements

### FR1: Preserve External HTTPS Access

- Browsers must continue to access the Control UI via HTTPS on the existing host.
- Existing proxy paths for gateway UI, `/api`, `/auth`, `/ws`, and static assets must remain functional.

### FR2: Remove Insecure-Auth Compatibility Toggle

- The migration must aim to eliminate `gateway.controlUi.allowInsecureAuth`.
- The UI must still authenticate correctly after removal.

### FR3: Evaluate Host Header Fallback Removal

- The migration must explicitly test whether `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback` is still needed.
- If not needed, remove it.
- If still needed, document exactly why.

### FR4: Remove Audit Suppression

- After the secure setup is validated, remove:
  - `OPENCLAW_SECURITY_AUDIT_ALLOW_INSECURE_HTTP_GATEWAY=1`
- Security audit should pass without relying on suppression for this finding.

### FR5: Trusted Proxy Validation

- Confirm the `trustedProxies` configuration is minimal and correct.
- Ensure forwarded headers are sufficient and consistent.

### FR6: Rollback Safety

- Migration steps must be reversible.
- Rollback instructions must restore current behavior quickly.

## Investigation Tasks

1. Verify exactly why `allowInsecureAuth` was needed originally.
2. Verify whether the root cause is:
   - secure-context detection
   - origin/host mismatch
   - missing forwarded header trust
   - WebSocket handshake path mismatch
   - browser/device-auth flow assumptions
3. Test Control UI behavior with:
   - only `allowInsecureAuth` removed
   - only `dangerouslyAllowHostHeaderOriginFallback` removed
   - both removed
4. Confirm whether Apache config already provides the headers OpenClaw needs.
5. Confirm whether any OpenClaw upstream improvement would reduce the need for local compatibility flags.

## Validation Plan

- Functional validation:
  - load Control UI over external HTTPS
  - authenticate successfully
  - connect to gateway
  - verify WebSocket connection stability
- Security validation:
  - run `openclaw security audit`
  - run `openclaw security audit --deep`
  - confirm the insecure-auth finding is gone for the right reason
- Regression validation:
  - verify reverse-proxied `/api`, `/auth`, `/ws`, and root UI still work

## Recommended Implementation Order

1. Capture current working Apache/OpenClaw config snapshot.
2. Build a minimal test matrix around the two Control UI flags.
3. Try removing `allowInsecureAuth` first while keeping host-header fallback unchanged.
4. If stable, try removing host-header fallback too.
5. Remove audit suppression env var only after the above is validated.
6. Document final Apache/OpenClaw config as the canonical host setup.

## Risks

- Control UI login/connect flow may silently regress
- WebSocket handshake may fail only in browser context, not in CLI tests
- Secure-context logic may differ across browser/device combinations
- Host-header checks may be masking a deeper proxy integration issue

## Acceptance Criteria

- Control UI works through Apache HTTPS without `gateway.controlUi.allowInsecureAuth`
- Audit suppression env var is no longer needed
- If feasible, host-header fallback bypass is removed too
- `openclaw security audit --deep` no longer requires a local policy exception for this setup
- Rollback steps are documented and tested
