# PR #120 exact-head runtime verification

This file intentionally lives under `api/` because Render deploys the SKSK backend from `api/` as its Root Directory. PR #120 removes only files that were verified unreachable from the live server, tests, workflows, static HTML script references, and dynamic execution surfaces; without an `api/`-visible change, Render may not provision an exact-head preview for a deletion-only hygiene PR.

Before merge, the exact PR head must boot on Render and the reviewer must record:

- `/health` returning HTTP 200 and reporting the exact PR commit in `preview.commit`;
- `/` returning the current mechanic-facing application rather than a startup/static-assets failure;
- `/api/intelligence/health` returning a successful health response, proving the mounted intelligence route still loads after the legacy core/service deletions;
- `POST /api/translate` returning a normal successful response, proving the live `src/routes/translate.js` path remains intact after deletion of the dead `src/services/translate.js` naming collision; and
- a representative `/api/parts` request reaching the live mounted parts router rather than failing module resolution after removal of the isolated legacy eBay adapter pair.

The hygiene PR does not alter the Diagnose/Test/Verify/Estimate lifecycle, Quick Ask retrieval logic, workers, or database schema. Their existing regression suites still run in CI; the runtime checks above are specifically intended to prove that the claimed-dead modules were not hidden startup or route dependencies.

`.github/workflows/runtime-hygiene.yaml` automates these checks for hygiene PRs carrying an `api/RUNTIME_HYGIENE_*.md` marker. This final marker update intentionally forces both Render and the hygiene workflow to evaluate the same exact PR head before merge.
