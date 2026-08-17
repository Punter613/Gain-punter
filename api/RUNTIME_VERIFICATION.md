# Render runtime verification gate

The backend Render service uses `api/` as its Root Directory. A pull-request commit that changes only files outside `api/` may not create a new backend preview deployment even when those files are imported by `api/server.js` at runtime.

SKSK's merge gate requires the **exact PR head SHA** to boot before diagnostic/lifecycle changes can land. Therefore runtime-sensitive PRs must have an `api/`-visible change so Render builds the exact head rather than leaving the preview on an earlier commit.

For the unverified-diagnosis fallback, the PR preview exposes two `IS_PULL_REQUEST=true` canaries:

- `/health/preview-evidence` — exercises the existing VIN/Quick Ask evidence hot path.
- `/health/preview-unverified-diagnosis` — seeds a disposable TESTING job, calls the real `POST /api/jobs/:id/unverified-diagnosis`, attempts an Estimate bypass, and verifies the rendered lifecycle UI.

The unverified-diagnosis canary passes only when:

- the result state is `UNVERIFIED_DIAGNOSIS`;
- `physicallyVerified`, `repairAuthorized`, and `estimateReady` remain false;
- the persisted job remains `TESTING`;
- no `VERIFIED_CASE` is created;
- the Estimate bypass attempt returns HTTP 409; and
- the lifecycle page contains the explicit unverified-diagnosis warning/action.

`.github/workflows/ci.yaml` waits for `/health` to report the exact PR head before running these canaries. A green unit-test run against a stale preview is not sufficient for merge.
