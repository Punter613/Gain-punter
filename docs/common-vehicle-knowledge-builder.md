# Common Vehicle Knowledge Builder

## Goal

Build SKSK's own durable automotive knowledge corpus around common shop platforms without depending on any single external service-manual provider.

The builder follows:

`DURABLE_FIRST_STRUCTURED_CORPUS`

It is a coverage and ingestion-priority system, not a diagnostic probability system.

## What counts as durable coverage

Today the builder counts two durable evidence classes:

1. `NHTSA_BULK` manufacturer-communication rows already stored in `vehicle_tsb_corpus`.
2. Trusted verified repair outcomes from `feedback_examples` where `metadata.trustedForTraining === true` and a `confirmedRepairCase` exists.

Optional external manual sources such as LEMON may be counted only as a dependency signal. They do **not** increase durable coverage score or make a vehicle `durableReady`.

The API never returns raw optional-manual content as part of the coverage report.

## Common-platform catalog

`src/services/common.vehicle.knowledge.builder.js` contains `COMMON_PLATFORM_CATALOG`.

This is intentionally described as a **curated common-service platform priority**, not an exact annual sales ranking. The list can be revised independently from the scoring engine as better fleet/registration/service-frequency data becomes available.

Each platform expands into year/make/model targets. Coverage is calculated per Y/M/M because service communications and verified repair outcomes can differ by model year.

## Coverage score

The 0–100 score measures corpus completeness only:

- official stored manufacturer communications: up to 45 points;
- breadth of covered vehicle systems: up to 20 points;
- trusted verified repair outcomes: up to 25 points;
- durable source diversity: up to 10 points.

A high score does **not** mean a vehicle is reliable or that a repair is likely. It only means SKSK has more durable structured evidence for that Y/M/M.

## Gap codes

The builder emits deterministic gaps such as:

- `NO_OFFICIAL_PUBLISHED_EVIDENCE`
- `NO_VERIFIED_REPAIR_OUTCOMES`
- `LOW_SYSTEM_BREADTH`
- `OPTIONAL_SOURCE_DEPENDENCE`
- `NO_DURABLE_EVIDENCE`

Those gaps become build actions such as `INGEST_NHTSA_BULK`, `COLLECT_VERIFIED_REPAIR_OUTCOMES`, and `REPLACE_OPTIONAL_DEPENDENCE_WITH_DURABLE_FACTS`.

## Priority score

Build priority combines the curated service-platform weight with the inverse of current coverage. Common/high-priority platforms with large evidence gaps rise to the top.

This is intentionally separate from diagnosis. Priority score is about **what SKSK should learn next**, not **what is wrong with a customer's vehicle**.

## API

Mounted at `/api/knowledge-builder`:

- `GET /api/knowledge-builder/catalog`
- `GET /api/knowledge-builder/coverage?limit=50`
- optional filters: `make`, `model`, `year`, `limit`

The coverage response includes source rules, summary statistics, scan telemetry, ranked Y/M/M targets, gaps, and recommended build actions.

## Dashboard

`/knowledge-builder` opens the coverage dashboard. It shows the highest-priority Y/M/M gaps and the next durable build action.

## Batch planning

Run:

```bash
node scripts/plan-common-vehicle-ingestion.js
```

Optional:

```bash
KNOWLEDGE_BUILD_LIMIT=50 node scripts/plan-common-vehicle-ingestion.js
```

For Y/M/M targets missing official stored evidence, the planner prints a targeted command for the existing official NHTSA bulk ingester:

```bash
NHTSA_TSB_YEAR=2023 NHTSA_TSB_MAKE='Honda' NHTSA_TSB_MODEL='Odyssey' node scripts/ingest-nhtsa-tsb-bulk.js
```

The NHTSA ingester remains an offline/batch process. The live request path never downloads bulk archives.

## Legal/source boundary

This feature is deliberately **not** a LEMON mirror or bulk manual copier.

- no mirror discovery;
- no access-control workarounds;
- no copying of optional manual prose/diagrams into the durable coverage score;
- source provenance remains attached to stored evidence;
- external-manual availability is treated as telemetry, not diagnostic truth.

The long-term corpus can add licensed OEM data or additional official/public datasets without changing the coverage contract.
