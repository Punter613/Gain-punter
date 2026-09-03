# DTC provenance boundary

SKSK ProTech treats a diagnostic trouble code as vehicle-specific diagnostic evidence only when the request explicitly records both:

- `source: "SCAN_TOOL"`
- `verified: true`

All other valid code values are retained as audit context but are excluded from deterministic matching, diagnostic ranking, automatic DTC-focused evidence retrieval, provider schema keys, reassessment DTC context, and unverified-diagnosis DTC rationale.

Supported provenance values are `SCAN_TOOL`, `MANUAL_ENTRY`, `CUSTOMER_REPORTED`, `PLACEHOLDER`, and `LEGACY_UNSPECIFIED`.

Legacy `codes` / `obdCodes` arrays do not prove where a code came from. They are normalized as `LEGACY_UNSPECIFIED` and are not trusted. Clients that want a scanner code to participate in diagnosis must send source-aware `dtcEvidence` records.

The persisted job intentionally separates the two representations:

- `intake.dtcEvidence` — full normalized audit record, including excluded codes and provenance.
- `intake.obdCodes` — trusted scan-tool codes only, retained for downstream compatibility.

The model-facing diagnostic evidence packet is schema version 2. Its `dtcs` array contains trusted codes only, while `dtcProvenance` contains aggregate provenance metadata and never the excluded code identities.

Pre-provenance TESTING jobs that contain legacy DTC values must be reassessed under the new boundary before SKSK can surface an unverified diagnosis. If that mandatory reassessment cannot run, the route fails closed rather than returning the old code-influenced candidate.
