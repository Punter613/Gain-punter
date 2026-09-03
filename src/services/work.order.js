'use strict';

const crypto = require('crypto');
const { getJob, patchJob } = require('./job.lifecycle');

const WORK_ORDER_SCHEMA_VERSION = 1;
const WORK_ORDER_POLICY = 'CUSTOMER_AUTHORIZATION_IS_NOT_DIAGNOSTIC_PROOF';
const WORK_ORDER_STATES = new Set([
  'READY', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED', 'BLOCKED', 'CANCELLED'
]);
const WORK_ITEM_STATES = new Set(['READY', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'CANCELLED']);
const PACKAGE_POLICIES = new Set(['INDEPENDENT', 'ALL_OR_NONE']);
const workOrderMutationQueues = new Map();

function clean(value, max = 800) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, n) * 100) / 100;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => {
    if (value[key] !== undefined) out[key] = stable(value[key]);
    return out;
  }, {});
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function fail(message, code = 'WORK_ORDER_CONFLICT', statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function withWorkOrderMutationLock(jobId, operation) {
  const key = clean(jobId, 160);
  const prior = workOrderMutationQueues.get(key) || Promise.resolve();
  const next = prior.catch(() => {}).then(operation);
  workOrderMutationQueues.set(key, next);
  return next.finally(() => {
    if (workOrderMutationQueues.get(key) === next) workOrderMutationQueues.delete(key);
  });
}

function quickEstimates(job = {}) {
  return Array.isArray(job.customerEstimateCenter?.quickEstimates)
    ? job.customerEstimateCenter.quickEstimates
    : [];
}

function workOrders(job = {}) {
  return Array.isArray(job.workOrderCenter?.workOrders)
    ? job.workOrderCenter.workOrders
    : [];
}

function findEstimateRevision(job, estimateId, revision) {
  return quickEstimates(job).find(estimate =>
    estimate.estimateId === estimateId && Number(estimate.revision) === Number(revision)
  ) || null;
}

function nextWorkOrderSequence(job = {}) {
  const values = workOrders(job)
    .map(order => Number(String(order.workOrderId || '').match(/^WO-(\d+)$/)?.[1]))
    .filter(Number.isFinite);
  return (values.length ? Math.max(...values) : 0) + 1;
}

function normalizePackagePolicy(value) {
  const raw = clean(value, 40).toUpperCase().replace(/[\s-]+/g, '_');
  return PACKAGE_POLICIES.has(raw) ? raw : 'INDEPENDENT';
}

function diagnosticTruthSnapshot(job = {}) {
  const verified = job.verifiedCase;
  if (verified?.stage === 'VERIFIED' && verified?.fingerprint) {
    return {
      status: 'VERIFIED_CASE_PRESENT_BUT_SCOPE_UNLINKED',
      verifiedCasePresent: true,
      physicallyVerified: false,
      scopeMatchEstablished: false,
      confirmedCause: clean(verified.verification?.confirmedCause, 300),
      verifiedCaseFingerprint: verified.fingerprint,
      verifiedAt: verified.verification?.verifiedAt || null,
      note: 'A canonical VERIFIED_CASE exists on this lifecycle, but this QUICK_ESTIMATE Work Order is not automatically linked to that verified fault.'
    };
  }
  return {
    status: 'NOT_VERIFIED',
    verifiedCasePresent: false,
    physicallyVerified: false,
    scopeMatchEstablished: false,
    confirmedCause: '',
    verifiedCaseFingerprint: null,
    verifiedAt: null,
    note: 'No canonical VERIFIED_CASE establishes this QUICK_ESTIMATE Work Order scope as mechanically required.'
  };
}

function requestedItemIds(input = {}, target = {}) {
  const explicit = Array.isArray(input.itemIds)
    ? [...new Set(input.itemIds.map(value => clean(value, 80)).filter(Boolean))]
    : [];
  if (explicit.length) return explicit;
  return (target.workItems || [])
    .filter(item => item.decision === 'AUTHORIZED')
    .map(item => item.itemId);
}

function validateSelectedAuthorization(target, itemIds) {
  if (!itemIds.length) {
    throw fail('Work Order requires at least one AUTHORIZED estimate line.', 'AUTHORIZED_SCOPE_REQUIRED');
  }
  const byId = new Map((target.workItems || []).map(item => [item.itemId, item]));
  const selected = itemIds.map(id => byId.get(id));
  if (selected.some(item => !item)) {
    throw fail('Work Order item selection must reference lines on the source estimate revision.', 'UNKNOWN_ESTIMATE_ITEM');
  }
  const unauthorized = selected.filter(item => item.decision !== 'AUTHORIZED');
  if (unauthorized.length) {
    throw fail(
      `Work Order may include AUTHORIZED lines only. Not authorized: ${unauthorized.map(item => item.itemId).join(', ')}`,
      'UNAUTHORIZED_WORK_SCOPE'
    );
  }
  const missingDecisionTime = selected.filter(item => !item.decisionAt);
  if (missingDecisionTime.length) {
    throw fail(
      `Authorized estimate lines must contain a persisted customer-decision timestamp before Work Order creation: ${missingDecisionTime.map(item => item.itemId).join(', ')}`,
      'AUTHORIZATION_TIMESTAMP_REQUIRED'
    );
  }

  const selectedIds = new Set(itemIds);
  for (const item of selected) {
    const packageId = clean(item.packageId, 80);
    const packagePolicy = normalizePackagePolicy(item.packagePolicy);
    if (!packageId || packagePolicy !== 'ALL_OR_NONE') continue;

    const packageItems = (target.workItems || []).filter(candidate => clean(candidate.packageId, 80) === packageId);
    const missingAuthorization = packageItems.filter(candidate => candidate.decision !== 'AUTHORIZED');
    if (missingAuthorization.length) {
      throw fail(
        `Safety/dependency package ${packageId} is ALL_OR_NONE and cannot enter a Work Order until every package line is AUTHORIZED.`,
        'WORK_PACKAGE_NOT_FULLY_AUTHORIZED'
      );
    }
    const omitted = packageItems.filter(candidate => !selectedIds.has(candidate.itemId));
    if (omitted.length) {
      throw fail(
        `Safety/dependency package ${packageId} is ALL_OR_NONE and cannot be split across the Work Order.`,
        'WORK_PACKAGE_SPLIT_BLOCKED'
      );
    }
  }

  return selected;
}

function immutableWorkItemScope(item = {}) {
  return {
    workItemId: item.workItemId,
    sourceItemId: item.sourceItemId,
    description: item.description,
    priority: item.priority,
    notes: item.notes,
    packageId: item.packageId,
    packagePolicy: item.packagePolicy,
    pricingSnapshot: item.pricingSnapshot,
    authorizationSnapshot: item.authorizationSnapshot,
    truthBasis: item.truthBasis
  };
}

function workOrderScopePayload(order = {}) {
  return {
    schemaVersion: order.schemaVersion,
    lifecycleNumber: order.lifecycleNumber,
    sourceEstimate: order.sourceEstimate,
    truthPolicy: order.truthPolicy,
    diagnosticTruthSnapshot: order.diagnosticTruthSnapshot,
    workItems: (order.workItems || []).map(immutableWorkItemScope)
  };
}

function assertScopeIntegrity(order = {}) {
  const actual = fingerprint(workOrderScopePayload(order));
  if (!order.scopeFingerprint || actual !== order.scopeFingerprint) {
    throw fail('Work Order authorization snapshot integrity check failed.', 'WORK_ORDER_SCOPE_INTEGRITY_FAILED');
  }
  return true;
}

function summarizeExecutionTotals(items = []) {
  const totals = items.reduce((acc, item) => {
    const value = money(item.pricingSnapshot?.estimatedTotal);
    acc.authorizedPlanned += value;
    if (item.state === 'COMPLETED') acc.completed += value;
    if (item.state === 'CANCELLED') acc.cancelled += value;
    if (!['COMPLETED', 'CANCELLED'].includes(item.state)) acc.remaining += value;
    return acc;
  }, { authorizedPlanned: 0, completed: 0, cancelled: 0, remaining: 0 });
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, money(value)]));
}

function deriveWorkOrderStatus(items = []) {
  if (!items.length) return 'CANCELLED';
  const states = items.map(item => item.state);
  if (states.every(state => state === 'COMPLETED')) return 'COMPLETED';
  if (states.every(state => state === 'CANCELLED')) return 'CANCELLED';
  if (states.some(state => state === 'COMPLETED')) return 'PARTIALLY_COMPLETED';
  if (states.some(state => state === 'IN_PROGRESS')) return 'IN_PROGRESS';
  if (states.every(state => ['BLOCKED', 'CANCELLED'].includes(state))) return 'BLOCKED';
  return 'READY';
}

function transitionAllowed(from, to) {
  const transitions = {
    READY: new Set(['IN_PROGRESS', 'BLOCKED', 'CANCELLED']),
    IN_PROGRESS: new Set(['COMPLETED', 'BLOCKED', 'CANCELLED']),
    BLOCKED: new Set(['READY', 'IN_PROGRESS', 'CANCELLED']),
    COMPLETED: new Set(),
    CANCELLED: new Set()
  };
  return transitions[from]?.has(to) === true;
}

function buildWorkOrder(job, target, selected, input = {}) {
  const now = new Date().toISOString();
  const workOrderId = `WO-${String(nextWorkOrderSequence(job)).padStart(3, '0')}`;
  const diagnosticTruth = diagnosticTruthSnapshot(job);
  const items = selected.map((item, index) => ({
    workItemId: `WOI-${String(index + 1).padStart(3, '0')}`,
    sourceItemId: item.itemId,
    description: clean(item.description, 600),
    priority: clean(item.priority, 40) || 'ROUTINE',
    notes: clean(item.notes, 800),
    packageId: clean(item.packageId, 80),
    packagePolicy: normalizePackagePolicy(item.packagePolicy),
    pricingSnapshot: {
      partsCost: money(item.partsCost),
      laborHours: Number(item.laborHours) || 0,
      laborRate: money(item.laborRate),
      laborCost: money(item.laborCost),
      shopSupplies: money(item.shopSupplies),
      taxRate: Number(item.taxRate) || 0,
      tax: money(item.tax),
      estimatedTotal: money(item.estimatedTotal)
    },
    authorizationSnapshot: {
      decision: 'AUTHORIZED',
      decisionAt: item.decisionAt,
      decisionNote: clean(item.decisionNote, 600),
      sourceEstimateDocument: target.documentNumber,
      capturedAt: now
    },
    truthBasis: {
      source: 'QUICK_ESTIMATE',
      diagnosticTruthStatus: diagnosticTruth.status,
      physicallyVerified: false,
      scopeMatchEstablished: false,
      note: diagnosticTruth.verifiedCasePresent
        ? 'A verified fault exists elsewhere on this lifecycle, but this Quick Estimate line is not automatically proven to be part of that verified repair scope.'
        : 'Customer authorization approves this scope of work but does not prove that a diagnostic repair is mechanically required.'
    },
    state: 'READY',
    stateUpdatedAt: now,
    startedAt: null,
    completedAt: null,
    completionNote: '',
    blockedReason: '',
    executionHistory: [{
      state: 'READY',
      at: now,
      note: 'Work Order created from an authorized estimate snapshot.',
      actor: { label: clean(input.recordedBy, 120), identityVerified: false }
    }]
  }));

  const order = {
    schemaVersion: WORK_ORDER_SCHEMA_VERSION,
    type: 'WORK_ORDER',
    workOrderId,
    documentNumber: workOrderId,
    lifecycleNumber: job.jobId,
    status: 'READY',
    truthPolicy: WORK_ORDER_POLICY,
    diagnosticTruthSnapshot: diagnosticTruth,
    sourceEstimate: {
      type: target.type || 'QUICK_ESTIMATE',
      estimateId: target.estimateId,
      revision: Number(target.revision),
      documentNumber: target.documentNumber,
      basis: target.basis,
      capturedAt: now
    },
    authorizationRequest: {
      requestId: clean(input.requestId || input.idempotencyKey, 160),
      note: clean(input.authorizationNote || input.note, 800),
      recordedBy: clean(input.recordedBy, 120),
      identityVerified: false
    },
    workItems: items,
    totals: summarizeExecutionTotals(items),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelledAt: null
  };
  order.scopeFingerprint = fingerprint(workOrderScopePayload(order));
  return order;
}

function sameAuthorizedScope(order, target, itemIds) {
  if (order.sourceEstimate?.documentNumber !== target.documentNumber) return false;
  const existing = [...(order.workItems || []).map(item => item.sourceItemId)].sort();
  const requested = [...itemIds].sort();
  return JSON.stringify(existing) === JSON.stringify(requested);
}

function requestIdMatch(order = {}, requestId = '') {
  return !!requestId && clean(order.authorizationRequest?.requestId, 160) === requestId;
}

function assertRequestIdCompatible(order = {}, estimateId, revision) {
  const sameSource = order.sourceEstimate?.estimateId === estimateId
    && Number(order.sourceEstimate?.revision) === Number(revision);
  if (!sameSource) {
    throw fail(
      'The Work Order requestId/idempotencyKey was already used for a different source estimate revision.',
      'WORK_ORDER_IDEMPOTENCY_KEY_REUSED'
    );
  }
}

async function createWorkOrderUnlocked(jobId, input = {}) {
  const job = await getJob(jobId);
  if (!job) throw fail('Lifecycle number not found.', 'LIFECYCLE_NOT_FOUND', 404);

  const estimateId = clean(input.estimateId, 80);
  const revision = Number(input.revision);
  if (!estimateId || !Number.isFinite(revision) || revision < 1) {
    throw fail('Work Order requires a source estimateId and revision.', 'SOURCE_ESTIMATE_REQUIRED');
  }

  const requestId = clean(input.requestId || input.idempotencyKey, 160);
  const priorRequest = requestId
    ? workOrders(job).find(order => requestIdMatch(order, requestId))
    : null;
  if (priorRequest) {
    assertRequestIdCompatible(priorRequest, estimateId, revision);
    assertScopeIntegrity(priorRequest);
    return { created: false, workOrder: clone(priorRequest) };
  }

  if (job.invoice) {
    throw fail('A new Work Order cannot be created after the final invoice on this lifecycle.', 'FINAL_INVOICE_ALREADY_EXISTS');
  }

  const target = findEstimateRevision(job, estimateId, revision);
  if (!target) throw fail('Source estimate revision not found.', 'SOURCE_ESTIMATE_NOT_FOUND', 404);
  if (target.status === 'SUPERSEDED') {
    throw fail('A superseded estimate revision cannot create a new Work Order.', 'SUPERSEDED_ESTIMATE_READ_ONLY');
  }

  const itemIds = requestedItemIds(input, target);
  const selected = validateSelectedAuthorization(target, itemIds);
  const existing = workOrders(job).find(order => sameAuthorizedScope(order, target, itemIds));
  if (existing) {
    assertScopeIntegrity(existing);
    return { created: false, workOrder: clone(existing) };
  }

  const workOrder = buildWorkOrder(job, target, selected, input);
  const persisted = await patchJob(jobId, {
    workOrderCenter: {
      ...(job.workOrderCenter || {}),
      workOrders: [...workOrders(job), workOrder]
    }
  });
  if (!persisted) throw fail('Work Order could not be persisted.', 'WORK_ORDER_PERSIST_FAILED');
  return { created: true, workOrder: clone(workOrder) };
}

async function createWorkOrder(jobId, input = {}) {
  return withWorkOrderMutationLock(jobId, () => createWorkOrderUnlocked(jobId, input));
}

async function getWorkOrder(jobId, workOrderId) {
  const job = await getJob(jobId);
  if (!job) return null;
  const order = workOrders(job).find(item => item.workOrderId === workOrderId) || null;
  if (order) assertScopeIntegrity(order);
  return clone(order);
}

async function listWorkOrders(jobId) {
  const job = await getJob(jobId);
  if (!job) return null;
  const orders = workOrders(job);
  orders.forEach(assertScopeIntegrity);
  return clone(orders);
}

async function updateWorkItemState(jobId, workOrderId, workItemId, input = {}) {
  return withWorkOrderMutationLock(jobId, async () => {
    const job = await getJob(jobId);
    if (!job) throw fail('Lifecycle number not found.', 'LIFECYCLE_NOT_FOUND', 404);
    const orders = workOrders(job);
    const orderIndex = orders.findIndex(item => item.workOrderId === workOrderId);
    if (orderIndex < 0) throw fail('Work Order not found.', 'WORK_ORDER_NOT_FOUND', 404);

    const order = clone(orders[orderIndex]);
    assertScopeIntegrity(order);
    const itemIndex = (order.workItems || []).findIndex(item => item.workItemId === workItemId);
    if (itemIndex < 0) throw fail('Work Order item not found.', 'WORK_ORDER_ITEM_NOT_FOUND', 404);

    const item = order.workItems[itemIndex];
    const nextState = clean(input.state, 40).toUpperCase().replace(/[\s-]+/g, '_');
    if (!WORK_ITEM_STATES.has(nextState)) {
      throw fail('Work item state must be READY, IN_PROGRESS, COMPLETED, BLOCKED, or CANCELLED.', 'INVALID_WORK_ITEM_STATE');
    }
    if (nextState === item.state) return clone(order);
    if (!transitionAllowed(item.state, nextState)) {
      throw fail(`Work item cannot transition from ${item.state} to ${nextState}.`, 'INVALID_WORK_ITEM_TRANSITION');
    }

    const completionNote = clean(input.completionNote || input.note, 1000);
    const blockedReason = clean(input.blockedReason || input.note, 1000);
    if (nextState === 'COMPLETED' && !completionNote) {
      throw fail('COMPLETED work requires a completion note describing what was actually performed.', 'COMPLETION_EVIDENCE_REQUIRED');
    }
    if (nextState === 'BLOCKED' && !blockedReason) {
      throw fail('BLOCKED work requires a reason.', 'BLOCKED_REASON_REQUIRED');
    }

    const now = new Date().toISOString();
    const actor = { label: clean(input.recordedBy, 120), identityVerified: false };
    const updatedItem = {
      ...item,
      state: nextState,
      stateUpdatedAt: now,
      startedAt: nextState === 'IN_PROGRESS' ? (item.startedAt || now) : item.startedAt,
      completedAt: nextState === 'COMPLETED' ? now : item.completedAt,
      completionNote: nextState === 'COMPLETED' ? completionNote : item.completionNote,
      blockedReason: nextState === 'BLOCKED' ? blockedReason : (nextState === 'READY' || nextState === 'IN_PROGRESS' ? '' : item.blockedReason),
      executionHistory: [
        ...(item.executionHistory || []),
        { state: nextState, at: now, note: completionNote || blockedReason || clean(input.note, 1000), actor }
      ]
    };
    order.workItems[itemIndex] = updatedItem;
    order.status = deriveWorkOrderStatus(order.workItems);
    if (!WORK_ORDER_STATES.has(order.status)) throw fail('Derived Work Order state is invalid.', 'INVALID_WORK_ORDER_STATE');
    order.totals = summarizeExecutionTotals(order.workItems);
    order.updatedAt = now;
    order.completedAt = order.status === 'COMPLETED' ? (order.completedAt || now) : null;
    order.cancelledAt = order.status === 'CANCELLED' ? (order.cancelledAt || now) : null;
    assertScopeIntegrity(order);

    const nextOrders = orders.map((existing, index) => index === orderIndex ? order : existing);
    const persisted = await patchJob(jobId, {
      workOrderCenter: {
        ...(job.workOrderCenter || {}),
        workOrders: nextOrders
      }
    });
    if (!persisted) throw fail('Work Order state could not be persisted.', 'WORK_ORDER_PERSIST_FAILED');
    return clone(order);
  });
}

function workOrderSummary(job = {}) {
  const orders = workOrders(job);
  return orders.map(order => ({
    workOrderId: order.workOrderId,
    documentNumber: order.documentNumber,
    status: order.status,
    sourceEstimate: clone(order.sourceEstimate),
    diagnosticTruthStatus: order.diagnosticTruthSnapshot?.status || 'NOT_VERIFIED',
    authorizedPlanned: money(order.totals?.authorizedPlanned),
    completed: money(order.totals?.completed),
    remaining: money(order.totals?.remaining),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  }));
}

module.exports = {
  WORK_ORDER_SCHEMA_VERSION,
  WORK_ORDER_POLICY,
  WORK_ORDER_STATES,
  WORK_ITEM_STATES,
  PACKAGE_POLICIES,
  workOrders,
  workOrderSummary,
  diagnosticTruthSnapshot,
  summarizeExecutionTotals,
  deriveWorkOrderStatus,
  assertScopeIntegrity,
  createWorkOrder,
  getWorkOrder,
  listWorkOrders,
  updateWorkItemState,
  withWorkOrderMutationLock
};
