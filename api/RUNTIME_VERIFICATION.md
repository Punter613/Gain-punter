# Render runtime verification gate

The backend Render service uses `api/` as its Root Directory. A pull-request commit that changes only files outside `api/` may not create a new backend preview deployment even when those files are imported by `api/server.js` at runtime.

SKSK's merge gate requires the **exact PR head SHA** to boot before diagnostic/lifecycle changes can land. Therefore runtime-sensitive PRs must have an `api/`-visible change so Render builds the exact head rather than leaving the preview on an earlier commit.

The PR preview exposes `IS_PULL_REQUEST=true` canaries through `api/server.js`:

- `/health/preview-evidence` — exercises VIN decode plus the real Quick Ask evidence route with the 2020 Kia Optima 2.4L / P1326 canary.
- `/health/preview-unverified-diagnosis` — seeds a disposable TESTING job, calls the real `POST /api/jobs/:id/unverified-diagnosis`, attempts an Estimate bypass, and verifies the rendered lifecycle UI.

For DTC-anchored Quick Ask changes, `/health/preview-evidence` must run on the exact PR head so the real `POST /api/quick-ask` route executes the branch code. Unit regressions separately assert that P1326 enters DTC-anchored retrieval, generic `engine` references do not satisfy the DTC gate, and a known 2.4L Optima cannot surface an explicitly 1.6L manual page.

The unverified-diagnosis canary passes only when:

- the result state is `UNVERIFIED_DIAGNOSIS`;
- `physicallyVerified`, `repairAuthorized`, and `estimateReady` remain false;
- the persisted job remains `TESTING`;
- no `VERIFIED_CASE` is created;
- the Estimate bypass attempt returns HTTP 409; and
- the lifecycle page contains the explicit unverified-diagnosis warning/action.

`.github/workflows/ci.yaml` waits for `/health` to report the exact PR head before running these canaries. A green unit-test run against a stale preview is not sufficient for merge.
