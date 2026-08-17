const { parentPort, workerData } = require('worker_threads');
const { scrapeTargetedEvidence } = require('../../scripts/scrape-lemon-targeted-evidence');

async function run() {
  try {
    const result = await scrapeTargetedEvidence(
      workerData.vehicle,
      workerData.context,
      workerData.scope,
      {
        ...workerData.options,
        onFetchError: (url, error) => {
          parentPort.postMessage({
            type: 'fetch-error',
            url,
            error: error?.message || String(error)
          });
        }
      }
    );
    parentPort.postMessage({ type: 'result', result });
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      error: error?.message || String(error),
      stack: error?.stack || null
    });
  }
}

run();
