'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInvoice } = require('../src/routes/invoice');

test('canonical invoice preserves verified rust-adjusted labor amount', () => {
  const operationId = 'VERIFY_OP_1_TEST';
  const estimate = {
    stage: 'ESTIMATED',
    fingerprint: 'estimate-fingerprint',
    estimateNumber: 'SKSK-RUST-1',
    repairResolutionFingerprint: 'repair-resolution-fingerprint',
    diagnosis: 'Verified fault: seized fastener repair',
    priority: 'medium',
    laborCost: 146.25,
    partsCost: 80,
    rustAdjustment: {
      applied: true,
      multiplier: 1.5,
      source: 'VERIFIED_CASE'
    },
    repairResolution: {
      stage: 'REPAIR_RESOLVED',
      fingerprint: 'repair-resolution-fingerprint',
      operations: [{ operationId, cause: 'Seized fastener repair', component: 'Fastener' }],
      labor: {
        operationId,
        hours: 1.5,
        hourlyRate: 65,
        hoursSource: 'MECHANIC_INPUT'
      },
      parts: [{
        operationId,
        partNumber: 'PART-1',
        description: 'Replacement hardware',
        quantity: 1,
        unitPrice: 80,
        total: 80,
        source: 'MECHANIC_INPUT'
      }]
    }
  };

  const invoice = buildInvoice({ estimate });
  assert.equal(invoice.totals.laborTotal, 146.25);
  assert.equal(invoice.lineItems[0].amount, 146.25);
  assert.equal(invoice.lineItems[0].adjustmentMultiplier, 1.5);
  assert.equal(invoice.lineItems[0].adjustmentSource, 'VERIFIED_CASE');
});

test('canonical invoice rejects invalid verified rust adjustment metadata', () => {
  const operationId = 'VERIFY_OP_1_TEST';
  const estimate = {
    stage: 'ESTIMATED',
    fingerprint: 'estimate-fingerprint',
    estimateNumber: 'SKSK-RUST-2',
    repairResolutionFingerprint: 'repair-resolution-fingerprint',
    diagnosis: 'Verified fault',
    laborCost: 97.5,
    partsCost: 0,
    rustAdjustment: { applied: true, multiplier: 0.5, source: 'VERIFIED_CASE' },
    repairResolution: {
      stage: 'REPAIR_RESOLVED',
      fingerprint: 'repair-resolution-fingerprint',
      operations: [{ operationId, cause: 'Verified fault', component: 'Component' }],
      labor: { operationId, hours: 1.5, hourlyRate: 65, hoursSource: 'MECHANIC_INPUT' },
      parts: []
    }
  };

  assert.throws(() => buildInvoice({ estimate }), /invalid verified labor adjustment/i);
});
