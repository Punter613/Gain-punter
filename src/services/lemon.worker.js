const path = require('path');
const { Worker } = require('worker_threads');

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runTargetedEvidenceWorker(vehicle, context, scope, options = {}) {
  const hardTimeoutMs = positiveNumber(
    options.hardTimeoutMs ?? process.env.LEMON_WORKER_HARD_TIMEOUT_MS,
    30000
  );
  const workerPath = path.join(__dirname, '../workers/lemonTargetedWorker.js');

  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: {
        vehicle,
        context,
        scope,
        options: {
          maxPages: options.maxPages,
          maxDepth: options.maxDepth,
          fetchTimeoutMs: options.fetchTimeoutMs,
          maxElapsedMs: options.maxElapsedMs,
          allowUnknownDrivetrain: options.allowUnknownDrivetrain
        }
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
  runTargetedEvidenceWorker
};
