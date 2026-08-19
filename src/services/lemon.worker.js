const path = require('path');
const { Worker } = require('worker_threads');

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeSeedLinks(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(item => ({
      url: String(item?.url || '').trim(),
      text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      priority: Number(item?.priority || 0),
      matchedDtcs: Array.isArray(item?.matchedDtcs) ? item.matchedDtcs.map(String).slice(0, 12) : []
    }))
    .filter(item => /^https?:\/\//i.test(item.url))
    .slice(0, 24);
}

function safeWorkerOptions(options = {}) {
  return {
    maxPages: options.maxPages,
    maxDepth: options.maxDepth,
    fetchTimeoutMs: options.fetchTimeoutMs,
    maxElapsedMs: options.maxElapsedMs,
    corpusLimit: options.corpusLimit,
    corpusBodyChars: options.corpusBodyChars,
    navigationLimit: options.navigationLimit,
    seedLinks: safeSeedLinks(options.seedLinks),
    seedFetchTimeoutMs: options.seedFetchTimeoutMs,
    seedProbeBudgetMs: options.seedProbeBudgetMs,
    allowUnknownDrivetrain: options.allowUnknownDrivetrain === true
  };
}

function resolveHardTimeoutMs(options = {}) {
  const requested = positiveNumber(
    options.hardTimeoutMs ?? process.env.LEMON_WORKER_HARD_TIMEOUT_MS,
    30000
  );
  const elapsedBudget = Number(options.maxElapsedMs);
  if (!Number.isFinite(elapsedBudget) || elapsedBudget <= 0) return requested;

  // maxElapsedMs starts after manual-path resolution inside the worker. Keep the
  // crawl budget strict, but leave bounded resolver + worker startup/serialization
  // headroom before the parent terminates the thread. The normal 20s crawl / 30s
  // hard wall is unchanged because 20s + 7s remains below the existing 30s default.
  return Math.max(requested, elapsedBudget + 7000);
}

function runTargetedEvidenceWorker(vehicle, context, scope, options = {}) {
  const hardTimeoutMs = resolveHardTimeoutMs(options);
  const workerPath = path.join(__dirname, '../workers/lemonTargetedWorker.js');

  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: {
        vehicle,
        context,
        scope,
        options: safeWorkerOptions(options)
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      reject(new Error(`Targeted manual worker exceeded ${hardTimeoutMs}ms hard timeout`));
    }, hardTimeoutMs);

    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    worker.on('message', message => {
      if (message?.type === 'fetch-error') {
        console.warn(`[Scraper Worker] Manual fetch failed for ${message.url}: ${message.error}`);
        return;
      }
      if (message?.type === 'result') {
        finish(resolve)(message.result);
        return;
      }
      if (message?.type === 'error') {
        const error = new Error(message.error || 'Targeted manual worker failed');
        if (message.stack) error.stack = message.stack;
        finish(reject)(error);
      }
    });

    worker.on('error', finish(reject));
    worker.on('exit', code => {
      if (!settled && code !== 0) {
        finish(reject)(new Error(`Targeted manual worker exited with code ${code}`));
      }
    });
  });
}

module.exports = {
  runTargetedEvidenceWorker,
  safeSeedLinks,
  safeWorkerOptions,
  resolveHardTimeoutMs
};