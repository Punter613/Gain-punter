const {
  QuickAskRetriever,
  QUICK_ASK_SCAN_BOUNDS,
  tokens
} = require('./quick.ask.retriever');
const {
  SOURCE_STATUS,
  isOptionalExternalSourceEnabled,
  sourceHealthEntry,
  summarizeSourceHealth,
  sourceStatusMessage,
  publicSourceHealth
} = require('../evidence/source.resilience');

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sourceBudgets(overrides = {}) {
  return {
    confirmedRepairsMs: positiveNumber(
      overrides.confirmedRepairsMs ?? process.env.QUICK_ASK_CONFIRMED_REPAIRS_TIMEOUT_MS,
      5000
    ),
    tsbsMs: positiveNumber(
      overrides.tsbsMs ?? process.env.QUICK_ASK_TSB_TIMEOUT_MS,
      5000
    ),
    manualMs: positiveNumber(
      overrides.manualMs ?? process.env.QUICK_ASK_MANUAL_TIMEOUT_MS,
      32000
    )
  };
}

function timeoutTelemetry(source, bounds, vehicleFilterStage, elapsedMs) {
  return {
    source,
    pageSize: bounds.pageSize,
    maxScan: bounds.maxScan,
    rowsScanned: 0,
    scanLimitReached: false,
    resultsMayBePartial: true,
    vehicleFilterStage,
    timedOut: true,
    elapsedMs
  };
}

function withTiming(telemetry = {}, elapsedMs, timedOut = false) {
  return {
    ...telemetry,
    elapsedMs,
    timedOut: !!timedOut,
    resultsMayBePartial: !!telemetry.resultsMayBePartial || !!timedOut
  };
}

async function settleWithin(label, work, budgetMs, fallbackFactory) {
  const startedAt = Date.now();
  let timer;
  let settled = false;

  const guardedWork = Promise.resolve()
    .then(work)
    .then(value => {
      settled = true;
      return { value, timedOut: false, elapsedMs: Date.now() - startedAt };
    })
    .catch(error => {
      settled = true;
      return { error, timedOut: false, elapsedMs: Date.now() - startedAt };
    });

  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      if (settled) return;
      const elapsedMs = Date.now() - startedAt;
      console.warn(`[Quick Ask] ${label} exceeded ${budgetMs}ms source budget; returning partial evidence`);
      resolve({
        value: fallbackFactory(elapsedMs),
        timedOut: true,
        elapsedMs
      });
    }, budgetMs);
  });

  const result = await Promise.race([guardedWork, timeout]);
  clearTimeout(timer);
  return result;
}

class BoundedQuickAskRetriever extends QuickAskRetriever {
  constructor(client, manualProvider, budgetOverrides = {}) {
    super(client, manualProvider);
    this.sourceBudgets = sourceBudgets(budgetOverrides);
  }

  async ask({ vehicle = {}, query = '', limit = 5 } = {}) {
    const capped = Math.min(10, Math.max(1, Number(limit) || 5));
    const make = String(vehicle.make || '').trim();
    const model = String(vehicle.model || '').trim();
    if (!make || !model) throw new Error('Quick Ask requires vehicle.make and vehicle.model');

    const queryText = String(query || '').trim();
    const startedAt = Date.now();
    const repairBounds = QUICK_ASK_SCAN_BOUNDS.confirmedRepairs;
    const tsbBounds = QUICK_ASK_SCAN_BOUNDS.tsbs;
    const manualEnabled = isOptionalExternalSourceEnabled('LEMON_MANUALS');

    const [repairsResult, manualResult, tsbResult] = await Promise.all([
      settleWithin(
        'confirmed repair history',
        () => this._confirmedRepairs(vehicle, queryText, capped),
        this.sourceBudgets.confirmedRepairsMs,
        elapsedMs => ({
          sampleSize: 0,
          ranked: [],
          telemetry: timeoutTelemetry('feedback_examples', repairBounds, 'database-json', elapsedMs)
        })
      ),
      manualEnabled
        ? settleWithin(
          'Repair & Diagnosis manual retrieval',
          () => this._manualEvidence(vehicle, queryText, capped),
          this.sourceBudgets.manualMs,
          elapsedMs => ({
            references: [],
            source: null,
            fromCache: false,
            error: `Repair & Diagnosis lookup exceeded ${this.sourceBudgets.manualMs}ms source budget`,
            timedOut: true,
            elapsedMs
          })
        )
        : Promise.resolve({
          value: { references: [], source: 'LEMON_MANUALS', fromCache: false, error: null, skipped: true },
          timedOut: false,
          elapsedMs: 0
        }),
      settleWithin(
        'published TSB retrieval',
        () => this._tsbs(vehicle, queryText, capped),
        this.sourceBudgets.tsbsMs,
        elapsedMs => ({
          ranked: [],
          telemetry: timeoutTelemetry('vehicle_tsb_corpus', tsbBounds, 'database', elapsedMs)
        })
      )
    ]);

    if (repairsResult.error) throw repairsResult.error;
    if (manualResult.error) {
      manualResult.value = {
        references: [],
        source: 'LEMON_MANUALS',
        fromCache: false,
        error: manualResult.error.message
      };
    }
    if (tsbResult.error) throw tsbResult.error;

    const repairs = repairsResult.value;
    const manual = manualResult.value;
    const tsbs = tsbResult.value;

    repairs.telemetry = withTiming(repairs.telemetry, repairsResult.elapsedMs, repairsResult.timedOut);
    tsbs.telemetry = withTiming(tsbs.telemetry, tsbResult.elapsedMs, tsbResult.timedOut);

    const manualTelemetry = {
      source: manual.source || 'REPAIR_DIAGNOSIS',
      elapsedMs: manualResult.elapsedMs,
      timedOut: !!manualResult.timedOut || !!manual.timedOut,
      skipped: manual.skipped === true,
      fromCache: !!manual.fromCache,
      resultsMayBePartial: !!manualResult.timedOut || !!manual.timedOut || !!manual.error
    };

    const sourceHealth = summarizeSourceHealth([
      sourceHealthEntry(
        'LEMON_MANUALS',
        !manualEnabled || manual.skipped === true
          ? SOURCE_STATUS.SKIPPED
          : manual.error || manualTelemetry.timedOut
            ? SOURCE_STATUS.UNAVAILABLE
            : SOURCE_STATUS.AVAILABLE,
        { evidenceCount: (manual.references || []).length, fromCache: !!manual.fromCache, reason: manual.error || '' }
      ),
      sourceHealthEntry(
        'PUBLISHED_TSB_CORPUS',
        tsbs.telemetry.timedOut ? SOURCE_STATUS.DEGRADED : SOURCE_STATUS.AVAILABLE,
        { evidenceCount: (tsbs.ranked || []).length }
      ),
      sourceHealthEntry(
        'CONFIRMED_REPAIRS',
        repairs.telemetry.timedOut ? SOURCE_STATUS.DEGRADED : SOURCE_STATUS.AVAILABLE,
        { evidenceCount: (repairs.ranked || []).length }
      )
    ]);

    const warnings = [
      'Repair & Diagnosis references are source material, not confirmation of a fault.',
      'Observed repair share is not diagnostic probability.',
      'Published TSB frequency is not repair probability.',
      'Quick Ask does not verify a fault or unlock repair authorization.'
    ];

    if (tsbs.telemetry.scanLimitReached) {
      warnings.unshift(`Published TSB retrieval reached its ${tsbs.telemetry.maxScan}-row vehicle-scoped scan bound; results may be partial.`);
    }
    if (repairs.telemetry.scanLimitReached) {
      warnings.unshift(`Confirmed-repair retrieval reached its ${repairs.telemetry.maxScan}-row vehicle-scoped scan bound; observed repair shares may be partial.`);
    }
    if (repairs.telemetry.timedOut) {
      warnings.unshift(`Confirmed-repair history exceeded its ${this.sourceBudgets.confirmedRepairsMs}ms retrieval budget; those results are temporarily omitted.`);
    }
    if (tsbs.telemetry.timedOut) {
      warnings.unshift(`Published TSB retrieval exceeded its ${this.sourceBudgets.tsbsMs}ms retrieval budget; those results are temporarily omitted.`);
    }
    if (!manualEnabled || manual.skipped === true) {
      warnings.unshift('Optional Repair & Diagnosis manual provider is disabled. Continuing with stored published evidence and confirmed-repair history.');
    } else if (manual.error) {
      warnings.unshift(`Optional Repair & Diagnosis lookup unavailable: ${manual.error}. Continuing with other evidence sources.`);
    }
    if (!tokens(queryText).length) {
      warnings.unshift('No question or symptom text was provided; published and manual evidence are not ranked without a query.');
    }

    const totalMs = Date.now() - startedAt;
    console.log(
      `[Quick Ask] retrieval completed in ${totalMs}ms ` +
      `(repairs=${repairsResult.elapsedMs}ms${repairsResult.timedOut ? '/timeout' : ''}, ` +
      `manual=${manualResult.elapsedMs}ms${manualResult.timedOut ? '/timeout' : manual.skipped ? '/skipped' : ''}, ` +
      `tsbs=${tsbResult.elapsedMs}ms${tsbResult.timedOut ? '/timeout' : ''})`
    );

    return {
      status: 'SUCCESS',
      mode: 'RETRIEVAL_ONLY',
      queryMode: tokens(queryText).length ? 'QUERY' : 'VEHICLE_ONLY',
      vehicle: {
        year: vehicle.year || null,
        make,
        model,
        engine: String(vehicle.engine || '').trim() || null
      },
      query: queryText,
      repairDiagnosisEvidence: manual.references,
      repairDiagnosisSource: manual.source,
      repairDiagnosisFromCache: manual.fromCache,
      commonConfirmedRepairs: repairs.ranked,
      confirmedRepairSampleSize: repairs.sampleSize,
      publishedEvidence: tsbs.ranked,
      sourceHealth: publicSourceHealth(sourceHealth),
      sourceStatusMessage: sourceStatusMessage(sourceHealth),
      retrievalTelemetry: {
        totalMs,
        budgets: { ...this.sourceBudgets },
        manual: manualTelemetry,
        tsbs: tsbs.telemetry,
        confirmedRepairs: repairs.telemetry
      },
      warnings
    };
  }
}

module.exports = {
  BoundedQuickAskRetriever,
  settleWithin,
  sourceBudgets,
  timeoutTelemetry
};