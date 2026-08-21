# Repository Hygiene Audit — Round 2 — 2026-08-21

Branch: `hygiene/round2-dead-code-prune`
Base: `main` @ `f5d1f101b33be05154782dcc7dcd51ae9d7009ce` (post-#113)

Builds on the analysis from a prior session's write-up (never pushed to
any branch — verified against the live repo before acting on any of it).
Every claim below was independently re-checked against current `main`,
not taken on faith. Cross-checked that #112/#113/#118 and all other
merged work since the first hygiene pass (#102) didn't touch any of
these files before treating them as still dead.

## SAFE DELETE (done in this branch)

All files below: zero `require()` references anywhere in the repo,
zero mentions in any workflow/config/manifest, not dynamically loaded
(no `fs.readdir`-based plugin loading exists in this codebase),
unreachable transitively from `api/server.js`, every `npm run test:*`
script, every workflow, and the test runner.

- `src/core/pattern.assembler.js`, `src/core/pattern.matcher.js`,
  `src/core/risk.engine.js` — zero real requires. The only grep hits
  were a test's human-readable description string containing the
  words "risk engine," not an import — confirmed by reading the line,
  not just counting matches.
- `src/middleware/auth.js`, `tenantContext.js`,
  `authenticateHeuristic.js` — zero requires; no global auth
  middleware is mounted anywhere in `api/server.js`.
- `src/services/buyerPrompt.js`, `buyerService.js` — zero requires;
  `src/routes/buyer.js` talks to `main.orchestrator.js` directly.
- `src/services/pdf.js` — zero requires; depends on `pdfkit`, which
  isn't even a declared dependency in `package.json`.
- `src/services/sanitation.service.js`, `validator.service.js` — zero
  requires.
- `src/services/translate.js` — zero requires, and a naming collision
  with the actually-live `src/routes/translate.js` (confirmed:
  `api/server.js` mounts `require('../src/routes/translate')` only).
- `src/services/parts/ebayBrowse.js` + `ebayAuth.js` — the "referenced
  only by other dead files" case: `ebayBrowse` requires `ebayAuth`, so
  a shallow grep would call `ebayAuth` "used" — but nothing outside
  this pair requires `ebayBrowse` itself, and the live `/api/parts`
  and `/api/partsLookup` routes require neither.
- `src/services/processScrape.js` — zero requires from live code;
  depends on `uuid`, which is only a transitive dependency.
- Root `diagnostic.js` — browser DOM code sitting outside `public/`,
  where `express.static()` actually serves from. Never required as a
  Node module, never linked by any HTML script tag. Superseded by
  `public/js/diag-estimate-lifecycle.js`.
- `public/voiceUI.js` — never linked by any `<script>` tag anywhere.
  Its own hardcoded `API_BASE` (`https://onrender.com`) doesn't even
  match the real backend domain (`p613-backend.onrender.com`) used in
  `api/server.js`'s CORS allowlist — confirms it predates the current
  architecture.

## Explicitly NOT deleted — held back from the original proposal

**`src/brain/` (5 files: `symptom.matcher.js`, `failure.scorer.js`,
`grounding.guard.js`, `tsb.weight.engine.placeholder.js`,
`symptom.mapping.js`).** Reachability analysis alone says this is dead
— zero references anywhere, same as everything above. But this isn't
abandoned code superseded by something else; it's built-but-not-yet-
wired-in, and brain reconnection is an explicit, standing future
milestone, not a dropped idea. Reachability doesn't distinguish
"nobody needs this anymore" from "nobody's plugged this in yet" — only
intent does, and only the person holding the roadmap can make that
call. Left fully in place, no changes.

## Explicitly NOT touched (matches original proposal's scope)

- Three non-duplicate stress-test files (`stress.test.js`,
  `stresstest.js`, `tests/stress.test.js`) — which version is
  canonical is a product call, not hygiene.
- Real, live-code-targeting test files that exist but aren't wired
  into any `npm run test:*` group or CI — a CI-completeness gap, not
  dead weight.
- `tests/confirmed.repair.outcome.test.js` and
  `.supabase.test.js` — broken against current main's stricter
  `verified.case.js` (requires `verification.evidenceTestIds` now,
  their fixtures don't set it). A real bug, but a bug fix, not a
  hygiene deletion — deliberately left unfixed here per scope.
- `.boneyard/`, migration file duplicate sequence numbers, `tools/`
  duplication questions, doc consolidation — all previously flagged,
  re-verified as genuine judgment calls, not hygiene deletions.
- No architectural refactor, no bug fixes, no migration changes
  bundled in.

## Verification

- Baseline (pre-delete, current `main` @ `f5d1f10`): all 13
  `npm run test:*` groups — 249/249 pass.
- Post-delete: same 13 groups — 249/249 pass, identical.
- `node --check api/server.js` — clean.
- Confirmed none of the 17 deleted files were touched by #112, #113,
  or #118 (the most recent merged work) — all prior history on these
  files predates any currently-live pipeline work (Pipeline v7/v8/v9,
  "God Route" refactor, SKSK Buyer Intelligence Platform — all
  superseded architecture generations, not recent changes).
