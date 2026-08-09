# SKSK ProTech Phase 2 Consolidation

Branch: `cleanup/phase2-consolidation`

## Source of truth

Protect the working ProTech estimate/PDF path and consolidate surrounding code toward the canonical `src/` architecture.

Canonical runtime spine remains:

`api/server.js` → `src/routes/full-estimate.js` → `src/core/orchestrator/main.orchestrator.js`

## Completed in this pass

### Parts routing

- Replaced the static stub in `src/routes/partsLookup.js` with the existing cached lookup implementation from `src/services/partsLookup.js`.
- Removed orphan root `routes/parts.js`, which referenced a non-existent root `services/partsLookup` module.
- Preserved the separate canonical `/api/parts` heuristic/tier route in `src/routes/parts.js`.

### Parts providers

- Moved the self-contained eBay OAuth provider from `services/ebayAuth.js` to `src/services/parts/ebayAuth.js`.
- Moved the eBay Browse provider from `services/ebayBrowse.js` to `src/services/parts/ebayBrowse.js`.
- This collapses the root shadow `services/` tree without discarding future eBay integration code.

### Knowledge tree

- Removed root `knowledge/parts.accuracy.js` after confirming the canonical `src/knowledge/parts.accuracy.js` contains the same intelligence data and is the version consumed by the core parts assembler.

## Intentionally deferred

### Supabase / LEMON migrations

No migration files are modified in this branch. The LEMON/Supabase SQL recently added to the running system was not visible in the repository at the time this branch was created, so database history is intentionally left untouched.

### Database compatibility shim

`src/services/db.js` remains temporarily. The only live route caller found is `src/routes/estimate.js`, but both estimate route generators still emit the compatibility import. Remove the shim only after the live route and both generator templates are updated together.

### Router generators

The duplicate generator paths under `scripts/` and `tools/scripts/` are behaviorally divergent, not byte-identical. Consolidating them requires deciding whether generated routes are still part of deployment or are historical build tooling.

### Boneyard and binaries

`.boneyard/` and tracked scraper binaries are not changed in this pass. They should be handled separately from runtime architecture consolidation because they affect history/deployment footprint rather than active route ownership.

## Rule for continued phase 2 work

1. Preserve the working full-estimate and PDF flow.
2. Move unique capability into a canonical `src/` home before deleting old paths.
3. Remove only after imports/mounts are traced.
4. Keep database migrations isolated from code cleanup until production migration history is visible.
