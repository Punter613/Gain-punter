# Render runtime verification gate

The backend Render service uses `api/` as its Root Directory. A pull-request commit that changes only files outside `api/` may not create a new backend preview deployment even when those files are imported by `api/server.js` at runtime.

SKSK's merge gate requires the **exact PR head SHA** to boot before diagnostic/lifecycle changes can land. Therefore runtime-sensitive PRs must have an `api/`-visible change so Render builds the exact head rather than leaving the preview on an earlier commit.

The PR preview exposes `IS_PULL_REQUEST=true` canaries through `api/server.js`:

- `/health/preview-evidence` — exercises VIN decode plus the real Quick Ask evidence route with the 2020 Kia Optima 2.4L / P1326 canary.
- `/health/preview-unverified-diagnosis` — seeds a disposable TESTING job, calls the real `POST /api/jobs/:id/unverified-diagnosis`, attempts an Estimate bypass, and verifies the rendered lifecycle UI.

CI selects canaries by the subsystem changed in the PR rather than making every runtime-sensitive PR depend on every unrelated canary. Evidence/Quick Ask/VIN/scraper changes run the evidence canary. Unverified-diagnosis/job-lifecycle/frontend fallback changes run the unverified canary. A change to `api/server.js` runs both because it owns both preview routes. All selected lanes still wait for `/health` to report the **exact PR head** before execution.

For DTC-anchored Quick Ask changes, `/health/preview-evidence` must run on the exact PR head so the real `POST /api/quick-ask` route executes the branch code. The runtime assertion requires P1326 to report DTC-anchored retrieval and rejects any returned reference title that explicitly names 1.6L for the decoded 2.4L Optima. Unit regressions additionally assert that generic `engine` references do not satisfy the DTC gate, multiple codes remain independent, and unknown codes fall back without invented meanings.

For cross-context manual-evidence reuse, exact-current-context cache remains first priority, but DTC-anchored exact-cache rows are revalidated before return so an old same-hash row cannot bypass newer applicability rules. A cold live crawl retains two bounded, vehicle-specific reuse layers without additional web requests: a lightweight corpus of pages it already fetched and a deduplicated navigation index of links observed under the resolved Repair & Diagnosis manual root. On a later exact miss or rejected exact row, stored pages are re-ranked locally first. If those pages are insufficient, same-vehicle navigation links are ranked by the current deterministic DTC context, then passed through the isolated worker as bounded high-priority seed URLs. Seed URLs are rechecked against the current resolved manual root inside the worker before fetch.

The deterministic DTC vocabulary resolved by Quick Ask is preserved across both manual ranking boundaries: the live crawler and the stored-corpus/navigation re-ranker. For example, P0300 retains `random misfire` / `cylinder misfire` and P0171 retains `system too lean` / `fuel trim` as high-signal scoring terms instead of collapsing them entirely into broad `engine` / `fuel_emissions` labels. These terms come only from SKSK's deterministic DTC registry. Unknown DTCs receive no invented vocabulary.

Page reuse remains strict evidence reuse: a stored page may qualify only by the literal code or the same code-specific meaning terms used by Quick Ask's final DTC applicability guard, and the match must be present in mechanic-visible source identity/text. Navigation is intentionally broader because it is not evidence. A known DTC may also use deterministic structural shortcuts such as the applicable Powertrain Management, Ignition, Fuel Delivery, Air Intake, Emission Control, or Testing/Inspection branch to reach a more specific page faster. These structural links are routing hints only: they do not claim DTC coverage, do not become a manual reference merely by being selected, and cannot satisfy the final evidence guard. Only the fetched page's visible source text can establish DTC coverage.

All navigation seeds use only visible link text/path, remain under the same resolved manual root, and are sourced only from rows with the exact vehicle/engine/drivetrain identity. Historical derived facts or prior-query metadata cannot rescue an unrelated evidence page. Explicit engine/drivetrain mismatches fail closed.

Seed probing has its own bounded fetch timeout and probe budget inside the existing worker-thread/hard-timeout boundary. When fetched seed pages visibly cover every resolved DTC anchor with diagnostic/test/spec evidence, the worker may stop before walking the manual root. If seed coverage is insufficient, the existing targeted root crawl remains the fallback. A seeded network fetch is not mislabeled as a cache hit; if it succeeds, its focused result is persisted normally so the next identical request can become an exact revalidated cache hit.

The reuse-specific CI canary uses the 2008 Kia Sorento 3.8L 4WD (`KNDJC736385765089`) with P0300/P0171 plus deceleration/full-lock context from the production latency case; it requires at least one focused manual reference, no manual timeout, <=5 seconds for the warm manual source, and a persisted cache hit on the repeat request. Render logs should demonstrate either local page reuse or stored-navigation seed probing rather than another full ~20-second manual-tree walk.

The unverified-diagnosis canary passes only when:

- the result state is `UNVERIFIED_DIAGNOSIS`;
- `physicallyVerified`, `repairAuthorized`, and `estimateReady` remain false;
- the persisted job remains `TESTING`;
- no `VERIFIED_CASE` is created;
- the Estimate bypass attempt returns HTTP 409; and
- the lifecycle page contains the explicit unverified-diagnosis warning/action.

`.github/workflows/ci.yaml` waits for `/health` to report the exact PR head before running each selected canary. A green unit-test run against a stale preview is not sufficient for merge.
