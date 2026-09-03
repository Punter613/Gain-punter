# Atomic evidence save + diagnostic reassessment

## Invariant

When a mechanic requests an unverified diagnosis while new test evidence is still unsaved, SKSK treats the operation as one serialized lifecycle mutation:

`validate entire evidence batch -> persist evidence -> mark prior diagnosis stale -> reassess from persisted case -> persist new diagnosis revision -> present UNVERIFIED_DIAGNOSIS`

The prior diagnosis is never re-issued as current after new evidence has been accepted.

## Fail-closed behavior

If evidence persistence fails, reassessment does not run.

If evidence persistence succeeds but reassessment fails:

- the evidence stays persisted;
- the previous diagnosis remains `stale: true`;
- any prior unverified diagnosis remains stale/superseded;
- no replacement unverified diagnosis is emitted;
- Estimate remains locked;
- the client receives `REASSESSMENT_FAILED_AFTER_EVIDENCE_SAVE` and can safely retry.

## Retry / double-tap safety

Atomic evidence items require a stable evidence id. Replaying the exact same id + content reuses the already-persisted evidence instead of appending a duplicate. Reusing an id with different content fails closed.

Per-job mutation serialization prevents concurrent mobile requests from creating duplicate evidence or multiple diagnosis revisions. After a successful reassessment, replaying the same evidence does not create another diagnosis revision because that evidence is no longer newer than the current diagnosis.

## Existing truth boundaries

This flow does not change verification semantics:

- NEUTRAL / SUPPORTS / REFUTES evidence may rerank a diagnosis but never unlock Estimate.
- Only mechanic-classified `CONFIRMS` evidence tied to a named fault can support explicit VERIFY.
- An unverified diagnosis remains non-authoritative and does not authorize repair.
- Verified scan-tool DTC provenance and component-applicability guards remain in force during reassessment.

## API

### Save a test batch without reassessing

`POST /api/jobs/:id/tests/batch`

```json
{
  "evidence": [
    {
      "id": "client-stable-id",
      "name": "Controlled road test",
      "result": "Clunk reproduced on throttle release",
      "evidenceRole": "NEUTRAL",
      "confirmedFault": ""
    }
  ]
}
```

### Save pending evidence and request an unverified diagnosis atomically

`POST /api/jobs/:id/unverified-diagnosis`

The same optional `evidence` array may be supplied. Existing callers sending `{}` remain compatible.
