# SKSK Standalone Knowledge Scraper

Offline/batch collector for building SKSK's reusable automotive evidence corpus.

**Principle:** collect once → normalize once → store → reuse.

This tool is intentionally outside the live Diagnose/Verify/Estimate request path. It can run from a laptop, Render job, cron, GitHub Action, or another worker without changing repair-job truth.

## First source

The first adapter consumes NHTSA's official Manufacturer Communications/TSB bulk files. It normalizes and deduplicates records, preserves provenance, and can write either:

- local JSONL files for inspection/import/MCP ingestion;
- the existing Supabase `vehicle_tsb_corpus` table;
- both at once.

No AI is used during collection. Scraped evidence does not become verified repair truth.

## Install

```bash
cd tools/knowledge-scraper
npm install
```

## Start with common vehicles

```bash
npm run scrape:common -- --sink local
```

The seed lives at `config/common-vehicles.json`. This gives us a deliberate high-reuse starting population instead of blindly crawling everything first.

## Write directly to Supabase

```bash
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
npm run scrape:common -- --sink supabase
```

Or retain a local corpus and upsert to Supabase at the same time:

```bash
npm run scrape:common -- --sink both
```

## Target one vehicle

```bash
npm run scrape -- --year 2008 --make Kia --model Sorento --sink local
```

## Restrict NHTSA chunks

```bash
npm run scrape -- --chunks 2005-2009 --year 2008 --make Kia --model Sorento
```

## Safe trial

```bash
npm run scrape -- --chunks 2020-2024 --limit 100 --dry-run
```

`--dry-run` downloads/parses/normalizes but writes nothing.

## Output contract

Each JSONL row carries:

- `schema_version`
- `corpus_type`
- stable `fingerprint`
- normalized vehicle identity
- bulletin metadata and body
- source/provenance information

The Supabase sink maps the same record into the existing `vehicle_tsb_corpus` contract and stores the scraper fingerprint/provenance under `extracted_facts`.

## Quick Ask / MCP direction

The future **Ask SKSK / Quick Probability** button should read a retrieval layer, not the scraper itself. A good shape is:

```text
Quick Ask
  -> knowledge retrieval interface
       -> Supabase adapter
       -> MCP storage/search adapter
       -> future local/vector adapter
  -> probability/ranking layer
  -> optional model summary
```

The JSONL output is intentionally portable so an MCP-backed document/vector store can ingest the same normalized corpus without teaching the scraper about a specific MCP vendor. Once the exact MCP storage/search server is chosen, add an adapter at the retrieval boundary rather than coupling it into collection.

## Important distinction

TSB frequency is **not** repair probability. NHTSA records help build published-evidence coverage. The future probability engine should combine source-specific counts with eligible confirmed repair outcomes and clearly show sample size/provenance. Never turn a scraped bulletin count into a fake diagnostic confidence percentage.
