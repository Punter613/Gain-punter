'use strict';

const API_BASE = String(process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const RUNS = Math.max(1, Number(process.env.RUNS || 10));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.REQUEST_TIMEOUT_MS || 90000));

const fixture = {
  vin: process.env.BENCH_VIN || 'KNDJC736385765089',
  vehicle: {
    year: 2008,
    make: 'Kia',
    model: 'Sorento',
    trim: 'BL 3.8L V6'
  },
  mileage: 150000,
  codes: ['P0300', 'P0171'],
  symptoms: [
    'Vehicle exhibits a repetitive bump when the accelerator pedal is released.',
    'A clunking noise occurs when the steering wheel is turned to full lock.'
  ],
  notes: [
    'CV axles replaced.',
    'Lower ball joints replaced.',
    'Upper control arms and ball joints replaced.'
  ],
  laborRate: 65,
  partsCost: 80
};

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

async function post(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = nowMs();
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-SKSK-Benchmark': 'full-estimate-10'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { error: text || `HTTP ${res.status}` }; }
    const elapsedMs = nowMs() - started;
    if (!res.ok) {
      const err = new Error(data.error || data.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      err.elapsedMs = elapsedMs;
      throw err;
    }
    return { data, elapsedMs, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function stats(values) {
  if (!values.length) return { min: null, max: null, avg: null, median: null, p95: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    median: pct(values, 50),
    p95: pct(values, 95)
  };
}

function round(value) {
  return value == null || Number.isNaN(Number(value)) ? null : Math.round(Number(value));
}

function compact(value, max = 54) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function runOne(index) {
  const runStarted = nowMs();

  const diagnose = await post('/api/diagnose', {
    vin: fixture.vin,
    vehicle: fixture.vehicle,
    mileage: fixture.mileage,
    symptoms: fixture.symptoms,
    codes: fixture.codes,
    notes: fixture.notes
  });

  const jobId = diagnose.data.jobId;
  const diagnosis = diagnose.data.result || {};
  if (!jobId) throw new Error(`Run ${index}: /api/diagnose did not return jobId`);

  const primaryCause = String(diagnosis.primaryCause || '').trim();
  if (!primaryCause) throw new Error(`Run ${index}: diagnosis did not return primaryCause`);

  const recommended = Array.isArray(diagnosis.recommendedTests) ? diagnosis.recommendedTests : [];
  const testName = String(recommended[0] || `Benchmark confirmation test for ${primaryCause}`);

  const test = await post(`/api/jobs/${encodeURIComponent(jobId)}/tests`, {
    name: testName,
    result: `BENCHMARK ONLY — synthetic out-of-spec confirmation for latency test: ${primaryCause}`,
    passed: false,
    notes: 'Synthetic benchmark record. Never use as a confirmed repair outcome or training truth.'
  });

  const verify = await post(`/api/jobs/${encodeURIComponent(jobId)}/verify`, {
    confirmed: true,
    confirmedCause: primaryCause,
    conclusion: 'BENCHMARK ONLY — synthetic verification used to exercise the full estimate lifecycle.',
    notes: 'Do not treat this benchmark job as a real repair outcome.'
  });

  if (!verify.data.verifiedCase?.fingerprint) {
    throw new Error(`Run ${index}: verify did not produce VERIFIED_CASE fingerprint`);
  }

  const estimate = await post('/api/estimateHeuristic', {
    jobId,
    laborRate: fixture.laborRate,
    partsCost: fixture.partsCost
  });

  const est = estimate.data.estimate || {};
  const ai = est.aiTrace || {};
  const totalMs = nowMs() - runStarted;

  return {
    run: index,
    jobId,
    diagnosis: primaryCause,
    estimateDiagnosis: est.diagnosis || '',
    estimateTotal: Number(est.total ?? 0),
    totalMs,
    diagnoseMs: diagnose.elapsedMs,
    testMs: test.elapsedMs,
    verifyMs: verify.elapsedMs,
    estimateHttpMs: estimate.elapsedMs,
    estimateRouteMs: Number(ai.totalRouteLatencyMs ?? NaN),
    estimateAiWallMs: Number(ai.routeAiLatencyMs ?? NaN),
    providerLatencyMs: Number(ai.providerLatencyMs ?? NaN),
    provider: ai.provider || '',
    model: ai.model || '',
    fallbackReason: ai.fallbackReason || '',
    success: true
  };
}

function printTable(rows) {
  const table = rows.map(r => ({
    Run: r.run,
    'Total ms': round(r.totalMs),
    'Diagnose ms': round(r.diagnoseMs),
    'Test ms': round(r.testMs),
    'Verify ms': round(r.verifyMs),
    'Estimate HTTP ms': round(r.estimateHttpMs),
    'Estimate route ms': round(r.estimateRouteMs),
    'Estimate AI ms': round(r.estimateAiWallMs),
    'Provider ms': round(r.providerLatencyMs),
    'Unacct AI ms': Number.isFinite(r.estimateAiWallMs) && Number.isFinite(r.providerLatencyMs)
      ? round(r.estimateAiWallMs - r.providerLatencyMs)
      : null,
    Provider: r.provider || '-',
    Total: `$${Number(r.estimateTotal || 0).toFixed(2)}`,
    Diagnosis: compact(r.diagnosis)
  }));
  console.table(table);
}

function printMetric(name, values) {
  const s = stats(values.filter(Number.isFinite));
  console.log(`${name.padEnd(20)} min=${round(s.min)} avg=${round(s.avg)} median=${round(s.median)} p95=${round(s.p95)} max=${round(s.max)} ms`);
}

async function main() {
  console.log('SKSK full estimate benchmark');
  console.log(`Target: ${API_BASE}`);
  console.log(`Runs: ${RUNS} sequential, fresh job per run`);
  console.log('Path: DIAGNOSE -> TEST -> VERIFY -> ESTIMATE');
  console.log('NOTE: /api/full-estimate is retired (410); this exercises the supported full estimate lifecycle.');
  console.log('NOTE: benchmark jobs are synthetic and intentionally stop before repair outcome / trusted learning.\n');

  const rows = [];
  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`Run ${i}/${RUNS} ... `);
    try {
      const row = await runOne(i);
      rows.push(row);
      console.log(`OK ${round(row.totalMs)} ms — ${compact(row.diagnosis, 70)} — $${row.estimateTotal.toFixed(2)}`);
    } catch (err) {
      console.log(`FAILED ${round(err.elapsedMs)} ms — ${err.message}`);
      rows.push({ run: i, success: false, error: err.message });
    }
  }

  const good = rows.filter(r => r.success);
  console.log('\nPer-run results');
  printTable(good);

  console.log('\nLatency summary');
  printMetric('Full lifecycle', good.map(r => r.totalMs));
  printMetric('Diagnose HTTP', good.map(r => r.diagnoseMs));
  printMetric('Estimate HTTP', good.map(r => r.estimateHttpMs));
  printMetric('Estimate route', good.map(r => r.estimateRouteMs));
  printMetric('Estimate AI wall', good.map(r => r.estimateAiWallMs));
  printMetric('Provider wall', good.map(r => r.providerLatencyMs));

  const over3 = good.filter(r => r.totalMs > 3000).length;
  const over5 = good.filter(r => r.totalMs > 5000).length;
  const over10 = good.filter(r => r.totalMs > 10000).length;
  console.log(`\nFull-lifecycle outliers: >3s=${over3}, >5s=${over5}, >10s=${over10}`);

  const diagnoses = new Map();
  for (const r of good) diagnoses.set(r.diagnosis, (diagnoses.get(r.diagnosis) || 0) + 1);
  const totals = [...new Set(good.map(r => Number(r.estimateTotal || 0).toFixed(2)))];
  console.log('\nOutput consistency');
  console.log('Diagnosis frequency:', Object.fromEntries(diagnoses));
  console.log('Distinct estimate totals:', totals);

  console.log('\nJSON_RESULTS');
  console.log(JSON.stringify({ target: API_BASE, runsRequested: RUNS, runsSucceeded: good.length, rows }, null, 2));

  if (good.length !== RUNS) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
