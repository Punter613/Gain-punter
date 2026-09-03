# Final Invoice From Completed Authorized Work

SKSK final invoice truth now sits after Work Order execution:

`Estimate -> Customer Authorization -> Work Order -> Completion -> Final Invoice`

The core policy is:

`BILL_COMPLETED_AUTHORIZED_WORK_ONLY`

A final invoice proves what the customer authorized, what the shop recorded as completed, and what was billed. It does **not** create diagnostic proof.

## Finalization rule

A lifecycle can create its final invoice only when every Work Order line is terminal:

- `COMPLETED` — eligible for billing.
- `CANCELLED` — preserved historically but excluded from billing.

The final invoice is blocked while any Work Order line remains:

- `READY`
- `IN_PROGRESS`
- `BLOCKED`

This prevents a document labeled final from being created while authorized work is still unresolved.

At least one line must be both `AUTHORIZED` and `COMPLETED`. An all-cancelled Work Order cannot create a zero-dollar final invoice.

## What can become an invoice line

A billable line must retain all of the following persisted facts:

1. It came from an immutable Work Order scope.
2. Its authorization snapshot says `AUTHORIZED` and contains the customer-decision timestamp.
3. Its execution state is `COMPLETED`.
4. It has `completedAt` and a completion note describing what was actually performed.
5. Its authorized pricing snapshot balances deterministically.
6. It has not already been billed.

`PROPOSED`, `DEFERRED`, `DECLINED`, `READY`, `IN_PROGRESS`, `BLOCKED`, and `CANCELLED` work never becomes an invoice line.

## Price truth

#132 does not invent an after-the-fact price adjustment mechanism.

The invoice uses the immutable pricing snapshot captured when the authorized estimate line became Work Order scope. If the price or repair scope materially changes, that change must go back through a new estimate/authorization path rather than silently modifying the final invoice.

Invoice totals are rebuilt from the billable Work Order lines:

- parts
- labor
- shop supplies
- tax
- subtotal
- final total

The aggregate must exactly balance to the sum of the completed authorized line snapshots.

## Diagnostic truth stays separate

The invoice stores the Work Order line's existing diagnostic-truth boundary. Customer authorization and mechanic completion do not turn a preliminary/customer-requested repair into a physically verified diagnosis.

Invoice policy note:

`AUTHORIZATION_AND_COMPLETION_DO_NOT_CREATE_DIAGNOSTIC_PROOF`

A verified diagnostic case may exist elsewhere on the lifecycle, but a Quick Estimate line is not automatically linked to it.

## Immutable invoice snapshot

The final invoice stores:

- lifecycle number
- customer and vehicle snapshot
- source Work Order documents
- source estimate documents/items
- Work Order scope fingerprints
- authorization timestamps/notes
- completion timestamps/notes
- actor labels with the current `identityVerified: false` boundary
- authorized pricing snapshots
- diagnostic-truth status per billed line
- deterministic totals
- `invoiceFingerprint`

The fingerprint protects the final invoice snapshot from silent mutation.

## Retry and post-invoice behavior

The lifecycle currently has one final invoice record. Retrying finalization returns the existing validated invoice rather than creating a duplicate.

Once the final invoice exists:

- no new Work Order may be created (existing #131 rule)
- the Work Order state API rejects further execution-state mutation
- the lifecycle status becomes `INVOICED`

## API

Create/finalize:

`POST /api/jobs/:lifecycleNumber/final-invoice`

Optional metadata:

```json
{
  "requestId": "pickup-finalize-123",
  "recordedBy": "service desk",
  "note": "Customer pickup invoice"
}
```

Read:

`GET /api/jobs/:lifecycleNumber/final-invoice`

A successful first finalization returns HTTP `201`; an idempotent retry returns `200` with the same invoice fingerprint.

## Boundary with the existing canonical verified-estimate invoice lane

The existing `/api/invoice/build` route remains the older canonical verified-estimate invoice path. #132 adds a lifecycle-native commercial final invoice lane driven by Work Order completion. It does not weaken or bypass the existing verified-estimate integrity checks.

The next UI milestone should surface this chain directly in Lifecycle/Estimate Center so a shop can see, on one screen, what was quoted, authorized, completed, deferred/cancelled, and finally billed.
