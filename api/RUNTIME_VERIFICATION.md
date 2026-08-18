# Render runtime verification gate

The backend Render service uses `api/` as its Root Directory. A pull-request commit that changes only files outside `api/` may not create a new backend preview deployment even when those files are imported by `api/server.js` at runtime.

SKSK's merge gate requires the **exact PR head SHA** to boot before diagnostic/lifecycle changes can land. Therefore runtime-sensitive PRs must have an `api/`-visible change so Render builds the exact head rather than leaving the preview on an earlier commit.

The PR preview exposes `IS_PULL_REQUEST=true` canaries through `api/server.js`:

- `/health/preview-evidence` — exercises VIN decode plus the real Quick Ask evidence route with the 2020 Kia Optima 2.4L / P1326 canary.
- `/health/preview-unverified-diagnosis` — seeds a disposable TESTING job, calls the real `POST /api/jobs/:id/unverified-diagnosis`, attempts an Estimate bypass, and verifies the rendered lifecycle UI.

CI selects canaries by the subsystem changed in the PR rather than making every runtime-sensitive PR depend on every unrelated canary. Evidence/Quick Ask/VIN/scraper changes run the evidence canary. Unverified-diagnosis/job-lifecycle/frontend fallback changes run the unverified canary. A change to `api/server.js` runs both because it owns both preview routes. All selected lanes still wait for `/health` to report the **exact PR head** before execution.

For DTC-anchored Quick Ask changes, `/health/preview-evidence` must run on the exact PR head so the real `POST /api/quick-ask` route executes the branch code. The runtime assertion requires P1326 to report DTC-anchored retrieval and rejects any returned reference title that explicitly names 1.6L for the decoded 2.4L Optima. Unit regressions additionally assert that generic `engine` references do not satisfy the DTC gate, multiple codes remain independent, and unknown codes fall back without invented meanings.

For cross-context manual-evidence reuse, exact-current-context cache remains first priority, but DTC-anchored exact-cache rows are revalidated before return so an old same-hash row cannot bypass newer applicability rules. On an exact miss or rejected exact row, schema-v5 pages previously stored for the same exact vehicle identity may be re-ranked against the current DTC/symptom context. For a deterministically resolved DTC, a stored page may qualify by the literal code or by the same code-specific meaning terms used by Quick Ask's final DTC applicability guard; generic system words never qualify. The DTC match must be present in mechanic-visible source identity/text (title, headings, path, or stored source snippet); historical derived facts or prior-query metadata cannot rescue an otherwise unrelated page. Unknown DTCs remain exact-code only. Unrelated DTCs and explicit engine/drivetrain mismatches must fall through to the isolated live worker. The reuse-specific CI canary uses the 2008 Kia Sorento 3.8L 4WD (`KNDJC736385765089`) with P0300/P0171 plus deceleration/full-lock context from the production latency case; it requires stored manual evidence, at least one focused reference, no manual timeout, and <=5 seconds for the manual source. Render logs should show a revalidated exact-cache hit or a `Cross-context cache HIT` rather than a new ~20-second live manual crawl.

The unverified-diagnosis canary passes only when:

- the result state is `UNVERIFIED_DIAGNOSIS`;
- `physicallyVerified`, `repairAuthorized`, and `estimateReady` remain false;
- the persisted job remains `TESTING`;
- no `VERIFIED_CASE` is created;
- the Estimate bypass attempt returns HTTP 409; and
- the lifecycle page contains the explicit unverified-diagnosis warning/action.

`.github/workflows/ci.yaml` waits for `/health` to report the exact PR head before running each selected canary. A green unit-test run against a stale preview is not sufficient for merge.
