'use strict';

const { createJob, getJob, patchJob } = require('./job.lifecycle');

const QUICK_ESTIMATE_TYPE = 'QUICK_ESTIMATE';
const QUICK_ESTIMATE_BASES = new Set(['CUSTOMER_REQUEST', 'PRELIMINARY_INSPECTION']);
const ITEM_DECISIONS = new Set(['PROPOSED', 'AUTHORIZED', 'DEFERRED', 'DECLINED']);
const ITEM_PRIORITIES = new Set(['CRITICAL', 'WARNING', 'ADVISORY', 'ROUTINE']);
const ESTIMATE_STATUSES = new Set([
  'DRAFT', 'PRESENTED', 'PARTIALLY_AUTHORIZED', 'AUTHORIZED', 'DEFERRED', 'DECLINED', 'SUPERSEDED'
]);

const PRELIMINARY_DISCLAIMER = 'This estimate is based on the requested service and information available when it was prepared. It is not a confirmed diagnosis or a statement that the listed repair is required unless a separate verified repair estimate explicitly says so. Final pricing or required work may change after inspection or diagnostic testing. Material changes require customer approval before additional work is performed.';

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, n) * 100) / 100;
}

function count(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 100) / 100);
}

function normalizeBasis(value) {
  const basis = clean(value, 60).toUpperCase().replace(/[\s-]+/g, '_');
  return QUICK_ESTIMATE_BASES.has(basis) ? basis : 'CUSTOMER_REQUEST';
}

function normalizePriority(value) {
  const raw = clean(value, 40).toUpperCase().replace(/[\s-]+/g, '_');
  if (raw === 'SAFETY' || raw === 'SAFETY_CRITICAL') return 'CRITICAL';
  if (ITEM_PRIORITIES.has(raw)) return raw;
  return 'ROUTINE';
}

function normalizeDecision(value) {
  const raw = clean(value, 40).toUpperCase().replace(/[\s-]+/g, '_');
  return ITEM_DECISIONS.has(raw) ? raw : 'PROPOSED';
}

function quickEstimates(job = {}) {
  return Array.isArray(job.customerEstimateCenter?.quickEstimates)
    ? job.customerEstimateCenter.quickEstimates
    : [];
}

function nextEstimateSequence(job = {}) {
  const sequences = quickEstimates(job)
    .map(estimate => Number(String(estimate.estimateId || '').match(/^QE-(\d+)$/)?.[1]))
    .filter(Number.isFinite);
  return (sequences.length ? Math.max(...sequences) : 0) + 1;
}

function documentNumber(estimateId, revision) {
  return `${estimateId}-R${revision}`;
}

function normalizeWorkItem(item = {}, index = 0, defaults = {}) {
  const description = clean(item.description || item.service || item.name, 600);
  if (!description) throw new Error(`Work item ${index + 1} requires a description`);

  const laborRate = money(item.laborRate ?? defaults.laborRate);
  const laborHours = count(item.laborHours ?? 0);
  const partsCost = money(item.partsCost ?? 0);
  const shopSupplies = money(item.shopSupplies ?? 0);
  const taxRate = count(item.taxRate ?? defaults.taxRate);
  const laborCost = money(laborHours * laborRate);
  const beforeTax = money(partsCost + laborCost + shopSupplies);
  const tax = money(beforeTax * (taxRate / 100));
  const estimatedTotal = money(beforeTax + tax);

  return {
    itemId: clean(item.itemId, 80) || `LI-${String(index + 1).padStart(3, '0')}`,
    description,
    priority: normalizePriority(item.priority),
    notes: clean(item.notes, 800),
    partsCost,
    laborHours,
    laborRate,
    laborCost,
    shopSupplies,
    taxRate,
    tax,
    estimatedTotal,
    decision: normalizeDecision(item.decision),
    decisionAt: item.decisionAt || null,
    decisionNote: clean(item.decisionNote, 600)
  };
}

function totalsForItems(items = []) {
  const totals = items.reduce((acc, item) => {
    acc.parts += money(item.partsCost);
    acc.labor += money(item.laborCost);
    acc.shopSupplies += money(item.shopSupplies);
    acc.tax += money(item.tax);
    acc.identified += money(item.estimatedTotal);
    if (item.decision === 'AUTHORIZED') acc.authorized += money(item.estimatedTotal);
    if (item.decision === 'DEFERRED') acc.deferred += money(item.estimatedTotal);
    if (item.decision === 'DECLINED') acc.declined += money(item.estimatedTotal);
    return acc;
  }, { parts: 0, labor: 0, shopSupplies: 0, tax: 0, identified: 0, authorized: 0, deferred: 0, declined: 0 });

  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, money(value)]));
}

function statusFromDecisions(items = [], fallback = 'PRESENTED') {
  if (!items.length) return fallback;
  const counts = items.reduce((acc, item) => {
    acc[item.decision] = (acc[item.decision] || 0) + 1;
    return acc;
  }, {});
  if (counts.AUTHORIZED === items.length) return 'AUTHORIZED';
  if ((counts.AUTHORIZED || 0) > 0) return 'PARTIALLY_AUTHORIZED';
  if (counts.DECLINED === items.length) return 'DECLINED';
  if ((counts.DEFERRED || 0) > 0) return 'DEFERRED';
  return fallback;
}

function buildQuickEstimate(job, input = {}, options = {}) {
  const now = new Date().toISOString();
  const estimateId = options.estimateId || `QE-${String(nextEstimateSequence(job)).padStart(3, '0')}`;
  const revision = Number(options.revision || 1);
  const laborRate = money(input.laborRate ?? 0);
  const taxRate = count(input.taxRate ?? 0);
  const rawItems = Array.isArray(input.workItems) ? input.workItems : [];
  if (!rawItems.length) throw new Error('Quick estimate requires at least one work item');
  if (rawItems.length > 30) throw new Error('Quick estimate supports up to 30 work items');

  const workItems = rawItems.map((item, index) => normalizeWorkItem(item, index, { laborRate, taxRate }));
  const totals = totalsForItems(workItems);

  return {
    type: QUICK_ESTIMATE_TYPE,
    estimateId,
    revision,
    documentNumber: documentNumber(estimateId, revision),
    lifecycleNumber: job.jobId,
    basis: normalizeBasis(input.basis),
    title: clean(input.title || input.requestedService || 'Preliminary customer estimate', 300),
    status: 'DRAFT',
    disclaimer: PRELIMINARY_DISCLAIMER,
    customer: { ...(job.customer || {}) },
    vehicle: { ...(job.vehicle || {}) },
    workItems,
    totals,
    createdAt: now,
    updatedAt: now,
    presentedAt: null,
    supersededAt: null,
    supersededBy: null
  };
}

function findEstimateRevision(job, estimateId, revision) {
  return quickEstimates(job).find(estimate =>
    estimate.estimateId === estimateId && Number(estimate.revision) === Number(revision)
  ) || null;
}

function latestEstimate(job, estimateId) {
  return quickEstimates(job)
    .filter(estimate => estimate.estimateId === estimateId)
    .sort((a, b) => Number(b.revision) - Number(a.revision))[0] || null;
}

async function createEstimateOnlyLifecycle(input = {}) {
  let job = await createJob(input);
  job = await patchJob(job.jobId, {
    intake: {
      ...(job.intake || {}),
      estimateOnly: true,
      requestedService: clean(input.requestedService || input.title, 600)
    }
  });
  return job;
}

async function createQuickEstimate(jobId, input = {}) {
  const job = await getJob(jobId);
  if (!job) return null;
  const estimate = buildQuickEstimate(job, input);
  await patchJob(jobId, {
    customerEstimateCenter: {
      ...(job.customerEstimateCenter || {}),
      quickEstimates: [...quickEstimates(job), estimate]
    }
  });
  return estimate;
}

async function reviseQuickEstimate(jobId, estimateId, input = {}) {
  const job = await getJob(jobId);
  if (!job) return null;
  const previous = latestEstimate(job, estimateId);
  if (!previous) throw new Error('Quick estimate not found');
  if (previous.status === 'SUPERSEDED') throw new Error('Cannot revise a superseded estimate revision directly');

  const revision = Number(previous.revision) + 1;
  const estimate = buildQuickEstimate(job, {
    basis: input.basis ?? previous.basis,
    title: input.title ?? previous.title,
    laborRate: input.laborRate,
    taxRate: input.taxRate,
    workItems: input.workItems?.length ? input.workItems : previous.workItems
  }, { estimateId, revision });

  const now = new Date().toISOString();
  const versions = quickEstimates(job).map(version => {
    if (version.estimateId === previous.estimateId && Number(version.revision) === Number(previous.revision)) {
      return { ...version, status: 'SUPERSEDED', supersededAt: now, supersededBy: estimate.documentNumber, updatedAt: now };
    }
    return version;
  });

  await patchJob(jobId, {
    customerEstimateCenter: {
      ...(job.customerEstimateCenter || {}),
      quickEstimates: [...versions, estimate]
    }
  });
  return estimate;
}

async function presentQuickEstimate(jobId, estimateId, revision) {
  const job = await getJob(jobId);
  if (!job) return null;
  const target = findEstimateRevision(job, estimateId, revision);
  if (!target) throw new Error('Quick estimate revision not found');
  if (target.status === 'SUPERSEDED') throw new Error('Superseded estimate revisions are read-only');

  const now = new Date().toISOString();
  let updatedEstimate;
  const versions = quickEstimates(job).map(version => {
    if (version.estimateId === estimateId && Number(version.revision) === Number(revision)) {
      updatedEstimate = {
        ...version,
        status: statusFromDecisions(version.workItems, 'PRESENTED'),
        presentedAt: version.presentedAt || now,
        updatedAt: now
      };
      return updatedEstimate;
    }
    return version;
  });

  await patchJob(jobId, { customerEstimateCenter: { ...(job.customerEstimateCenter || {}), quickEstimates: versions } });
  return updatedEstimate;
}

async function recordCustomerDecisions(jobId, estimateId, revision, decisions = []) {
  const job = await getJob(jobId);
  if (!job) return null;
  const target = findEstimateRevision(job, estimateId, revision);
  if (!target) throw new Error('Quick estimate revision not found');
  if (target.status === 'SUPERSEDED') throw new Error('Superseded estimate revisions are read-only');

  const decisionMap = new Map((Array.isArray(decisions) ? decisions : []).map(entry => [clean(entry.itemId, 80), entry]));
  if (!decisionMap.size) throw new Error('At least one work-item decision is required');

  const now = new Date().toISOString();
  const workItems = target.workItems.map(item => {
    const requested = decisionMap.get(item.itemId);
    if (!requested) return item;
    const decision = normalizeDecision(requested.decision);
    if (decision === 'PROPOSED' && clean(requested.decision, 40).toUpperCase() !== 'PROPOSED') {
      throw new Error(`Invalid decision for ${item.itemId}`);
    }
    return {
      ...item,
      decision,
      decisionAt: now,
      decisionNote: clean(requested.note || requested.decisionNote, 600)
    };
  });
  const totals = totalsForItems(workItems);
  const status = statusFromDecisions(workItems, target.presentedAt ? 'PRESENTED' : 'DRAFT');
  let updatedEstimate;
  const versions = quickEstimates(job).map(version => {
    if (version.estimateId === estimateId && Number(version.revision) === Number(revision)) {
      updatedEstimate = { ...version, workItems, totals, status, updatedAt: now };
      return updatedEstimate;
    }
    return version;
  });

  await patchJob(jobId, { customerEstimateCenter: { ...(job.customerEstimateCenter || {}), quickEstimates: versions } });
  return updatedEstimate;
}

function verifiedEstimateSummary(job = {}) {
  if (!job.estimate) return null;
  return {
    type: 'VERIFIED_REPAIR_ESTIMATE',
    lifecycleNumber: job.jobId,
    documentNumber: `VE-${job.jobId}`,
    status: 'VERIFIED_REPAIR_ESTIMATE',
    total: money(job.estimate.total),
    fingerprint: job.estimate.fingerprint || null,
    verifiedCaseFingerprint: job.estimate.verifiedCaseFingerprint || job.estimate?.evidence?.verifiedCaseFingerprint || null,
    createdAt: job.estimate.createdAt || job.estimate.snapshotAt || null
  };
}

function invoiceSummary(job = {}) {
  if (!job.invoice) return null;
  return {
    type: 'INVOICE',
    lifecycleNumber: job.jobId,
    documentNumber: job.invoice.invoiceNumber || job.jobId,
    total: money(job.invoice.total ?? job.invoice.grandTotal),
    createdAt: job.invoice.createdAt || null
  };
}

function estimateCenterSummary(job = {}) {
  return {
    lifecycleNumber: job.jobId,
    jobStatus: job.status,
    customer: job.customer || {},
    vehicle: job.vehicle || {},
    quickEstimates: [...quickEstimates(job)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    verifiedEstimate: verifiedEstimateSummary(job),
    invoice: invoiceSummary(job)
  };
}

module.exports = {
  PRELIMINARY_DISCLAIMER,
  QUICK_ESTIMATE_TYPE,
  QUICK_ESTIMATE_BASES,
  ITEM_DECISIONS,
  ITEM_PRIORITIES,
  ESTIMATE_STATUSES,
  buildQuickEstimate,
  totalsForItems,
  statusFromDecisions,
  createEstimateOnlyLifecycle,
  createQuickEstimate,
  reviseQuickEstimate,
  presentQuickEstimate,
  recordCustomerDecisions,
  estimateCenterSummary,
  quickEstimates,
  latestEstimate
};
