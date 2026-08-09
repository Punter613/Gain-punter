# SKSK ProTech Phase 2 — Generator Retirement

Branch: `cleanup/phase2-db-generator-consolidation`

## Why this slice exists

The live routes are now the source of truth. The old route-generator layer was no longer part of `package.json` start/dev/test execution and could overwrite newer working route implementations with stale templates.

## Removed

- `scripts/ship.js`
- `scripts/build_router_estimate_v1.js`
- `tools/scripts/build_router_estimate_v1.js`
- `scripts/build_router_v11.js`
- `tools/scripts/build_router_v11.js`

## Risk removed

The stale estimate generator lacked the current evidence-aware route behavior and the `scripts/` copy contained duplicated pipeline imports / wrong AI dispatch. The diagnose generator pair similarly represented frozen route templates rather than the current live route architecture.

The old `scripts/ship.js` explicitly regenerated `src/routes/diagnose.js` and `src/routes/estimate.js`, committed them, and pushed them. It was not referenced by current npm scripts, so keeping it created a path for accidental rollback of working route code.

## Database boundary

`src/db.js` remains the canonical Supabase/LEMON database module. `src/services/db.js` is still temporarily retained because the live heuristic estimate route imports the shim. With route generators retired, that shim can now be removed in a smaller follow-up change by updating only the live route to use `require('../db').supabase` (or an explicit exported helper).

## Guardrail

Routes should be edited/tested as source files. Do not reintroduce code generators that rewrite committed runtime routes unless generation becomes a deliberate build artifact with tests and a single canonical template source.
