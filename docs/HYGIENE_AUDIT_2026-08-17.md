# SKSK ProTech Repository Hygiene Audit — 2026-08-17

Branch: `hygiene/repo-audit-safe-deletes`
Base: `main` @ 05bcec6 (post-#101, standalone knowledge scraper merged)

Scope: full A→Z (entrypoints → services) and Z→A (leaf files → reachability) pass.
This audit builds on, and does not repeat, the ground already covered and
merged from `docs/CANONICAL_CLEANUP_AUDIT.md`, `docs/PHASE2_CONSOLIDATION.md`,
`docs/PHASE2_DB_BOUNDARY.md`, and `docs/PHASE2_GENERATOR_RETIREMENT.md`. Items
those docs already resolved (root `routes/`, `services/`, `knowledge/`,
`src/services/db.js` shim, router generators, duplicate `knowledge/parts.accuracy.js`)
were re-verified as gone in current `main` and are not repeated below.

## Canonical runtime spine (confirmed unchanged)

`api/server.js` → `src/routes/*` → `src/core/orchestrator/main.orchestrator.js`

Frontend: Cloudflare Pages serving `public/`. Backend: Render running
`node api/server.js`. This audit protected that path — every change below
was proven safe by running the full guard/provider/lifecycle/measurement/
evidence/verified-case/repair-resolution/invoice-handoff/frontend-lifecycle
suite (128 tests) before and after, plus the schema-parity test run directly.
Baseline: 128/128 pass. After changes: 128/128 pass, plus 9/9 on
`diagnose.schema.parity.test.js`.

---

## SAFE DELETE (done in this branch)

### 1. `src/routes/model-compare-result.js` + its mount in `api/server.js`
**Evidence it's dead weight, not live functionality:** the file's own code
labels every response `temporary: true`, and the mounting line in
`api/server.js` was commented `// TEMPORARY: Render executes the head-to-head
once at boot`. Git history shows it was already removed once
(`221fbfe Remove temporary model comparison result route`) and then
re-added (`ac441a0 Restore temporary Render model comparison route`) —
i.e. a prior cleanup attempt already agreed this should go, and it came
back via a merge. Its only purpose was a one-off Groq-vs-Gemini model
comparison tied to the now-merged `align-gemini-diagnose-contract` work.
**Real cost of leaving it:** the module fires an actual `runComparison()`
call against the live `GROQ_API_KEY` at import time — meaning every cold
start on Render was silently burning a Groq API call for a comparison
nobody was reading anymore. This is a small live bug, not just dead code.
**What was kept:** `scripts/compare-diagnose-models.js` — confirmed as a
real, still-used dependency of `tests/diagnose.schema.parity.test.js`
(imports `diagnosisJsonSchema` from it). Only the HTTP route wrapper and
its boot-time side effect were removed.

### 2. `.github/workflows/temp-model-round2.yml`
**Evidence:** name is literally "Temporary Model Round 2"; its only job
polls `/api/internal/model-compare-result` for the string `"Round 2: strict
schema corrected"`. That endpoint no longer exists after removing item 1,
so this workflow would fail on every push from this point forward if left
in place. It was a one-shot verification poller for a specific past PR,
not a recurring CI check.

### 3. `.github/workflows/jekyll-gh-pages.yml`
**Evidence:** unmodified GitHub's default "Deploy Jekyll with GitHub Pages"
template, triggered on every push to `main`. This project is not a Jekyll
site — it has no `_config.yml`, no Jekyll gemfile, no `_posts`, nothing
Jekyll-shaped anywhere in the tree. The real frontend deploy path is
Cloudflare Pages (`skskprotech.pages.dev`), confirmed by `public/_redirects`
and the Cloudflare `functions/api/[[path]].js` proxy. This workflow was
firing a build that had nothing to build, on every push, for no consumer.

### 4. `.gitmodules` + root `backend` file
**Evidence:** `.gitmodules` declares a submodule at path `backend` pointing
to `https://github.com/Punter0613/Sksk.git`, but `git ls-tree` shows no
`160000` gitlink entry for that path anywhere in the tree — meaning this
was never actually wired up as a real submodule checkout. The `backend`
path is a plain text file (confirmed via `file backend` → `ASCII text`)
containing a note that it's "managed as a git submodule," which is false
for this repo as it stands: the real backend is `api/` + `src/` directly
in this repository (confirmed by `package.json`'s `main: api/server.js`
and Render's actual deploy config). This is leftover scaffolding from an
earlier architecture idea that was abandoned in favor of the current
single-repo layout, and it actively misleads anyone who reads it into
thinking there's a submodule to initialize.

### 5. Unused dependencies: `helmet`, `express-rate-limit`
**Evidence:** grepped every `require(...)` across `src/`, `api/`,
`scripts/`, `tests/`, `functions/` — zero references to either package
under any import spelling. Both were listed in `package.json` but never
wired into the Express app (no `app.use(helmet())`, no rate-limit
middleware anywhere in `api/server.js` or route files). Removed via
`npm uninstall`, which also cleaned the corresponding `package-lock.json`
entries. If rate limiting or security headers are wanted, that's a real
feature to add deliberately (with tests), not dead config to keep around
implying protection that isn't actually applied.

---

## HISTORICAL-KEEP (not touched)

- **`.boneyard/`** (`old_scripts/`, `Src_ghost/Brain`, `old_response.json`) —
  this is already a deliberately named, already-segregated archive from a
  prior cleanup pass. It matches your own stated pattern (segregate, set
  aside, reconnect only if needed) rather than being accidental clutter.
  Nothing in the live app requires it. Leaving it alone unless you want it
  gone outright — that's a judgment call on history-keeping, not a hygiene
  bug.
- **`db/migrations/002_fleet_vehicles.sql`** and
  **`db/migrations/002_lemon_manual_evidence.sql`** — duplicate sequence
  number, but both are almost certainly already applied against the live
  Supabase database. Renumbering or merging migration files after they've
  run in production doesn't undo anything already applied and risks
  desyncing a migration tracker if one exists. This needs you to confirm
  against actual Supabase migration history before anyone touches it —
  flagged in `docs/CANONICAL_CLEANUP_AUDIT.md` previously and still true.
- **`bin/lemon_scraper`** (5.4MB tracked binary) — actively rebuilt and
  committed back to the repo by `.github/workflows/lemon_scraper.yaml` on
  every push to `main` (`cargo build --release` → `git add bin/lemon_scraper`
  → auto-commit). This is live, working CI behavior, not debris — it's a
  deliberate "compiled binary lives in git" deployment pattern. Not
  something to delete; only worth revisiting later if you'd rather ship it
  as a release artifact instead of a tracked binary.

## NEEDS DECISION (found, not touched — real judgment calls)

- **Three stress-test entry points**: root `stress.test.js` (64 lines),
  root `stresstest.js` (73 lines), and `tests/stress.test.js` (149 lines).
  All three have different content (confirmed via md5 — none are
  duplicates of each other) and none are wired into `package.json` scripts
  or CI. They look like three separate iterations of the same idea rather
  than one canonical file with backups. Recommend picking the most complete
  one (`tests/stress.test.js` looks like the most developed) as canonical
  and either deleting or clearly archiving the other two — but that's a
  "which version do you actually want" call, not a hygiene call, so it's
  left for you.
- **Root docs overlap**: `ARCHITECTURE_ANALYSIS.md`, `MASTER_PLAN.md`, and
  `CLEANUP.md` all cover project-state/planning ground that has since moved
  or been partly superseded by the `docs/` cleanup docs. None are wrong,
  but reading order isn't obvious to a new session picking up the repo.
  Worth a consolidation pass, but that's editorial work on real content —
  not a delete.
- **Router generator duplication** (`build_router_estimate_v1.js`,
  `build_router_v11.js` under both `scripts/` and `tools/scripts/`) —
  already resolved per `PHASE2_GENERATOR_RETIREMENT.md`; verified gone in
  current `main`. No action needed, listed here only to confirm it was
  re-checked in this pass, not missed.

## KEEP (verified live, checked because they looked suspicious)

- `src/routes/model-compare-result.js`'s sibling logic, `scripts/compare-diagnose-models.js`
  — real test dependency, confirmed above, kept.
- `.github/workflows/lemon-targeted-evidence.yml` — manual
  `workflow_dispatch` tool with real inputs (year/make/model/DTCs/etc.),
  runs the real normalization + scraper guard tests before scraping,
  calls the real `scripts/scrape-lemon-targeted-evidence.js`. This is a
  working on-demand evidence-gathering tool, not debris.
- `.github/workflows/lemon_scraper.yaml` — builds and commits the Rust
  scraper binary; see `bin/lemon_scraper` note above.
- `.github/workflows/nhtsa-tsb-bulk-ingestion.yml`, `ci.yaml` — both
  reference real, currently-passing scripts and test groups. No changes.
- `functions/api/[[path]].js` — the live Cloudflare Pages proxy that
  routes frontend API calls to the Render backend. Confirmed reachable
  from the deploy path, not orphaned.

## BUG DISCOVERED

Covered under SAFE DELETE item 1 above: the "temporary" model-compare
route was executing a real Groq API call on every server boot in
production, not just sitting as unreachable dead code. Removing it also
fixes that live behavior, not only the file-count hygiene.

---

## What this branch deliberately does NOT do

No architectural refactor, no bug fix beyond the boot-time side-effect
that removing dead debug scaffolding incidentally resolves, no migration
changes, no `.boneyard/` deletion, no stress-test consolidation, no doc
rewrites. Those are separate decisions (some yours to make, some worth
their own PR) and mixing them into a hygiene pass would make this harder
to review and revert if something's wrong.

## Verification

- Baseline (pre-change): `npm run test:guards|providers|lifecycle|measurements|evidence|diagnose-pipeline|evidence-packet|verified-case|estimate-verified-truth|repair-resolution|invoice-handoff|frontend-lifecycle` → 128/128 pass.
- Post-change: same 12 suites → 128/128 pass, unchanged.
- `node --test tests/diagnose.schema.parity.test.js` (not in an npm script group, checked directly since it touches the same area) → 9/9 pass.
- `node --check api/server.js` → syntax OK after the route/mount removal.
