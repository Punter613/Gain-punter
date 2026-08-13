# SKSK Active Integration Status

## Completed / merged foundation

PR #69 — **Add targeted Lemon evidence normalization and scrape workflow** — is **merged into `main`** and should be treated as completed foundation work.

Runtime validation was performed against the 2008 Kia Sorento 4WD 3.8L in Codespaces. The live scrape was used to tighten:
- drivetrain applicability
- trigger preservation (`deceleration`, `turning`, `full_lock`)
- exact DTC retrieval (including P0171/P0300)
- relevance filtering
- duplicate consolidation
- title/heading qualification so path/body chrome does not create false system matches

Do **not** rebuild or reopen that Lemon foundation unless a specific regression is found.

## Current active branch

`feature/diag-estimate-production-integration`

Purpose: production wiring of the merged Lemon evidence into the live workflow:

`Diagnose -> competing hypotheses -> manufacturer/TSB evidence -> discriminating tests -> verification gate -> Estimate`

Key rules:
- TSB/manufacturer information is a flashlight, not a verdict.
- Preserve source evidence separately from SKSK-derived interpretation.
- Do not authorize replacement from an unverified hypothesis.
- Keep competing routes alive until a discriminating test prunes them.
- Track symptom/repair timeline because repairs can change compliance/load paths and mutate symptoms.
- If a verified repair does not remove the symptom, do not automatically conclude it was unrelated; reassess downstream or separate faults.
- Estimate must use verified repair scope only.
- No fabricated parts cost, labor hours, torque values, or repair economics.
- Multiple verified faults should be staged by safety, damage propagation, repair dependency, diagnostic leverage, and customer affordability, with retest gates between stages.

## Future reuse

Once Diagnose/Estimate production integration is proven, adapt the same evidence/causal logic to:
- Consumer / pre-purchase vehicle inspection
- Fleet maintenance and recurring-fault timelines
