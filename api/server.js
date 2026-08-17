require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

// 1. GLOBAL ACCESS CONTROL & SECURITY HEADERS
// Allow known SKSK browser clients while keeping environment-driven expansion easy.
// CORS_ORIGINS accepts a comma-separated list. CORS_ORIGIN remains supported for
// backward compatibility with the existing Render configuration.
const defaultAllowedOrigins = [
  'https://skskprotech.pages.dev',
  'https://p613-backend.onrender.com',
  'http://localhost:3000',
  process.env.RENDER_EXTERNAL_URL
].filter(Boolean);

const configuredOrigins = [
  ...(process.env.CORS_ORIGINS || '').split(','),
  ...(process.env.CORS_ORIGIN || '').split(',')
].map(origin => origin.trim()).filter(Boolean);

const allowedOrigins = new Set([...defaultAllowedOrigins, ...configuredOrigins]);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    const isCloudflareClient = url.protocol === 'https:' &&
      (url.hostname === 'skskprotech.pages.dev' || url.hostname.endsWith('.skskprotech.pages.dev'));
    const isSkskRenderPreview = url.protocol === 'https:' &&
      /^p613-backend-pr-\d+\.onrender\.com$/i.test(url.hostname);
    return isCloudflareClient || isSkskRenderPreview;
  } catch {
    return false;
  }
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// 2. 🚨 STRIPE WEBHOOK CONTROLLER CORE (MOUNTED FIRST FOR RAW PAYLOAD RETENTION)
try {
  const webhookRouter = require('../src/routes/webhooks');
  app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookRouter);
} catch (err) {
  console.warn('[Server Warn] Webhook path resolution deferred:', err.message);
}

// 3. APPLICATION INBOUND DATA BODY PARSERS
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// 4. ROUTE INFRASTRUCTURE LANES
const diagnose = require('../src/routes/diagnose');
const estimateHeuristic = require('../src/routes/estimate.authorized');
const invoice = require('../src/routes/invoice');
const oemRouter = require('../src/routes/oem');
const scrapeRouter = require('../src/routes/scrape');
const partsRouter = require('../src/routes/parts');
const fullEstimateRouter = require('../src/routes/full-estimate.protected');
const jobsRouter = require('../src/routes/jobs.protected');
const partsLookupRouter = require('../src/routes/partsLookup');
const fleetRouter = require('../src/routes/fleet');
const vehicleRouter = require('../src/routes/vehicle');
const quickAskRouter = require('../src/routes/quick.ask');
const {
  diagnosisLifecycle,
  estimateLifecycle,
  invoiceLifecycle
} = require('../src/middleware/job.lifecycle.middleware');

app.use('/api/scrape', scrapeRouter);
app.use('/api/parts', partsRouter);
app.use('/api/full-estimate', fullEstimateRouter);
app.use('/api/jobs', jobsRouter);

app.use('/api/diagnose', diagnosisLifecycle, diagnose);
app.use('/api/estimateHeuristic', estimateLifecycle, estimateHeuristic);
app.use('/api/invoice', invoiceLifecycle, invoice);

app.use('/api/translate', require('../src/routes/translate'));
app.use('/api/parts-lookup', partsLookupRouter);
app.use('/api/fleet', fleetRouter);
app.use('/api/vehicle', vehicleRouter);
app.use('/api/quick-ask', quickAskRouter);
app.use(oemRouter);

// ─── SKSK MODULE REBUILD ADDITIONS (As Clean Side-by-Side Lanes) ───
app.use('/api/intelligence', require('../src/routes/intelligence.routes'));
app.use('/api/buyer', require('../src/routes/buyer'));

// STANDALONE STRIPE SUBSCRIPTION INFRASTRUCTURE
if (process.env.STRIPE_SECRET_KEY) {
  try {
    const payments = require('../src/routes/payments');
    app.use('/api/payments', payments);
    console.log('[Payments] Stripe standard checking endpoints loaded');
  } catch (err) {
    console.warn('[Payments] Delayed standard payment loading:', err.message);
  }
} else {
  console.log('[Payments] STRIPE_SECRET_KEY not set - payments disabled');
  app.use('/api/payments', (req, res) => {
    res.status(503).json({ success: false, error: 'Payments not configured' });
  });
}

// 5. STATIC CORPORATE WEB PLATFORM ASSETS
app.get('/fleet', (req, res) => res.sendFile(path.join(__dirname, '../public/fleet.html')));
app.get('/lifecycle', (req, res) => res.sendFile(path.join(__dirname, '../public/lifecycle.html')));
app.use(express.static(path.join(__dirname, '../public')));

function evidenceRetrievalProfile() {
  return {
    vinWarmup: 'stored-only',
    vinDecodeTimeoutMs: Number(process.env.VIN_DECODE_TIMEOUT_MS || 5000),
    vinDecodeCacheTtlMs: Number(process.env.VIN_DECODE_CACHE_TTL_MS || 60 * 60 * 1000),
    manualPathResolutionBudgetMs: Number(process.env.LEMON_RESOLVER_MAX_ELAPSED_MS || 10000),
    liveManualCrawlBudgetMs: Number(process.env.LEMON_LIVE_MAX_ELAPSED_MS || 20000),
    manualWorkerHardTimeoutMs: Number(process.env.LEMON_WORKER_HARD_TIMEOUT_MS || 30000),
    quickAskSourceBudgetsMs: {
      confirmedRepairs: Number(process.env.QUICK_ASK_CONFIRMED_REPAIRS_TIMEOUT_MS || 5000),
      tsbs: Number(process.env.QUICK_ASK_TSB_TIMEOUT_MS || 5000),
      manual: Number(process.env.QUICK_ASK_MANUAL_TIMEOUT_MS || 32000)
    }
  };
}

// 6. HEALTH & SYSTEM MONITORING TELEMETRY
app.get('/health', async (req, res) => {
  const health = { ok: true, timestamp: new Date().toISOString() };
  try {
    const db = require('../src/db');
    health.db = db.supabase ? 'connected' : 'not configured';
  } catch {
    health.db = 'error';
  }
  health.stripe = process.env.STRIPE_SECRET_KEY ? 'configured' : 'not configured';
  health.groq = process.env.GROQ_API_KEY ? 'configured' : 'not configured';
  health.evidenceRetrieval = evidenceRetrievalProfile();
  if (process.env.IS_PULL_REQUEST === 'true') {
    health.preview = {
      commit: process.env.RENDER_GIT_COMMIT || null,
      branch: process.env.RENDER_GIT_BRANCH || null,
      service: process.env.RENDER_SERVICE_NAME || null
    };
  }
  res.json(health);
});

// Render PR previews get deeper read-only/runtime smoke lanes. Production never
// registers these endpoints because Render sets IS_PULL_REQUEST to the string "true"
// only for pull request preview services.
if (process.env.IS_PULL_REQUEST === 'true') {
  app.get('/health/preview-evidence', async (req, res) => {
    const startedAt = Date.now();
    const vin = String(req.query.vin || '5XXGT4L38LG384941').trim();
    const query = String(req.query.query || 'P1326 knock signal range performance flashing MIL reduced power').trim();
    const localBase = `http://127.0.0.1:${process.env.PORT || 3000}`;

    try {
      const decodeStartedAt = Date.now();
      const decodeResponse = await fetch(`${localBase}/api/vehicle/decode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin })
      });
      const decodeBody = await decodeResponse.json();
      const decodeMs = Date.now() - decodeStartedAt;

      if (!decodeResponse.ok || !decodeBody?.vehicle) {
        return res.status(502).json({
          ok: false,
          stage: 'vehicle-decode',
          statusCode: decodeResponse.status,
          decodeMs,
          response: decodeBody,
          totalMs: Date.now() - startedAt
        });
      }

      const quickAskStartedAt = Date.now();
      const quickAskResponse = await fetch(`${localBase}/api/quick-ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicle: decodeBody.vehicle, query, limit: 5 })
      });
      const quickAskBody = await quickAskResponse.json();
      const quickAskMs = Date.now() - quickAskStartedAt;
      const references = Array.isArray(quickAskBody?.repairDiagnosisEvidence)
        ? quickAskBody.repairDiagnosisEvidence
        : [];

      return res.status(quickAskResponse.ok ? 200 : 502).json({
        ok: quickAskResponse.ok,
        runtime: {
          commit: process.env.RENDER_GIT_COMMIT || null,
          branch: process.env.RENDER_GIT_BRANCH || null,
          service: process.env.RENDER_SERVICE_NAME || null,
          isPullRequest: process.env.IS_PULL_REQUEST,
          evidenceRetrieval: evidenceRetrievalProfile()
        },
        decode: {
          statusCode: decodeResponse.status,
          ms: decodeMs,
          vehicle: decodeBody.vehicle,
          evidenceWarmup: decodeBody.evidenceWarmup,
          evidenceKey: decodeBody.evidenceKey
        },
        quickAsk: {
          statusCode: quickAskResponse.status,
          ms: quickAskMs,
          status: quickAskBody?.status || null,
          mode: quickAskBody?.mode || null,
          repairDiagnosisSource: quickAskBody?.repairDiagnosisSource || null,
          repairDiagnosisFromCache: quickAskBody?.repairDiagnosisFromCache ?? null,
          repairDiagnosisReferenceCount: references.length,
          referenceTitles: references.slice(0, 5).map(item => item.title),
          retrievalTelemetry: quickAskBody?.retrievalTelemetry || null,
          warnings: quickAskBody?.warnings || [],
          error: quickAskBody?.error || null
        },
        totalMs: Date.now() - startedAt
      });
    } catch (error) {
      console.error('[Preview Evidence Smoke]', error.stack || error.message || error);
      return res.status(502).json({
        ok: false,
        stage: 'preview-evidence-smoke',
        error: error.message,
        totalMs: Date.now() - startedAt
      });
    }
  });

  app.get('/health/preview-unverified-diagnosis', async (req, res) => {
    const startedAt = Date.now();
    const localBase = `http://127.0.0.1:${process.env.PORT || 3000}`;
    const jobId = `SKSK-PREVIEW-UNVERIFIED-${String(process.env.RENDER_PULL_REQUEST_ID || 'PR')}`;

    try {
      const { createJob, recordDiagnosis, patchJob, getJob } = require('../src/services/job.lifecycle');
      await createJob({
        jobId,
        customer: { name: 'RUNTIME CANARY' },
        vehicle: { year: 2020, make: 'KIA', model: 'Optima', engine: '2.4L' },
        customerStates: ['Flashing check-engine light after driving through standing water'],
        mechanicNotices: ['Engine currently runs smoothly'],
        obdCodes: ['P1326']
      });
      await recordDiagnosis(jobId, {
        primaryCause: 'Knock sensor circuit signal fault requires confirmation',
        secondaryCauses: ['Engine bearing knock signal requires confirmation'],
        probability: [
          { cause: 'Knock sensor circuit signal fault', likelihood: 60 },
          { cause: 'Engine bearing knock signal', likelihood: 40 }
        ],
        recommendedTests: [
          'Inspect knock sensor circuit integrity and connector condition',
          'Perform the applicable manufacturer confirmation test for P1326'
        ],
        notes: 'Runtime canary diagnosis is intentionally unverified.',
        diagnosticConfidence: { percentage: 60, rating: 'MODERATE' },
        evidence: { oem: [], tsbs: [], available: false, sources: [] }
      });
      const seeded = await getJob(jobId);
      await patchJob(jobId, {
        diagnosis: {
          ...(seeded?.diagnosis || {}),
          evidencePacket: {
            schemaVersion: 1,
            vehicle: seeded?.vehicle || {},
            dtcs: ['P1326'],
            customerObservations: seeded?.intake?.customerStates || [],
            mechanicObservations: seeded?.intake?.mechanicNotices || [],
            oemReferences: [],
            tsbReferences: []
          }
        }
      });

      const fallbackStartedAt = Date.now();
      const fallbackResponse = await fetch(`${localBase}/api/jobs/${encodeURIComponent(jobId)}/unverified-diagnosis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const fallbackBody = await fallbackResponse.json();
      const fallbackMs = Date.now() - fallbackStartedAt;

      const estimateResponse = await fetch(`${localBase}/api/estimateHeuristic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          diagnosisVerified: true,
          verificationStatus: 'UNVERIFIED_DIAGNOSIS',
          verifiedFaults: [fallbackBody?.unverifiedDiagnosis?.mostLikelyCause].filter(Boolean)
        })
      });
      const estimateBody = await estimateResponse.json();

      const lifecycleResponse = await fetch(`${localBase}/lifecycle.html`);
      const lifecycleHtml = await lifecycleResponse.text();
      const persisted = await getJob(jobId);
      const uiHasFallback = lifecycleHtml.includes('Get an Unverified Diagnosis') &&
        lifecycleHtml.includes('This diagnosis has not been physically verified. It does not authorize a repair and does not unlock Estimate.');
      const boundaryHeld = fallbackResponse.status === 200 &&
        fallbackBody?.diagnosisState === 'UNVERIFIED_DIAGNOSIS' &&
        fallbackBody?.unverifiedDiagnosis?.physicallyVerified === false &&
        fallbackBody?.unverifiedDiagnosis?.repairAuthorized === false &&
        persisted?.status === 'TESTING' &&
        !persisted?.verifiedCase &&
        estimateResponse.status === 409 &&
        uiHasFallback;

      return res.status(boundaryHeld ? 200 : 502).json({
        ok: boundaryHeld,
        runtime: {
          commit: process.env.RENDER_GIT_COMMIT || null,
          branch: process.env.RENDER_GIT_BRANCH || null,
          service: process.env.RENDER_SERVICE_NAME || null,
          isPullRequest: process.env.IS_PULL_REQUEST
        },
        jobId,
        fallback: {
          statusCode: fallbackResponse.status,
          ms: fallbackMs,
          diagnosisState: fallbackBody?.diagnosisState || null,
          mostLikelyCause: fallbackBody?.unverifiedDiagnosis?.mostLikelyCause || null,
          physicallyVerified: fallbackBody?.unverifiedDiagnosis?.physicallyVerified ?? null,
          repairAuthorized: fallbackBody?.unverifiedDiagnosis?.repairAuthorized ?? null,
          estimateReady: fallbackBody?.estimateReady ?? null
        },
        persisted: {
          status: persisted?.status || null,
          hasVerifiedCase: !!persisted?.verifiedCase,
          unverifiedState: persisted?.unverifiedDiagnosis?.state || null
        },
        estimateBypassAttempt: {
          statusCode: estimateResponse.status,
          error: estimateBody?.error || null
        },
        ui: {
          statusCode: lifecycleResponse.status,
          hasFallback: uiHasFallback
        },
        totalMs: Date.now() - startedAt
      });
    } catch (error) {
      console.error('[Preview Unverified Diagnosis Smoke]', error.stack || error.message || error);
      return res.status(502).json({
        ok: false,
        stage: 'preview-unverified-diagnosis-smoke',
        error: error.message,
        totalMs: Date.now() - startedAt
      });
    }
  });
}

// 7. COMPREHENSIVE ERROR AND 404 SYSTEMS TERMINUS
app.use((req, res, next) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[Error Intercepted]', err.stack || err.message || err);
  const isDev = process.env.NODE_ENV === 'development';
  const message = isDev
    ? (err.message || 'Server error')
    : (err.statusCode ? err.message : 'Internal server error');

  res.status(err.statusCode || 500).json({
    success: false,
    error: message,
    ...(isDev && { stack: err.stack })
  });
});

// 8. LIFECYCLE BACKGROUND SERVICE INITIALIZATION
try {
  const { startKeepAwakeLoop } = require('../src/services/db_keepawake');
  startKeepAwakeLoop();
} catch (e) {
  console.warn('[Lifecycle Warn] Database awake engine bypass:', e.message);
}

try {
  require('../src/workers/aiWorker');
  console.log('🤖 Background AI Worker summoned to the shop floor. Listening for jobs...');
} catch (e) {
  console.warn('[Lifecycle Warn] AI Worker thread instantiation deferred:', e.message);
}

// 9. NETWORK PORT BIND LISTEN ENGINE
const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  const retrieval = evidenceRetrievalProfile();
  const quickAsk = retrieval.quickAskSourceBudgetsMs;
  console.log(`[Server] SKSK ProTech running inside API framework layer on port ${port}`);
  console.log(`[Server] Testing Target Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(
    `[Server] Evidence retrieval profile: VIN decode <=${retrieval.vinDecodeTimeoutMs}ms with cache; stored-only VIN warmup; ` +
    `manual path <=${retrieval.manualPathResolutionBudgetMs}ms; live crawl <=${retrieval.liveManualCrawlBudgetMs}ms; ` +
    `manual worker <=${retrieval.manualWorkerHardTimeoutMs}ms; ` +
    `Quick Ask source budgets repairs/TSB/manual=${quickAsk.confirmedRepairs}/${quickAsk.tsbs}/${quickAsk.manual}ms`
  );
  console.log(`[Server] Active Status Framework Endpoint: http://localhost:${port}/health`);
});

const gracefulShutdown = () => {
  console.log('[Server] Graceful shutdown triggered, draining connections...');
  server.close(() => {
    console.log('[Server] Process clean terminate complete.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);