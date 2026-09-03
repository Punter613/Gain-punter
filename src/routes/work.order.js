'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const {
  createWorkOrder,
  getWorkOrder,
  listWorkOrders,
  updateWorkItemState
} = require('../services/work.order');

function fail(res, error, extra = {}) {
  return res.status(error.statusCode || 409).json({
    success: false,
    error: error.message || 'Work Order request failed',
    code: error.code || 'WORK_ORDER_REQUEST_FAILED',
    ...extra
  });
}

router.get('/', async (req, res) => {
  try {
    const workOrders = await listWorkOrders(req.params.id);
    if (!workOrders) {
      return res.status(404).json({
        success: false,
        error: 'Lifecycle number not found',
        code: 'LIFECYCLE_NOT_FOUND',
        lifecycleNumber: req.params.id
      });
    }
    return res.json({ success: true, lifecycleNumber: req.params.id, workOrders });
  } catch (error) {
    return fail(res, error, { lifecycleNumber: req.params.id });
  }
});

router.post('/', async (req, res) => {
  try {
    const result = await createWorkOrder(req.params.id, req.body || {});
    return res.status(result.created ? 201 : 200).json({
      success: true,
      created: result.created,
      lifecycleNumber: req.params.id,
      workOrder: result.workOrder
    });
  } catch (error) {
    return fail(res, error, { lifecycleNumber: req.params.id });
  }
});

router.get('/:workOrderId', async (req, res) => {
  try {
    const workOrder = await getWorkOrder(req.params.id, req.params.workOrderId);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        error: 'Work Order not found',
        code: 'WORK_ORDER_NOT_FOUND',
        lifecycleNumber: req.params.id,
        workOrderId: req.params.workOrderId
      });
    }
    return res.json({ success: true, lifecycleNumber: req.params.id, workOrder });
  } catch (error) {
    return fail(res, error, {
      lifecycleNumber: req.params.id,
      workOrderId: req.params.workOrderId
    });
  }
});

router.post('/:workOrderId/items/:workItemId/state', async (req, res) => {
  try {
    const workOrder = await updateWorkItemState(
      req.params.id,
      req.params.workOrderId,
      req.params.workItemId,
      req.body || {}
    );
    return res.json({
      success: true,
      lifecycleNumber: req.params.id,
      workOrderId: req.params.workOrderId,
      workOrder
    });
  } catch (error) {
    return fail(res, error, {
      lifecycleNumber: req.params.id,
      workOrderId: req.params.workOrderId,
      workItemId: req.params.workItemId
    });
  }
});

module.exports = router;
