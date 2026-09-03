# Customer Estimate Center

The Estimate Center is the commercial-document lane for pricing work before, during, or after a diagnostic lifecycle. It is intentionally separate from SKSK diagnostic truth.

## Lifecycle number is the parent key

Every quick estimate is attached to an SKSK lifecycle number (`SKSK-YYYYMMDD-XXXXXX`). Entering that lifecycle number returns the customer, vehicle, all quick-estimate revisions, the canonical verified repair estimate if one exists, and the final invoice if one exists.

An estimate-only lifecycle can be created when the customer only wants pricing. Creating it does **not** create a diagnosis, `VERIFIED_CASE`, verified repair estimate, or invoice authorization.

## Estimate types

### Quick / Preliminary Estimate

A quick estimate can be based on:

- `CUSTOMER_REQUEST`
- `PRELIMINARY_INSPECTION`

It is a customer-facing price document only. It never becomes diagnostic evidence and is never ingested as a confirmed repair outcome.

### Verified Repair Estimate

The existing verified Estimate lane remains unchanged. It is created only after persisted confirmation-grade evidence produces `VERIFIED_CASE`. The Estimate Center can display its summary alongside preliminary documents, but preliminary documents cannot create or alter it.

## Work items and customer decisions

Each quick-estimate work item carries its own price, priority, and customer decision:

- `PROPOSED`
- `AUTHORIZED`
- `DEFERRED`
- `DECLINED`

This allows a customer to approve only part of an estimate. Example: if three identified work items total $1,490 and the customer authorizes a $480 brake repair while deferring the other $1,010, the original $1,490 document remains intact. `authorizedToday` is $480 and `deferred` remains $1,010.

`DEFERRED` is distinct from `DECLINED`; deferred work remains visible for future follow-up.

## Revisions

Quick estimates use stable estimate IDs plus immutable revisions:

- `QE-001-R1`
- `QE-001-R2`

Creating a revision marks the previous revision `SUPERSEDED` but does not delete it. Customer authorization from the previous price does **not** carry to the new revision; every work item in the new revision resets to `PROPOSED` and requires fresh authorization.

## Printing

`public/estimate-center.html` provides a printable customer document containing:

- lifecycle number
- estimate revision number
- customer and vehicle
- work items and priority
- per-line customer decision
- total work identified
- total authorized today
- deferred amount
- preliminary-estimate disclaimer
- signature and date lines

Authorization applies only to work items marked `AUTHORIZED`. Authorization of a preliminary quote does not convert it into a verified diagnosis.

## API

The Estimate Center is mounted below `/api/jobs/estimate-center`:

- `POST /job` — create a fresh estimate-only lifecycle
- `GET /:id` — retrieve estimate history by lifecycle number
- `POST /:id/quick` — create a quick estimate
- `POST /:id/quick/:estimateId/revise` — create a new revision
- `POST /:id/quick/:estimateId/:revision/present` — mark a revision presented
- `POST /:id/quick/:estimateId/:revision/decisions` — record line-item customer decisions

The existing verified `/api/estimateHeuristic` and `/api/invoice` lanes remain the source of verified repair estimates and locked invoices.
