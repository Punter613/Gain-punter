const { getCachedManual, getCachedManualVehicleEvidence, getCachedManualPathHint, saveScrapedManual, buildManualCacheKey } = require('../db');
const { buildCanonicalSearchTerms } = require('../core/automotive.normalization');
const { runTargetedEvidenceWorker } = require('./lemon.worker');
const { rerankStoredManualEvidence } = require('./manual.evidence.reuse');
const {
  scorePage: scoreTargetedPage
} = require('../../scripts/scrape-lemon-targeted-evidence');

const inFlightScrapes = new Map();

function clean(value) {
  return String(value || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function pageToManualItem(page = {}) {
  const source = page.sourceEvidence || {};
  const index = page.derivedIndex || {};
  return {
    title: source.title || 'Repair & Diagnosis reference',
    url: source.sourceUrl || '',
    price: null,
    meta: {
      scraper: 'targeted-evidence-v2',
      sectionType: index.sectionType || 'OTHER',
      relevanceScore: String(Number(index.relevanceScore || 0)),
      semanticScore: String(Number(index.semanticScore || 0)),
      scopeScore: String(Number(index.scopeScore || 0)),
      matchedKeywords: (index.matchedTerms || []).join(', '),
      headings: (source.headings || []).slice(0, 20).join(' | '),
      snippet: String(source.bodyText || '').slice(0, 2500),
      facts: JSON.stringify({
        dtcs: index.dtcs || [],
        sounds: index.sounds || [],
        conditions: index.conditions || [],
        systems: index.systems || [],
        canonicalTerms: index.canonicalTerms || [],
        sourceVariantCount: Number(index.sourceVariantCount || 1)
      }),
      contentHash: source.contentHash || '',
      alternateSourceUrls: (source.alternateSourceUrls || []).join(' | ')
    }
  };
}

function targetedToManual(output = {}) {
  return {
    schemaVersion: 5,
    source: output.source || 'LEMON_MANUALS',
    vehicle: output.vehicle || {},
    query: output.query || {},
    items: (output.pages || []).map(pageToManualItem),
    crawled_urls: Number(output.crawledPages || 0),
    relevant_pages: Number(output.selectedPages || 0),
    resolved_url: output.resolvedUrl || '',
    path_resolution: output.pathResolution || '',
    applicability: output.applicability || null,
    retrieval: {
      elapsedMs: Number(output.elapsedMs || 0),
      timeBudgetExceeded: !!output.timeBudgetExceeded,
      crawlTruncated: !!output.crawlTruncated
    },
    scraped: true,
    scraped_at: output.scrapedAt || new Date().toISOString()
  };
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function scrapeLEMONManuals(vehicle, context = {}, options = {}) {
  if (!vehicle || !vehicle.make || !vehicle.year || !vehicle.model) {
    return { items: [], error: 'Insufficient vehicle data for scraping' };
  }

  const cacheKey = buildManualCacheKey(vehicle, context);
  const existing = inFlightScrapes.get(cacheKey);
  if (existing) {
    console.log(`[Scraper] Context scrape JOIN for ${cacheKey}`);
    return existing;
  }

  const task = (async () => {
    const cached = await getCachedManual(vehicle, context);
    if (cached && cached.data) {
      console.log(`[Scraper] Context cache HIT for ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
      return { ...cached.data, fromCache: true, cacheMode: 'exact-context', cachedAt: cached.scraped_at };
    }

    let storedRows = [];
    try {
      if (typeof getCachedManualVehicleEvidence === 'function') {
        storedRows = await getCachedManualVehicleEvidence(vehicle, {
          limit: positiveNumber(options.storedContextLimit ?? process.env.LEMON_STORED_CONTEXT_LIMIT, 8)
        });
      }
      const storedReuse = rerankStoredManualEvidence(
        storedRows,
        vehicle,
        context,
        context.scope || 'diagnosis',
        { maxItems: positiveNumber(options.storedReuseMaxItems ?? process.env.LEMON_STORED_REUSE_MAX_ITEMS, 12) }
      );
      if (storedReuse) {
        console.log(
          `[Scraper] Cross-context cache HIT for ${vehicle.year} ${vehicle.make} ${vehicle.model} ` +
          `(${storedReuse.retrieval?.reusedContextCount || 0}/${storedReuse.retrieval?.storedContextCount || storedRows.length} stored contexts, ` +
          `${storedReuse.items.length} re-ranked page(s))`
        );
        return storedReuse;
      }
      if (storedRows.length) {
        console.log(
          `[Scraper] Cross-context cache MISS for ${vehicle.year} ${vehicle.make} ${vehicle.model}; ` +
          `${storedRows.length} stored context(s) lacked strong current-context evidence`
        );
      }
    } catch (error) {
      console.warn(`[Scraper] Cross-context cache reuse skipped for ${cacheKey}: ${error.message}`);
    }

    const manualPathHint = typeof getCachedManualPathHint === 'function'
      ? await getCachedManualPathHint(vehicle, context)
      : '';
    if (manualPathHint) {
      console.log(`[Scraper] Reusing cached manual path hint for ${cacheKey}`);
    }

    console.log(`[Scraper] Context cache MISS for ${vehicle.year} ${vehicle.make} ${vehicle.model} - isolated targeted Repair & Diagnosis scrape`);
    try {
      const targetedRunner = typeof options.targetedRunner === 'function'
        ? options.targetedRunner
        : runTargetedEvidenceWorker;
      const targeted = await targetedRunner(
        manualPathHint ? { ...vehicle, manualPathHint } : vehicle,
        {
          ...context,
          query: context.query || '',
          symptoms: context.symptoms || context.query || ''
        },
        context.scope || 'diagnosis',
        {
          maxPages: positiveNumber(options.maxPages ?? process.env.LEMON_LIVE_MAX_PAGES, 80),
          maxDepth: positiveNumber(options.maxDepth ?? process.env.LEMON_LIVE_MAX_DEPTH, 4),
          fetchTimeoutMs: positiveNumber(options.fetchTimeoutMs ?? process.env.LEMON_LIVE_FETCH_TIMEOUT_MS, 6000),
          maxElapsedMs: positiveNumber(options.maxElapsedMs ?? process.env.LEMON_LIVE_MAX_ELAPSED_MS, 20000),
          hardTimeoutMs: positiveNumber(options.hardTimeoutMs ?? process.env.LEMON_WORKER_HARD_TIMEOUT_MS, 30000),
          allowUnknownDrivetrain: true
        }
      );
      const freshResult = targetedToManual(targeted);
      console.log(
        `[Scraper] Targeted retrieval ${cacheKey} completed in ${Number(targeted.elapsedMs || 0)}ms ` +
        `(${Number(targeted.crawledPages || 0)} crawled / ${Number(targeted.selectedPages || 0)} selected)`
      );
      if (freshResult.items.length > 0) await saveScrapedManual(vehicle, freshResult, context);
      return { ...freshResult, fromCache: false, cacheMode: 'live-targeted' };
    } catch (error) {
      console.warn(`[Scraper] Targeted retrieval ${cacheKey} failed fast: ${error.message}`);
      return { items: [], source: null, error: error.message, fromCache: false };
    }
  })();

  inFlightScrapes.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (inFlightScrapes.get(cacheKey) === task) inFlightScrapes.delete(cacheKey);
  }
}

// Compatibility exports retained for callers/tests that used the old live scraper helpers.
function buildSearchTerms(vehicle, context = {}) {
  return buildCanonicalSearchTerms(vehicle, context).terms;
}

function scorePage(page, terms, context = {}) {
  const { profile } = buildCanonicalSearchTerms({}, context);
  return scoreTargetedPage(page, terms || [], context.scope || 'diagnosis', profile);
}

function extractFacts(page = {}) {
  const text = clean(page.bodyText || '');
  const facts = {
    componentType: [], torqueSpecs: [], procedures: [], inspections: [], specialTools: [],
    alignment: [], bulletins: [], construction: [], specifications: []
  };
  const sentences = text.split(/(?<=[.!?])\s+/).map(clean).filter(Boolean);
  const collect = (key, patterns, max = 10) => {
    for (const sentence of sentences) {
      const normalized = sentence.toLowerCase();
      if (patterns.some(pattern => pattern.test(normalized)) && !facts[key].includes(sentence)) {
        facts[key].push(sentence.slice(0, 1000));
        if (facts[key].length >= max) break;
      }
    }
  };
  collect('torqueSpecs', [/\btorque\b/, /ft[. ]?lb/, /n[· ]?m\b/, /tighten/]);
  collect('procedures', [/remove/, /install/, /replacement/, /procedure/]);
  collect('inspections', [/inspect/, /inspection/, /check for wear/, /check for damage/, /free play/, /clearance/]);
  collect('specialTools', [/special tool/, /special service tool/, /\bsst\b/]);
  collect('alignment', [/alignment/, /wheel align/]);
  collect('bulletins', [/\btsb\b/, /technical service bulletin/, /service bulletin/]);
  collect('construction', [/bolt[- ]?in/, /press[- ]?in/, /integral/, /assembled with/, /riveted/]);
  collect('componentType', [/ball joint/, /control arm/, /bushing/, /stabilizer link/, /cv axle/, /constant velocity/, /driveshaft/, /steering rack/, /air conditioning/, /hvac/, /compressor/, /clutch/]);
  collect('specifications', [/specification/, /specifications/, /maximum/, /minimum/, /limit/, /clearance/]);
  return facts;
}

module.exports = {
  scrapeLEMONManuals,
  buildSearchTerms,
  scorePage,
  extractFacts,
  pageToManualItem,
  targetedToManual
};