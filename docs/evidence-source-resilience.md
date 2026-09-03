# Evidence source resilience

SKSK ProTech diagnostic operation must not depend on any single external manual provider.

Policy: `NO_SINGLE_EXTERNAL_SOURCE_REQUIRED`.

## Source classes

- `OFFICIAL_STORED` — locally stored official/public bulletin data such as the NHTSA bulk corpus.
- `OFFICIAL_PUBLIC_API` — live official/public APIs such as NHTSA ODI.
- `INTERNAL_TRUSTED` — SKSK-owned trusted evidence such as confirmed repair outcomes.
- `STORED_EVIDENCE_INDEX` — persisted published-evidence indexes used by retrieval.
- `OPTIONAL_EXTERNAL_REFERENCE` — replaceable external reference providers such as LEMON Manuals.

Every source is independently observable as `AVAILABLE`, `DEGRADED`, `UNAVAILABLE`, or `SKIPPED`. External reference providers are never marked required.

## LEMON Manuals boundary

LEMON Manuals is an optional evidence source. Diagnose and Quick Ask continue when it times out, errors, disappears, or is disabled.

`LEMON_EVIDENCE_ENABLED=false` is the operational kill switch for LEMON-backed manual and TSB retrieval. This does not disable SKSK diagnosis, TEST, VERIFY, Estimate, Invoice, stored NHTSA bulletin evidence, trusted mechanic observations, deterministic logic, or confirmed repair history.

The application does not attempt to evade provider access restrictions or locate mirrors when the provider is unavailable.

## Diagnostic behavior during an outage

A source outage is retrieval telemetry, not vehicle evidence. The model is explicitly told that an unavailable source does not prove a fault is absent.

The Diagnose response exposes:

- `result.evidence.sourceHealth.policy`
- `result.evidence.sourceHealth.diagnosticOperation`
- per-source status/class/durability/evidence count
- `result.evidence.sourceStatusMessage`

The same sanitized source-health boundary is persisted inside the diagnostic evidence packet so later lifecycle steps retain the evidence conditions under which the diagnosis was produced.

Provider error details are retained only for operational logging. Raw provider failure text is not copied into the model-facing source-health packet.

## Quick Ask

Quick Ask already uses bounded parallel retrieval. The source-resilience boundary adds an explicit source-health summary and ensures the optional manual lane can fail or be disabled while stored published evidence and confirmed-repair history still return normally.

## Runtime proof

The PR runtime gate boots the exact Render preview head, simulates a LEMON outage using a preview-only request header, calls the real `/api/diagnose` route, and proves:

1. Diagnose still returns HTTP 200 and a diagnostic candidate.
2. LEMON manual and LEMON TSB sources are marked skipped.
3. The policy remains `NO_SINGLE_EXTERNAL_SOURCE_REQUIRED` with operation `CONTINUE`.
4. No LEMON source is reported as used during the canary.
5. The source-health boundary is persisted on the lifecycle job.

Production ignores the preview-only outage header.
