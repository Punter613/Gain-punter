'use strict';

const express = require('express');
const router = express.Router();
const { getJob } = require('../services/job.lifecycle');
const { workOrderSummary } = require('../services/work.order');
const {
  createEstimateOnlyLifecycle,
  createQuickEstimate,
  reviseQuickEstimate,
  presentQuickEstimate,
  recordCustomerDecisions,
  estimateCenterSummary
} = require('../services/customer.estimate.center');

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ success: false, error, ...extra });
}

router.post('/job', async (req, res) => {
  try {
    const job = await createEstimateOnlyLifecycle(req.body || {});
    return res.status(201).json({
      success: true,
      lifecycleNumber: job.jobId,
      jobId: job.jobId,
      estimateOnly: true,
      customer: job.customer,
      vehicle: job.vehicle
    });
  } catch (err) {
    return fail(res, 409, err.message || 'Unable to create estimate-only lifecycle');
  }
});

router.get('/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, 'Lifecycle number not found', { lifecycleNumber: req.params.id });
  return res.json({
    success: true,
    ...estimateCenterSummary(job),
    workOrders: workOrderSummary(job)
  });
});

router.post('/:id/quick', async (req, res) => {
  try {
    const estimate = await createQuickEstimate(req.params.id, req.body || {});
    if (!estimate) return fail(res, 404, 'Lifecycle number not found', { lifecycleNumber: req.params.id });
    return res.status(201).json({ success: true, lifecycleNumber: req.params.id, estimate });
  } catch (err) {
    return fail(res, 409, err.message, { lifecycleNumber: req.params.id });
  }
});

router.post('/:id/quick/:estimateId/revise', async (req, res) => {
  try {
    const estimate = await reviseQuickEstimate(req.params.id, req.params.estimateId, req.body || {});
    if (!estimate) return fail(res, 404, 'Lifecycle number not found', { lifecycleNumber: req.params.id });
    return res.status(201).json({ success: true, lifecycleNumber: req.params.id, estimate });
  } catch (err) {
    return fail(res, 409, err.message, { lifecycleNumber: req.params.id });
  }
});

router.post('/:id/quick/:estimateId/:revision/present', async (req, res) => {
  try {
    const estimate = await presentQuickEstimate(req.params.id, req.params.estimateId, req.params.revision);
    if (!estimate) return fail(res, 404, 'Lifecycle number not found', { lifecycleNumber: req.params.id });
    return res.json({ success: true, lifecycleNumber: req.params.id, estimate });
  } catch (err) {
    return fail(res, 409, err.message, { lifecycleNumber: req.params.id });
  }
});

router.post('/:id/quick/:estimateId/:revision/decisions', async (req, res) => {
  try {
    const estimate = await recordCustomerDecisions(
      req.params.id,
      req.params.estimateId,
      req.params.revision,
      req.body?.decisions || []
    );
    if (!estimate) return fail(res, 404, 'Lifecycle number not found', { lifecycleNumber: req.params.id });
    return res.json({
      success: true,
      lifecycleNumber: req.params.id,
      estimate,
      totalIdentified: estimate.totals.identified,
      authorizedToday: estimate.totals.authorized,
      deferred: estimate.totals.deferred,
      declined: estimate.totals.declined
    });
  } catch (err) {
    return fail(res, 409, err.message, { lifecycleNumber: req.params.id });
  }
});

module.exports = router;
