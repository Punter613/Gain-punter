'use strict';

const express = require('express');
const router = express.Router();
const { createFinalInvoice, getFinalInvoice } = require('../services/final.work.invoice');

function fail(res, error, lifecycleNumber) {
  const status = Number(error?.statusCode) || 409;
  return res.status(status).json({
    success: false,
    error: error?.message || 'Final invoice could not be created.',
    code: error?.code || 'FINAL_INVOICE_CONFLICT',
    lifecycleNumber
  });
}

router.get('/:id/final-invoice', async (req, res) => {
  try {
    const invoice = await getFinalInvoice(req.params.id);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Final invoice not found.',
        code: 'FINAL_INVOICE_NOT_FOUND',
        lifecycleNumber: req.params.id
      });
    }
    return res.json({ success: true, lifecycleNumber: req.params.id, invoice });
  } catch (error) {
    return fail(res, error, req.params.id);
  }
});

router.post('/:id/final-invoice', async (req, res) => {
  try {
    const result = await createFinalInvoice(req.params.id, req.body || {});
    return res.status(result.created ? 201 : 200).json({
      success: true,
      lifecycleNumber: req.params.id,
      created: result.created,
      invoice: result.invoice
    });
  } catch (error) {
    return fail(res, error, req.params.id);
  }
});

module.exports = router;
