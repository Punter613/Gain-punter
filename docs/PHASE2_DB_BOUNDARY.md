# SKSK ProTech Phase 2 — Canonical DB Boundary

This follow-up removes the last active compatibility shim between runtime estimate persistence and the canonical database module.

## Canonical database module

`src/db.js` is the single database boundary. It owns:

- Supabase client construction
- LEMON manual cache reads
- LEMON manual cache writes
- Vehicle cache-key normalization

## Migration completed

`src/routes/estimate.js` now imports `{ supabase }` directly from `src/db.js` and writes estimates through that canonical client.

The former `src/services/db.js` shim only re-exported `db.supabase` and is removed.

## Why this matters

Keeping one database entry point avoids shadow interfaces that can drift away from LEMON caching and future persistence behavior. Runtime code now has one obvious place to inspect for Supabase configuration and shared database behavior.

## Scope

No database migration SQL, LEMON scraper implementation, full-estimate route, PDF generation flow, or Supabase cache schema is changed in this slice.
