# SKSK Active Integration Status

## Completed / merged foundation

### PR #69 — targeted Lemon evidence normalization

PR #69 is **merged into `main`** and should be treated as completed foundation work.

Runtime validation was performed against the 2008 Kia Sorento 4WD 3.8L in Codespaces. The live scrape was used to tighten:
- drivetrain applicability
- trigger preservation (`deceleration`, `turning`, `full_lock`)
- exact DTC retrieval (including P0171/P0300)
- relevance filtering
- duplicate consolidation
- title/heading qualification so path/body chrome does not create false system matches

Do **not** rebuild or reopen that Lemon foundation unless a specific regression is found.

### PR #70 — repair authorization guard foundation

PR #70 is **merged into `main`**. It contains the deterministic repair authorization primitive, its tests, and this integration-status breadcrumb.

Important: PR #70 **did not finish the live route/UI wiring**. It merged while further work was still being added to the same branch. Do not mistake "PR #70 merged" for "Diagnose -> Verify -> Estimate complete."

The guard now requires BOTH:
1. an explicit mechanic VERIFY action, and
2. at least one bounded verified fault.

A model hypothesis, code, symptom, probability, or `diagnosisVerified: true` without a bounded fault must not authorize repair.

## Current active branch

`feature/diag-estimate-route-wiring`

This is the continuation branch created after PR #70 merged. It owns the remaining production wiring.

Current work on this branch includes:
- persisted-job -> authorization adapter
- protected `/api/jobs/:id/verify` wrapper that requires an explicit confirmed cause
- protected `/api/estimateHeuristic` wrapper
- protected legacy `/api/full-estimate` boundary
- guarded backend entrypoint (`api/server.route-wiring.js`)
- browser lifecycle script (`public/js/diag-estimate-lifecycle.js`)
- tests for persisted verification authorization

The production workflow being implemented is:

`Diagnose -> competing hypotheses -> manufacturer/TSB evidence -> discriminating tests -> record test -> explicit mechanic VERIFY -> Estimate`

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

## Production gate still required

Before merging the current branch:
- load the browser lifecycle script from the actual served `public/index.html`
- run syntax/tests
- exercise the real route sequence end-to-end
- confirm unverified Estimate returns 409
- confirm a recorded test + explicit bounded verification unlocks Estimate
- confirm CI is green

## Future reuse

Once Diagnose/Estimate production integration is proven, adapt the same evidence/causal logic to:
- Consumer / pre-purchase vehicle inspection
- Fleet maintenance and recurring-fault timelines
