# Agent Instructions for SKSK ProTech

## Database Access
- Use `src/db.js` as the primary interface for Supabase.
- If you need the raw Supabase client, import it from `src/db.js` using the correct relative path and destructure `{ supabase }`.
- Do not create new Supabase client instances in other files.

## Testing
- Use `scripts/generate_random_test.js` to run randomized end-to-end tests on the `/api/full-estimate` pipeline.
- Use `tests/testForemanPipeline.js` for AI structure validation.

## Merge Gate — Runtime Verification Required
- Nothing merges to `main` based on diff review alone.
- Before merge, boot the exact PR/branch code in a real runtime environment.
- Exercise every route, worker, lifecycle hook, or background service materially affected by the change.
- For estimate/diagnostic changes, hit the real HTTP routes rather than only importing modules or checking syntax.
- For background services such as Supabase keep-awake or workers, confirm startup behavior and at least one real execution path when practical.
- Record the commands/routes exercised and the observed result in the PR description or a PR comment before merge.
- A clean boot plus green syntax/static checks is necessary but not sufficient; runtime behavior is the merge criterion.
- If the runtime environment or required credentials are unavailable, do not merge. Document what is blocked instead.
- Render currently uses `api/` as the backend service Root Directory. Any PR that changes backend/runtime files outside `api/` must also contain an `api/`-visible change so Render creates the PR preview and production autodeploy. Run `npm run render:preview -- "reason"` and commit `api/.render-preview-trigger` when needed.
- A missing Render preview is a failed runtime gate, not a successful or skipped verification. The exact PR head SHA must be live before merge.

## TAG Safety Invariants
- Missing does not mean safe. Missing does not mean unsafe. Missing means unknown.
- The Brain owns interpretation and uncertainty. TAG owns deterministic policy evaluation.
- Brain-owned normalization may emit a canonical scalar only after its evidence/confidence threshold is satisfied; otherwise it must omit the field.
- No low-confidence derived scalar may trigger a mandatory TAG action.
- The Brain → TAG contract is scalar-or-absent. TAG must not parse raw technician language, fabricate missing measurements, or infer a substitute value for absent data.
- Absence of a measurement must not itself create a measurement-based mandatory override. If missing data should require inspection or human review, implement that as a separate explicit rule.

## Manual Scraping
- The Rust scraper is located in `tools/lemon_scraper`.
- Integration logic is in `src/services/lemon.js`.

## Knowledge Injection
- Add new repair protocols to `src/knowledge/repair.intelligence.library.js` or `src/knowledge/procedure.data.js`.
- Logic for matching procedures is in `src/services/procedure_lookup.js`.
