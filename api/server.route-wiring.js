require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

const defaultAllowedOrigins = [
  'https://skskprotech.pages.dev',
  'https://p613-backend.onrender.com',
  'http://localhost:3000'
];

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
    return url.protocol === 'https:' &&
      (url.hostname === 'skskprotech.pages.dev' || url.hostname.endsWith('.skskprotech.pages.dev'));
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

try {
  const webhookRouter = require('../src/routes/webhooks');
  app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookRouter);
} catch (err) {
  console.warn('[Server Warn] Webhook path resolution deferred:', err.message);
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

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
app.use(oemRouter);
app.use('/api/internal/model-compare-result', require('../src/routes/model-compare-result'));
app.use('/api/intelligence', require('../src/routes/intelligence.routes'));
app.use('/api/buyer', require('../src/routes/buyer'));

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

app.get('/fleet', (req, res) => res.sendFile(path.join(__dirname, '../public/fleet.html')));
app.use(express.static(path.join(__dirname, '../public')));

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
  res.json(health);
});

app.use((req, res) => {
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

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`[Server] SKSK ProTech running inside guarded API framework layer on port ${port}`);
  console.log(`[Server] Testing Target Environment: ${process.env.NODE_ENV || 'development'}`);
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
