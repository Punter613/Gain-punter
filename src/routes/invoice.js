const express = require('express');
const router = express.Router();

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invoice contains invalid monetary value');
  return Math.round(n * 100) / 100;
}

function buildCanonicalLines(est) {
  const resolution = est.repairResolution;
  if (!resolution || resolution.stage !== 'REPAIR_RESOLVED' || !resolution.fingerprint) {
    throw new Error('Canonical invoice requires persisted repair resolution');
  }

  const operations = new Map((resolution.operations || []).map(op => [op.operationId, op]));
  const labor = resolution.labor || {};
  const laborOperation = operations.get(labor.operationId);
  if (!laborOperation) throw new Error('Canonical invoice labor line is not bound to verified operation');

  const laborAmount = money(Number(labor.hours) * Number(labor.hourlyRate));
  const laborLines = [{
    lineNumber: 1,
    type: 'LABOR',
    operationId: labor.operationId,
    description: laborOperation.cause || laborOperation.component || 'Verified repair labor',
    hours: Number(labor.hours),
    rate: money(labor.hourlyRate),
    amount: laborAmount,
    source: labor.hoursSource
  }];

  const partsLines = (resolution.parts || []).map((part, index) => {
    if (!operations.has(part.operationId)) throw new Error('Canonical invoice part line is not bound to verified operation');
    return {
      lineNumber: laborLines.length + index + 1,
      type: 'PARTS',
      operationId: part.operationId,
      partNumber: part.partNumber || '',
      description: part.description || 'Verified repair part',
      quantity: Number(part.quantity),
      unitPrice: money(part.unitPrice),
      amount: money(part.total),
      source: part.source || 'MECHANIC_INPUT'
    };
  });

  const partsTotal = money(partsLines.reduce((sum, line) => sum + line.amount, 0));
  if (money(est.laborCost) !== laborAmount) throw new Error('Estimate labor total does not match verified repair resolution');
  if (money(est.partsCost) !== partsTotal) throw new Error('Estimate parts total does not match verified repair resolution');

  return { laborLines, partsLines, laborTotal: laborAmount, partsTotal };
}

function buildInvoice({ estimate, customerInfo, vehicleInfo, laborRate, notes }) {
  const now = new Date();
  const est = estimate || {};
  const canonical = est.stage === 'ESTIMATED' && !!est.fingerprint;
  let laborLines;
  let partsLines;
  let laborTotal;
  let partsTotal;
  let hours;
  let rate;

  if (canonical) {
    const lines = buildCanonicalLines(est);
    laborLines = lines.laborLines;
    partsLines = lines.partsLines;
    laborTotal = lines.laborTotal;
    partsTotal = lines.partsTotal;
    hours = Number(est.repairResolution.labor.hours);
    rate = money(est.repairResolution.labor.hourlyRate);
  } else {
    const repairStrings = Array.isArray(est.repairs) ? est.repairs : [];
    hours = Number(est.estimatedHours) || 1;
    rate = Number(laborRate) || 65;
    laborTotal = Number(est.laborCost) || (hours * rate);
    partsTotal = Number(est.partsCost) || 0;

    laborLines = repairStrings.length
      ? repairStrings.map((desc, i) => ({
          lineNumber: i + 1,
          type: 'LABOR',
          description: desc,
          hours: parseFloat((hours / repairStrings.length).toFixed(2)),
          rate,
          amount: parseFloat((laborTotal / repairStrings.length).toFixed(2))
        }))
      : [{
          lineNumber: 1,
          type: 'LABOR',
          description: est.diagnosis || 'Diagnostic labor',
          hours,
          rate,
          amount: parseFloat(laborTotal.toFixed(2))
        }];

    partsLines = partsTotal > 0 ? [{
      lineNumber: laborLines.length + 1,
      type: 'PARTS',
      description: 'Parts (see estimate for details)',
      quantity: 1,
      unitPrice: parseFloat(partsTotal.toFixed(2)),
      amount: parseFloat(partsTotal.toFixed(2))
    }] : [];
  }

  const subtotal = money(laborTotal + partsTotal);
  const taxRate = 0.075;
  const taxAmount = money(partsTotal * taxRate);
  const total = money(subtotal + taxAmount);

  return {
    invoiceNumber: canonical ? est.estimateNumber : `SKSK-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${Math.floor(Math.random() * 9000) + 1000}`,
    status: 'ESTIMATE',
    createdAt: now.toISOString(),
    dueDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    estimateFingerprint: canonical ? est.fingerprint : null,
    repairResolutionFingerprint: canonical ? est.repairResolutionFingerprint : null,
    customer: {
      name: customerInfo?.name || 'Customer',
      phone: customerInfo?.phone || '',
      email: customerInfo?.email || ''
    },
    vehicle: {
      year: vehicleInfo?.year || '',
      make: vehicleInfo?.make || '',
      model: vehicleInfo?.model || '',
      trim: vehicleInfo?.trim || '',
      vin: vehicleInfo?.vin || ''
    },
    diagnosis: {
      primary: est.diagnosis || '',
      priority: (est.priority || 'medium').toUpperCase()
    },
    lineItems: [...laborLines, ...partsLines],
    totals: {
      laborTotal: money(laborTotal),
      partsTotal: money(partsTotal),
      subtotal,
      taxRate,
      taxAmount,
      total,
      laborHours: hours
    },
    notes: {
      knownIssues: est.knownIssues || [],
      proTips: est.proTips || [],
      extra: notes || ''
    },
    repairProcedure: est.repairSteps || [],
    footer: 'This is an estimate. Final charges may vary based on parts availability and additional findings during repair. Authorization required before work begins.'
  };
}

router.post('/build', (req, res) => {
  try {
    const invoiceData = buildInvoice(req.body || {});
    return res.json(invoiceData);
  } catch (error) {
    return res.status(409).json({ success: false, error: 'Canonical estimate is invalid for invoice generation.' });
  }
});

module.exports = router;
module.exports.buildInvoice = buildInvoice;
