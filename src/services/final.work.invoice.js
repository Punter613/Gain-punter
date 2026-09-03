'use strict';

const crypto = require('crypto');
const { getJob, patchJob } = require('./job.lifecycle');
const {
  workOrders,
  assertScopeIntegrity,
  withWorkOrderMutationLock
} = require('./work.order');

const FINAL_INVOICE_SCHEMA_VERSION = 1;
const FINAL_INVOICE_TYPE = 'FINAL_INVOICE';
const FINAL_INVOICE_POLICY = 'BILL_COMPLETED_AUTHORIZED_WORK_ONLY';
const TERMINAL_WORK_ITEM_STATES = new Set(['COMPLETED', 'CANCELLED']);

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw fail('Invoice source contains an invalid monetary value.', 'INVALID_INVOICE_MONEY');
  return Math.round(n * 100) / 100;
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

function fail(message, code = 'FINAL_INVOICE_CONFLICT', statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function invoiceFingerprintPayload(invoice = {}) {
  return {
    schemaVersion: invoice.schemaVersion,
    type: invoice.type,
    lifecycleNumber: invoice.lifecycleNumber,
    documentNumber: invoice.documentNumber,
    policy: invoice.policy,
    customer: invoice.customer,
    vehicle: invoice.vehicle,
    sourceWorkOrders: invoice.sourceWorkOrders,
    lineItems: invoice.lineItems,
    totals: invoice.totals,
    diagnosticTruthBoundary: invoice.diagnosticTruthBoundary,
    finalizedAt: invoice.finalizedAt
  };
}

function assertInvoiceIntegrity(invoice = {}) {
  if (invoice.type !== FINAL_INVOICE_TYPE) {
    throw fail('Stored invoice is not a completed-work final invoice.', 'FINAL_INVOICE_TYPE_MISMATCH');
  }
  const actual = fingerprint(invoiceFingerprintPayload(invoice));
  if (!invoice.invoiceFingerprint || actual !== invoice.invoiceFingerprint) {
    throw fail('Final invoice integrity check failed.', 'FINAL_INVOICE_INTEGRITY_FAILED');
  }
  return true;
}

function validateCompletedLine(order, item) {
  if (item.authorizationSnapshot?.decision !== 'AUTHORIZED' || !item.authorizationSnapshot?.decisionAt) {
    throw fail(
      `Completed Work Order line ${order.workOrderId}/${item.workItemId} is missing persisted authorization truth.`,
      'COMPLETED_LINE_NOT_AUTHORIZED'
    );
  }
  if (!item.completedAt || !clean(item.completionNote, 1000)) {
    throw fail(
      `Completed Work Order line ${order.workOrderId}/${item.workItemId} is missing completion evidence.`,
      'COMPLETION_EVIDENCE_REQUIRED'
    );
  }
  if (item.billing?.invoiceNumber) {
    throw fail(
      `Completed Work Order line ${order.workOrderId}/${item.workItemId} is already billed on ${item.billing.invoiceNumber}.`,
      'WORK_ITEM_ALREADY_INVOICED'
    );
  }
}

function collectInvoiceableWork(job = {}) {
  const orders = workOrders(job);
  if (!orders.length) throw fail('Final invoice requires at least one persisted Work Order.', 'WORK_ORDER_REQUIRED');

  const open = [];
  const completed = [];
  for (const order of orders) {
    assertScopeIntegrity(order);
    for (const item of order.workItems || []) {
      if (!TERMINAL_WORK_ITEM_STATES.has(item.state)) {
        open.push({ workOrderId: order.workOrderId, workItemId: item.workItemId, state: item.state });
        continue;
      }
      if (item.state === 'COMPLETED') {
        validateCompletedLine(order, item);
        completed.push({ order, item });
      }
    }
  }

  if (open.length) {
    const preview = open.slice(0, 5).map(entry => `${entry.workOrderId}/${entry.workItemId}:${entry.state}`).join(', ');
    throw fail(
      `Final invoice is blocked while authorized Work Order lines remain open: ${preview}`,
      'WORK_REMAINS_OPEN'
    );
  }
  if (!completed.length) {
    throw fail('Final invoice requires at least one AUTHORIZED + COMPLETED Work Order line.', 'COMPLETED_AUTHORIZED_WORK_REQUIRED');
  }
  return { orders, completed };
}

function completionActor(item = {}) {
  const completedEvent = [...(item.executionHistory || [])].reverse().find(event => event.state === 'COMPLETED');
  return clone(completedEvent?.actor || { label: '', identityVerified: false });
}

function buildInvoiceLine(entry, index) {
  const { order, item } = entry;
  const pricing = clone(item.pricingSnapshot || {});
  const parts = money(pricing.partsCost || 0);
  const labor = money(pricing.laborCost || 0);
  const shopSupplies = money(pricing.shopSupplies || 0);
  const tax = money(pricing.tax || 0);
  const total = money(pricing.estimatedTotal || (parts + labor + shopSupplies + tax));
  const expected = money(parts + labor + shopSupplies + tax);
  if (total !== expected) {
    throw fail(
      `Authorized pricing snapshot no longer balances for ${order.workOrderId}/${item.workItemId}.`,
      'AUTHORIZED_PRICE_SNAPSHOT_INVALID'
    );
  }

  return {
    lineId: `INV-L${String(index + 1).padStart(3, '0')}`,
    sourceWorkOrderId: order.workOrderId,
    sourceWorkItemId: item.workItemId,
    sourceEstimateDocument: order.sourceEstimate?.documentNumber || null,
    sourceEstimateItemId: item.sourceItemId,
    description: clean(item.description, 600),
    priority: clean(item.priority, 40) || 'ROUTINE',
    pricingSnapshot: {
      partsCost: parts,
      laborHours: Number(pricing.laborHours) || 0,
      laborRate: money(pricing.laborRate || 0),
      laborCost: labor,
      shopSupplies,
      taxRate: Number(pricing.taxRate) || 0,
      tax,
      total
    },
    authorization: {
      decision: 'AUTHORIZED',
      decisionAt: item.authorizationSnapshot.decisionAt,
      decisionNote: clean(item.authorizationSnapshot.decisionNote, 600),
      sourceEstimateDocument: item.authorizationSnapshot.sourceEstimateDocument || order.sourceEstimate?.documentNumber || null
    },
    completion: {
      completedAt: item.completedAt,
      completionNote: clean(item.completionNote, 1000),
      actor: completionActor(item)
    },
    diagnosticTruth: {
      status: item.truthBasis?.diagnosticTruthStatus || 'NOT_VERIFIED',
      physicallyVerified: item.truthBasis?.physicallyVerified === true,
      scopeMatchEstablished: item.truthBasis?.scopeMatchEstablished === true,
      note: clean(item.truthBasis?.note, 1000)
    }
  };
}

function totalsForLines(lines = []) {
  const totals = lines.reduce((acc, line) => {
    const pricing = line.pricingSnapshot || {};
    acc.parts += money(pricing.partsCost || 0);
    acc.labor += money(pricing.laborCost || 0);
    acc.shopSupplies += money(pricing.shopSupplies || 0);
    acc.tax += money(pricing.tax || 0);
    acc.total += money(pricing.total || 0);
    return acc;
  }, { parts: 0, labor: 0, shopSupplies: 0, tax: 0, total: 0 });
  totals.subtotal = money(totals.parts + totals.labor + totals.shopSupplies);
  for (const key of Object.keys(totals)) totals[key] = money(totals[key]);
  if (money(totals.subtotal + totals.tax) !== totals.total) {
    throw fail('Final invoice totals do not balance to completed authorized line snapshots.', 'FINAL_INVOICE_TOTAL_MISMATCH');
  }
  return totals;
}

function buildFinalInvoice(job, completed, input = {}) {
  const finalizedAt = new Date().toISOString();
  const lineItems = completed.map(buildInvoiceLine);
  const sourceOrders = [...new Map(completed.map(({ order }) => [order.workOrderId, order])).values()];
  const invoice = {
    schemaVersion: FINAL_INVOICE_SCHEMA_VERSION,
    type: FINAL_INVOICE_TYPE,
    status: 'FINAL',
    lifecycleNumber: job.jobId,
    jobId: job.jobId,
    invoiceNumber: 'INV-001',
    documentNumber: 'INV-001',
    policy: FINAL_INVOICE_POLICY,
    customer: clone(job.customer || {}),
    vehicle: clone(job.vehicle || {}),
    sourceWorkOrders: sourceOrders.map(order => ({
      workOrderId: order.workOrderId,
      documentNumber: order.documentNumber,
      status: order.status,
      sourceEstimate: clone(order.sourceEstimate || {}),
      scopeFingerprint: order.scopeFingerprint
    })),
    lineItems,
    totals: totalsForLines(lineItems),
    total: totalsForLines(lineItems).total,
    diagnosticTruthBoundary: {
      policy: 'AUTHORIZATION_AND_COMPLETION_DO_NOT_CREATE_DIAGNOSTIC_PROOF',
      note: 'This invoice proves what was authorized, completed, and billed. Diagnostic verification remains a separate fact recorded on the lifecycle.'
    },
    request: {
      requestId: clean(input.requestId || input.idempotencyKey, 160),
      recordedBy: clean(input.recordedBy, 120),
      identityVerified: false,
      note: clean(input.note, 800)
    },
    createdAt: finalizedAt,
    finalizedAt
  };
  invoice.invoiceFingerprint = fingerprint(invoiceFingerprintPayload(invoice));
  return invoice;
}

function attachBillingMarkers(orders, invoice) {
  const billed = new Set(invoice.lineItems.map(line => `${line.sourceWorkOrderId}:${line.sourceWorkItemId}`));
  return orders.map(order => {
    let orderBilled = false;
    const workItems = (order.workItems || []).map(item => {
      const key = `${order.workOrderId}:${item.workItemId}`;
      if (!billed.has(key)) return item;
      orderBilled = true;
      return {
        ...item,
        billing: {
          invoiceNumber: invoice.invoiceNumber,
          invoiceFingerprint: invoice.invoiceFingerprint,
          invoicedAt: invoice.finalizedAt
        }
      };
    });
    return orderBilled
      ? {
          ...order,
          workItems,
          billing: {
            invoiceNumber: invoice.invoiceNumber,
            invoiceFingerprint: invoice.invoiceFingerprint,
            invoicedAt: invoice.finalizedAt
          }
        }
      : order;
  });
}

async function createFinalInvoice(jobId, input = {}) {
  return withWorkOrderMutationLock(jobId, async () => {
    const job = await getJob(jobId);
    if (!job) throw fail('Lifecycle number not found.', 'LIFECYCLE_NOT_FOUND', 404);

    if (job.invoice) {
      if (job.invoice.type === FINAL_INVOICE_TYPE) {
        assertInvoiceIntegrity(job.invoice);
        return { created: false, invoice: clone(job.invoice) };
      }
      throw fail('This lifecycle already contains a different invoice record.', 'INVOICE_ALREADY_EXISTS');
    }

    const { orders, completed } = collectInvoiceableWork(job);
    const invoice = buildFinalInvoice(job, completed, input);
    const updatedOrders = attachBillingMarkers(orders, invoice);
    const persisted = await patchJob(jobId, {
      status: 'INVOICED',
      invoice,
      workOrderCenter: {
        ...(job.workOrderCenter || {}),
        workOrders: updatedOrders
      }
    });
    if (!persisted) throw fail('Final invoice could not be persisted.', 'FINAL_INVOICE_PERSIST_FAILED');
    return { created: true, invoice: clone(invoice) };
  });
}

async function getFinalInvoice(jobId) {
  const job = await getJob(jobId);
  if (!job) return null;
  if (!job.invoice || job.invoice.type !== FINAL_INVOICE_TYPE) return null;
  assertInvoiceIntegrity(job.invoice);
  return clone(job.invoice);
}

module.exports = {
  FINAL_INVOICE_SCHEMA_VERSION,
  FINAL_INVOICE_TYPE,
  FINAL_INVOICE_POLICY,
  TERMINAL_WORK_ITEM_STATES,
  invoiceFingerprintPayload,
  assertInvoiceIntegrity,
  collectInvoiceableWork,
  totalsForLines,
  buildFinalInvoice,
  createFinalInvoice,
  getFinalInvoice
};
