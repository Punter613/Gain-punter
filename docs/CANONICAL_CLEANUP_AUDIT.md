# SKSK ProTech Canonical Cleanup Audit

Branch: `cleanup/canonical-estimate-prune`

## Canonical runtime spine

The currently working ProTech estimate flow is the source of truth:

`api/server.js` → `src/routes/full-estimate.js` → `src/core/orchestrator/main.orchestrator.js`

Supporting canonical layers live under `src/` unless a deliberate exception is documented.

## Safe removals completed

Removed byte-identical duplicate copies from `tools/scripts/` while preserving the authoritative copies in `scripts/`:

- `tools/scripts/cleanup_logs.sh`
- `tools/scripts/generate_random_test.js`
- `tools/scripts/run_lemon_scraper.sh`
- `tools/scripts/ship.js`
- `tools/scripts/smoke_test.sh`
- `tools/scripts/stress_test.js`

Removed non-runtime artifacts:

- `-d` — captured JSON error response
- `changes.diff` — stale loose patch artifact retained in Git history
- `new modules ` — generated Python workbench/scratch file targeting `/mnt/agents/output/sksk_modules`
- `src/core/orchestrator/estimate.js` — zero-byte placeholder with no discovered references

Updated `.gitignore` to discourage recommitting generated Rust output, checked-in scraper binaries, and loose diff artifacts.

## Do not delete yet — migrate/trace first

### Router generators

`tools/scripts/build_router_estimate_v1.js` and `scripts/build_router_estimate_v1.js` are not equivalent. The `scripts/` version contains suspicious duplicated imports / altered dispatch logic. Determine whether route generation is still part of the intended runtime/deploy workflow before consolidating.

The same caution applies to `build_router_v11.js` copies.

### Shadow database adapter

`src/services/db.js` is a compatibility shim over `src/db.js`. Migrate all callers to the canonical database interface before removing the shim.

### Parts trees

`routes/parts.js` is not simply a duplicate of `src/routes/parts.js`. It contains direct-search behavior, while the live `src/routes/parts.js` is primarily a heuristic tier generator.

`src/routes/partsLookup.js` is currently a stub-style endpoint, while `src/services/partsLookup.js` contains a more substantial lookup/cache implementation. Consolidate these capabilities into one canonical parts boundary before deleting the older route tree.

### Top-level legacy trees

The following require import/deployment tracing before deletion because they may contain unique functionality:

- `routes/`
- `services/`
- `knowledge/`
- `.boneyard/`

## Known structural debt

- Multiple stress-test entry files remain outside the exact-duplicate set (`stress.test.js`, `stresstest.js`, `tests/stress.test.js`). Compare intent and choose one test home.
- Database migrations include two files beginning with `002_`; normalize migration sequencing only after confirming production migration history.
- Checked-in scraper binaries remain tracked in Git history/current tree; ignore rules prevent new accidental additions, but removing/replacing tracked binaries should be coordinated with deployment behavior.
- Root documentation (`ARCHITECTURE_ANALYSIS.md`, `MASTER_PLAN.md`, `CLEANUP.md`) overlaps in purpose; consolidate documentation only after extracting still-valid decisions.

## Cleanup rule

For every candidate:

1. Trace imports, mounts, build/deploy references, and unique behavior.
2. Migrate any useful capability into the canonical `src/` architecture.
3. Verify the ProTech full-estimate flow is unaffected.
4. Remove the obsolete copy only after replacement is proven.

The goal is not merely fewer files. The goal is one obvious place to debug, fix, extend, test, and eventually monetize each capability.
