# Work Order Authorization Boundary

SKSK Work Orders sit between customer authorization and completed work.

The core rule is:

> Customer authorization approves a scope of work. It does not prove that a diagnostic repair is mechanically required.

## Lifecycle position

`Diagnosis -> Estimate -> Customer Decision -> Work Order -> Completion -> Invoice`

A Work Order is created from a specific estimate document/revision and only from estimate lines whose persisted decision is `AUTHORIZED`.

`PROPOSED`, `DEFERRED`, and `DECLINED` lines cannot enter a Work Order.

The original estimate is not rewritten. The Work Order captures an immutable authorization snapshot containing the source estimate document, selected source item IDs, prices, customer-decision timestamps/notes, and diagnostic-truth status at the moment the Work Order is created.

## Truth boundary

Work Orders use policy:

`CUSTOMER_AUTHORIZATION_IS_NOT_DIAGNOSTIC_PROOF`

A preliminary Quick Estimate may create an authorized Work Order without creating `VERIFIED_CASE`. In that case the Work Order explicitly records `diagnosticTruthSnapshot.status = NOT_VERIFIED` and each line states that customer authorization does not establish mechanical necessity.

If a canonical verified case already exists somewhere else on the lifecycle, the Work Order records that fact and its fingerprint separately as `VERIFIED_CASE_PRESENT_BUT_SCOPE_UNLINKED`. A Quick Estimate line is still stored with `physicallyVerified: false` and `scopeMatchEstablished: false` unless a future verified-estimate handoff explicitly proves that line belongs to the verified repair scope. Authorization and verification remain independent facts.

Work Order creation never creates or changes `VERIFIED_CASE`, the canonical verified estimate, or an invoice.

## Immutable scope

Each Work Order stores a `scopeFingerprint` over the immutable authorization scope. Execution-state changes do not alter that fingerprint.

After Work Order creation, estimate decision changes cannot rewrite the Work Order's authorization history. Material scope changes require a new authorization document/work-order path rather than editing historical scope in place.

## Execution states

Work items use:

`READY -> IN_PROGRESS -> COMPLETED`

with controlled side states:

- `BLOCKED` may return to `READY` or `IN_PROGRESS`.
- `CANCELLED` is terminal.
- `COMPLETED` is terminal.

A `COMPLETED` transition requires a completion note describing the work actually performed. A `BLOCKED` transition requires a reason.

The current caller may provide a `recordedBy` label, but SKSK does not yet have authenticated technician identity middleware for this lane. Therefore every stored actor record is explicitly marked `identityVerified: false`.

## Order status and totals

The Work Order derives its document status from line execution states: `READY`, `IN_PROGRESS`, `PARTIALLY_COMPLETED`, `COMPLETED`, `BLOCKED`, or `CANCELLED`.

Execution totals remain separate:

- `authorizedPlanned`: customer-authorized planned amount.
- `completed`: amount represented by lines actually marked completed.
- `cancelled`: authorized scope later cancelled before completion.
- `remaining`: authorized work not completed or cancelled.

These totals prepare the boundary for the next milestone: invoice generation from completed authorized work only. #131 does **not** create that invoice.

## Retry and mobile safety

Work Order creation is serialized per lifecycle and is idempotent for the same source estimate/item set. An optional `requestId`/`idempotencyKey` is also persisted with the authorization request.

A mobile retry of the same authorized scope returns the existing Work Order rather than creating duplicate scope. Reusing the same request ID for a different estimate revision fails closed instead of silently returning or creating the wrong Work Order.

## Safety/dependency packages

The Work Order engine understands `packageId` plus `packagePolicy = ALL_OR_NONE` on stored estimate lines. When present, every line in that package must be authorized and selected together. SKSK refuses to split such a package across a Work Order.

This is the execution-layer guard for repairs that should not be partially authorized simply to hit a budget target. Estimate authoring/UI support for defining these package fields can be expanded independently.

## Estimate Center handoff

Estimate Center lifecycle lookup now includes a compact `workOrders` summary so the commercial document chain can be viewed from the same lifecycle number without changing the Quick Estimate document itself.

## API

All Work Orders remain under the lifecycle number.

- `GET /api/jobs/:id/work-orders`
- `POST /api/jobs/:id/work-orders`
- `GET /api/jobs/:id/work-orders/:workOrderId`
- `POST /api/jobs/:id/work-orders/:workOrderId/items/:workItemId/state`

Create payload:

```json
{
  "estimateId": "QE-001",
  "revision": 1,
  "itemIds": ["LI-001", "LI-002"],
  "requestId": "mobile-submit-123",
  "recordedBy": "service desk"
}
```

Completion payload:

```json
{
  "state": "COMPLETED",
  "completionNote": "Work performed and final check completed.",
  "recordedBy": "technician label"
}
```

The next commercial milestone should consume only `AUTHORIZED + COMPLETED` Work Order lines when creating invoice truth.
