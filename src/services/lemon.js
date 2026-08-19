const { getCachedManual, getCachedManualVehicleEvidence, getCachedManualPathHint, saveScrapedManual, buildManualCacheKey } = require('../db');
const { buildCanonicalSearchTerms } = require('../core/automotive.normalization');
const { runTargetedEvidenceWorker } = require('./lemon.worker');
const { rerankStoredManualEvidence, buildCurrentSearchContext } = require('./manual.evidence.reuse');
const { buildStoredNavigationSeeds } = require('./manual.navigation.seeds');
const {
  scorePage: scoreTargetedPage
} = require('../../scripts/scrape-lemon-targeted-evidence');

const inFlightScrapes = new Map();
const DTC_PATTERN = /\b[PCBU][0-3][0-9A-F]{3}\b/i;

function clean(value) {
  return String(value || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function hasDtcContext(context = {}) {
  const text = [
    context.query,
    context.symptoms,
    ...(Array.isArray(context.obdCodes) ? context.obdCodes : [context.obdCodes]),
    ...(Array.isArray(context.keywords) ? context.keywords : [context.keywords])
  ].filter(Boolean).join(' ');
  return DTC_PATTERN.test(text);
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
  const corpusItems = (output.corpusPages || []).map(pageToManualItem);
  const navigationLinks = (Array.isArray(output.navigationLinks) ? output.navigationLinks : [])
    .map(link => ({
      url: clean(link?.url),
      text: clean(link?.text).slice(0, 240)
    }))
    .filter(link => link.url)
    .slice(0, 1000);
  return {
    schemaVersion: 5,
    source: output.source || 'LEMON_MANUALS',
    vehicle: output.vehicle || {},
    query: output.query || {},
    items: (output.pages || []).map(pageToManualItem),
    corpusItems,
    navigationLinks,
    crawled_urls: Number(output.crawledPages || 0),
    relevant_pages: Number(output.selectedPages || 0),
    corpus_pages: Number(output.corpusPageCount || corpusItems.length || 0),
    navigation_links: Number(output.navigationLinkCount || navigationLinks.length || 0),
    resolved_url: output.resolvedUrl || '',
    path_resolution: output.pathResolution || '',
    applicability: output.applicability || null,
    retrieval: {
      elapsedMs: Number(output.elapsedMs || 0),
      timeBudgetExceeded: !!output.timeBudgetExceeded,
      crawlTruncated: !!output.crawlTruncated,
      corpusPageCount: Number(output.corpusPageCount || corpusItems.length || 0),
      navigationLinkCount: Number(output.navigationLinkCount || navigationLinks.length || 0),
      seedLinkCount: Number(output.seedLinkCount || 0),
      navigationSeeded: !!output.seededNavigationUsed,
      seedEarlyStop: !!output.seedEarlyStop,
      seedMatchedDtcs: Array.isArray(output.seedMatchedDtcs) ? output.seedMatchedDtcs : []
    },
    scraped: true,
    scraped_at: output.scrapedAt || new Date().toISOString()
  };
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function workerVehicle(vehicle, manualPathHint) {
  return manualPathHint ? { ...vehicle, manualPathHint } : vehicle;
}

function workerContext(context = {}) {
  return {
    ...context,
    query: context.query || '',
    symptoms: context.symptoms || context.query || ''
  };
}

function storedRowFromManual(cacheKey, manual) {
  return {
    vehicle_key: `${cacheKey}|navigation-probe`,
    scraped_at: manual.scraped_at || new Date().toISOString(),
    data: manual
  };
}

function manualItemKey(item = {}) {
  const hash = clean(item.meta?.contentHash);
  if (hash) return `hash:${hash}`;
  return `url:${clean(item.url).toLowerCase()}|${clean(item.title).toLowerCase()}`;
}

function dedupeManualItems(items = []) {
  const best = new Map();
  for (const item of items) {
    const key = manualItemKey(item);
    const current = best.get(key);
    const score = Number(item?.meta?.relevanceScore || 0);
    const currentScore = Number(current?.meta?.relevanceScore || 0);
    if (!current || score > currentScore) best.set(key, item);
  }
  return [...best.values()];
}

function dedupeNavigationLinks(links = []) {
  const best = new Map();
  for (const link of links) {
    const url = clean(link?.url);
    if (!url) continue;
    const key = url.toLowerCase();
    const candidate = { url, text: clean(link?.text).slice(0, 240) };
    const current = best.get(key);
    if (!current || candidate.text.length > current.text.length) best.set(key, candidate);
  }
  return [...best.values()].slice(0, 1000);
}

function mergeProbeManuals(manuals = [], vehicle = {}, context = {}, elapsedMs = 0) {
  const usable = manuals.filter(Boolean);
  if (!usable.length) return null;

  const items = dedupeManualItems(usable.flatMap(manual => manual.items || []));
  const corpusItems = dedupeManualItems(usable.flatMap(manual => manual.corpusItems || []));
  const navigationLinks = dedupeNavigationLinks(usable.flatMap(manual => manual.navigationLinks || []));
  const first = usable[0];
  const scrapedTimes = usable.map(manual => manual.scraped_at).filter(Boolean).sort();

  return {
    schemaVersion: 5,
    source: first.source || 'LEMON_MANUALS',
    vehicle: { ...vehicle },
    query: {
      scope: context.scope || 'diagnosis',
      symptoms: context.symptoms || context.query || '',
      mechanicNotices: context.mechanicNotices || [],
      dtcs: Array.isArray(context.obdCodes) ? context.obdCodes : [context.obdCodes].filter(Boolean)
    },
    items,
    corpusItems,
    navigationLinks,
    crawled_urls: usable.reduce((sum, manual) => sum + Number(manual.crawled_urls || 0), 0),
    relevant_pages: items.length,
    corpus_pages: corpusItems.length,
    navigation_links: navigationLinks.length,
    resolved_url: usable.map(manual => clean(manual.resolved_url)).find(Boolean) || '',
    path_resolution: 'stored-navigation-multi-dtc-probe',
    applicability: first.applicability || null,
    retrieval: {
      elapsedMs: Number(elapsedMs || 0),
      timeBudgetExceeded: usable.some(manual => manual.retrieval?.timeBudgetExceeded === true),
      crawlTruncated: usable.some(manual => manual.retrieval?.crawlTruncated === true),
      corpusPageCount: corpusItems.length,
      navigationLinkCount: navigationLinks.length,
      seedLinkCount: usable.reduce((sum, manual) => sum + Number(manual.retrieval?.seedLinkCount || 0), 0),
      navigationSeeded: true,
      seedEarlyStop: usable.every(manual => manual.retrieval?.seedEarlyStop === true),
      seedMatchedDtcs: uniq(usable.flatMap(manual => manual.retrieval?.seedMatchedDtcs || [])),
      multiDtcProbe: true
    },
    scraped: true,
    scraped_at: scrapedTimes.slice(-1)[0] || new Date().toISOString()
  };
}

function perDtcProbeContext(anchor = {}, context = {}) {
  const code = clean(anchor.code).toUpperCase();
  const terms = uniq((anchor.terms || []).map(clean));
  const query = uniq([code, ...terms]).join(' ');
  return {
    ...context,
    query,
    symptoms: query,
    obdCodes: code ? [code] : [],
    keywords: terms
  };
}

async function runMultiDtcNavigationProbe({
  storedRows = [],
  vehicle = {},
  context = {},
  scope = 'diagnosis',
  cacheKey,
  manualPathHint,
  targetedRunner,
  options = {}
}) {
  const currentSearch = buildCurrentSearchContext(vehicle, context);
  const anchors = currentSearch.dtcIntent?.mode === 'DTC_ANCHORED'
    ? currentSearch.dtcIntent.anchors || []
    : [];
  const maxCodes = Math.max(2, Math.min(4, positiveNumber(
    options.multiDtcProbeMaxCodes ?? process.env.LEMON_MULTI_DTC_PROBE_MAX_CODES,
    4
  )));

  if (anchors.length < 2 || anchors.length > maxCodes) return null;

  // Independent per-code probes need depth more than breadth. Two strong stored
  // entry points leave the bounded page/time budget available for descendants.
  const seedLimitPerDtc = positiveNumber(
    options.seedLinkLimitPerDtc ?? process.env.LEMON_SEED_LINK_LIMIT_PER_DTC,
    2
  );
  const probeSpecs = anchors.map(anchor => {
    const probeContext = perDtcProbeContext(anchor, context);
    const seeds = buildStoredNavigationSeeds(
      storedRows,
      vehicle,
      probeContext,
      scope,
      { limit: seedLimitPerDtc }
    );
    return { anchor, probeContext, seeds };
  });

  if (probeSpecs.some(spec => !spec.seeds.length)) {
    console.log(
      `[Scraper] Multi-DTC navigation probe unavailable for ${vehicle.year} ${vehicle.make} ${vehicle.model}; ` +
      'at least one requested DTC has no stored navigation seed'
    );
    return null;
  }

  const probeBudgetMs = positiveNumber(
    options.seedProbeBudgetMs ?? process.env.LEMON_SEED_PROBE_BUDGET_MS,
    4500
  );
  const probeHardTimeoutMs = Math.max(
    probeBudgetMs + 1500,
    positiveNumber(options.seedProbeHardTimeoutMs ?? process.env.LEMON_SEED_PROBE_HARD_TIMEOUT_MS, 6500)
  );
  const startedAt = Date.now();
  console.log(
    `[Scraper] Multi-DTC navigation probe START for ${vehicle.year} ${vehicle.make} ${vehicle.model}: ` +
    `${anchors.map(anchor => anchor.code).join(',')} concurrently, budget=${probeBudgetMs}ms/code, ` +
    `seeds=${probeSpecs.map(spec => `${spec.anchor.code}:${spec.seeds.length}`).join(',')}`
  );

  const results = await Promise.all(probeSpecs.map(async spec => {
    try {
      const output = await targetedRunner(
        workerVehicle(vehicle, manualPathHint),
        workerContext(spec.probeContext),
        scope,
        {
          maxPages: positiveNumber(options.seedProbeMaxPagesPerDtc ?? process.env.LEMON_SEED_PROBE_MAX_PAGES_PER_DTC, 18),
          maxDepth: positiveNumber(options.maxDepth ?? process.env.LEMON_LIVE_MAX_DEPTH, 4),
          fetchTimeoutMs: positiveNumber(options.seedFetchTimeoutMs ?? process.env.LEMON_SEED_FETCH_TIMEOUT_MS, 2500),
          maxElapsedMs: probeBudgetMs,
          hardTimeoutMs: probeHardTimeoutMs,
          corpusLimit: positiveNumber(options.seedProbeCorpusLimitPerDtc ?? process.env.LEMON_SEED_PROBE_CORPUS_PAGES_PER_DTC, 18),
          corpusBodyChars: positiveNumber(options.corpusBodyChars ?? process.env.LEMON_CORPUS_BODY_CHARS, 3500),
          navigationLimit: positiveNumber(options.navigationLimit ?? process.env.LEMON_NAVIGATION_MAX_LINKS, 500),
          seedLinks: spec.seeds,
          seedFetchTimeoutMs: positiveNumber(options.seedFetchTimeoutMs ?? process.env.LEMON_SEED_FETCH_TIMEOUT_MS, 2500),
          seedProbeBudgetMs: probeBudgetMs,
          allowUnknownDrivetrain: true
        }
      );
      return { spec, output, manual: targetedToManual(output) };
    } catch (error) {
      console.warn(
        `[Scraper] Multi-DTC navigation probe ${spec.anchor.code} failed for ${cacheKey}: ${error.message}`
      );
      return null;
    }
  }));

  if (results.some(result => !result)) return null;

  const elapsedMs = Date.now() - startedAt;
  const probeSummary = results.map(result =>
    `${result.spec.anchor.code}:${Number(result.output?.crawledPages || 0)} fetched/` +
    `${Number(result.output?.selectedPages || 0)} selected/` +
    `coverage=${(result.output?.seedMatchedDtcs || []).join('+') || 'none'}`
  ).join('; ');
  const mergedManual = mergeProbeManuals(results.map(result => result.manual), vehicle, context, elapsedMs);
  const mergedRelevant = mergedManual
    ? rerankStoredManualEvidence(
        [storedRowFromManual(cacheKey, mergedManual)],
        vehicle,
        context,
        scope,
        { maxItems: positiveNumber(options.storedReuseMaxItems ?? process.env.LEMON_STORED_REUSE_MAX_ITEMS, 12) }
      )
    : null;

  if (!mergedRelevant) {
    console.log(
      `[Scraper] Multi-DTC navigation probe MISS for ${vehicle.year} ${vehicle.make} ${vehicle.model} ` +
      `after ${elapsedMs}ms; ${probeSummary}; merged visible evidence did not cover every requested DTC`
    );
    return null;
  }

  await saveScrapedManual(vehicle, mergedManual, context);
  console.log(
    `[Scraper] Multi-DTC navigation probe HIT for ${vehicle.year} ${vehicle.make} ${vehicle.model} ` +
    `in ${elapsedMs}ms (${probeSummary}; ${mergedRelevant.items.length} merged DTC-relevant page(s), ` +
    `coverage=${(mergedRelevant.retrieval?.coveredDtcs || []).join(',')})`
  );

  return {
    ...mergedRelevant,
    fromCache: false,
    scraped: true,
    cacheMode: 'stored-navigation-multi-dtc-probe',
    retrieval: {
      ...(mergedRelevant.retrieval || {}),
      elapsedMs,
      navigationSeeded: true,
      seedProbe: true,
      multiDtcProbe: true,
      probedDtcs: anchors.map(anchor => anchor.code),
      seedLinkCount: probeSpecs.reduce((sum, spec) => sum + spec.seeds.length, 0)
    }
  };
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
      if (hasDtcContext(context)) {
        const exactRevalidated = rerankStoredManualEvidence(
          [cached],
          vehicle,
          context,
          context.scope || 'diagnosis',
          { maxItems: positiveNumber(options.storedReuseMaxItems ?? process.env.LEMON_STORED_REUSE_MAX_ITEMS, 12) }
        );
        if (exactRevalidated) {
          console.log(`[Scraper] Context cache HIT+REVALIDATED for ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
          return {
            ...exactRevalidated,
            fromCache: true,
            cacheMode: 'exact-context-revalidated',
            cachedAt: cached.scraped_at
          };
        }
        console.log(
          `[Scraper] Context cache REJECTED for ${vehicle.year} ${vehicle.make} ${vehicle.model}; ` +
          'cached DTC evidence no longer satisfies the visible current-context gate'
        );
      } else {
        console.log(`[Scraper] Context cache HIT for ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
        return { ...cached.data, fromCache: true, cacheMode: 'exact-context', cachedAt: cached.scraped_at };
      }
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

    const navigationSeeds = buildStoredNavigationSeeds(
      storedRows,
      vehicle,
      context,
      context.scope || 'diagnosis',
      { limit: positiveNumber(options.seedLinkLimit ?? process.env.LEMON_SEED_LINK_LIMIT, 12) }
    );
    if (navigationSeeds.length) {
      const covered = [...new Set(navigationSeeds.flatMap(seed => seed.matchedDtcs || []))];
      console.log(
        `[Scraper] Stored navigation seeds READY for ${vehicle.year} ${vehicle.make} ${vehicle.model}: ` +
        `${navigationSeeds.length} link(s), DTC coverage=${covered.join(',') || 'none'}`
      );
    }

    const manualPathHint = typeof getCachedManualPathHint === 'function'
      ? await getCachedManualPathHint(vehicle, context)
      : '';
    if (manualPathHint) {
      console.log(`[Scraper] Reusing cached manual path hint for ${cacheKey}`);
    }

    const targetedRunner = typeof options.targetedRunner === 'function'
      ? options.targetedRunner
      : runTargetedEvidenceWorker;

    const currentSearch = buildCurrentSearchContext(vehicle, context);
    const resolvedAnchors = currentSearch.dtcIntent?.mode === 'DTC_ANCHORED'
      ? currentSearch.dtcIntent.anchors || []
      : [];
    const multiDtcProbeEligible = resolvedAnchors.length >= 2 && resolvedAnchors.length <= Math.max(2, Math.min(4, positiveNumber(
      options.multiDtcProbeMaxCodes ?? process.env.LEMON_MULTI_DTC_PROBE_MAX_CODES,
      4
    )));

    if (multiDtcProbeEligible && storedRows.length) {
      const multiProbe = await runMultiDtcNavigationProbe({
        storedRows,
        vehicle,
        context,
        scope: context.scope || 'diagnosis',
        cacheKey,
        manualPathHint,
        targetedRunner,
        options
      });
      if (multiProbe) return multiProbe;
    }

    if (navigationSeeds.length && !multiDtcProbeEligible) {
      const probeBudgetMs = positiveNumber(
        options.seedProbeBudgetMs ?? process.env.LEMON_SEED_PROBE_BUDGET_MS,
        4500
      );
      const probeHardTimeoutMs = Math.max(
        probeBudgetMs + 1500,
        positiveNumber(options.seedProbeHardTimeoutMs ?? process.env.LEMON_SEED_PROBE_HARD_TIMEOUT_MS, 6500)
      );
      try {
        console.log(
          `[Scraper] Stored navigation probe START for ${vehicle.year} ${vehicle.make} ${vehicle.model}: ` +
          `${navigationSeeds.length} seed(s), budget=${probeBudgetMs}ms`
        );
        const probe = await targetedRunner(
          workerVehicle(vehicle, manualPathHint),
          workerContext(context),
          context.scope || 'diagnosis',
          {
            maxPages: positiveNumber(options.seedProbeMaxPages ?? process.env.LEMON_SEED_PROBE_MAX_PAGES, 24),
            maxDepth: positiveNumber(options.maxDepth ?? process.env.LEMON_LIVE_MAX_DEPTH, 4),
            fetchTimeoutMs: positiveNumber(options.seedFetchTimeoutMs ?? process.env.LEMON_SEED_FETCH_TIMEOUT_MS, 2500),
            maxElapsedMs: probeBudgetMs,
            hardTimeoutMs: probeHardTimeoutMs,
            corpusLimit: positiveNumber(options.seedProbeCorpusLimit ?? process.env.LEMON_SEED_PROBE_CORPUS_PAGES, 24),
            corpusBodyChars: positiveNumber(options.corpusBodyChars ?? process.env.LEMON_CORPUS_BODY_CHARS, 3500),
            navigationLimit: positiveNumber(options.navigationLimit ?? process.env.LEMON_NAVIGATION_MAX_LINKS, 500),
            seedLinks: navigationSeeds,
            seedFetchTimeoutMs: positiveNumber(options.seedFetchTimeoutMs ?? process.env.LEMON_SEED_FETCH_TIMEOUT_MS, 2500),
            seedProbeBudgetMs: probeBudgetMs,
            allowUnknownDrivetrain: true
          }
        );
        const probeManual = targetedToManual(probe);
        const probeRelevant = rerankStoredManualEvidence(
          [storedRowFromManual(cacheKey, probeManual)],
          vehicle,
          context,
          context.scope || 'diagnosis',
          { maxItems: positiveNumber(options.storedReuseMaxItems ?? process.env.LEMON_STORED_REUSE_MAX_ITEMS, 12) }
        );

        if (probeRelevant) {
          console.log(
            `[Scraper] Stored navigation probe HIT for ${vehicle.year} ${vehicle.make} ${vehicle.model} ` +
            `in ${Number(probe.elapsedMs || 0)}ms (${Number(probe.crawledPages || 0)} fetched / ` +
            `${probeRelevant.items.length} DTC-relevant page(s))`
          );
          await saveScrapedManual(vehicle, probeManual, context);
          return {
            ...probeRelevant,
            fromCache: false,
            scraped: true,
            cacheMode: 'stored-navigation-probe',
            retrieval: {
              ...(probeRelevant.retrieval || {}),
              elapsedMs: Number(probe.elapsedMs || 0),
              navigationSeeded: true,
              seedProbe: true,
              seedLinkCount: navigationSeeds.length
            }
          };
        }

        console.log(
          `[Scraper] Stored navigation probe MISS for ${vehicle.year} ${vehicle.make} ${vehicle.model} ` +
          `after ${Number(probe.elapsedMs || 0)}ms; falling back to full targeted crawl`
        );
      } catch (error) {
        console.warn(
          `[Scraper] Stored navigation probe failed for ${cacheKey}: ${error.message}; ` +
          'falling back to full targeted crawl'
        );
      }
    }

    console.log(`[Scraper] Context cache MISS for ${vehicle.year} ${vehicle.make} ${vehicle.model} - isolated targeted Repair & Diagnosis scrape`);
    try {
      const targeted = await targetedRunner(
        workerVehicle(vehicle, manualPathHint),
        workerContext(context),
        context.scope || 'diagnosis',
        {
          maxPages: positiveNumber(options.maxPages ?? process.env.LEMON_LIVE_MAX_PAGES, 80),
          maxDepth: positiveNumber(options.maxDepth ?? process.env.LEMON_LIVE_MAX_DEPTH, 4),
          fetchTimeoutMs: positiveNumber(options.fetchTimeoutMs ?? process.env.LEMON_LIVE_FETCH_TIMEOUT_MS, 6000),
          maxElapsedMs: positiveNumber(options.maxElapsedMs ?? process.env.LEMON_LIVE_MAX_ELAPSED_MS, 20000),
          hardTimeoutMs: positiveNumber(options.hardTimeoutMs ?? process.env.LEMON_WORKER_HARD_TIMEOUT_MS, 30000),
          corpusLimit: positiveNumber(options.corpusLimit ?? process.env.LEMON_CORPUS_MAX_PAGES, 80),
          corpusBodyChars: positiveNumber(options.corpusBodyChars ?? process.env.LEMON_CORPUS_BODY_CHARS, 3500),
          navigationLimit: positiveNumber(options.navigationLimit ?? process.env.LEMON_NAVIGATION_MAX_LINKS, 500),
          seedLinks: [],
          allowUnknownDrivetrain: true
        }
      );
      const freshResult = targetedToManual(targeted);
      console.log(
        `[Scraper] Targeted retrieval ${cacheKey} completed in ${Number(targeted.elapsedMs || 0)}ms ` +
        `(${Number(targeted.crawledPages || 0)} crawled / ${Number(targeted.selectedPages || 0)} selected / ` +
        `${Number(targeted.corpusPageCount || 0)} retained / ${Number(targeted.navigationLinkCount || 0)} navigation links)`
      );
      if (freshResult.items.length > 0 || freshResult.corpusItems.length > 0 || freshResult.navigationLinks.length > 0) {
        await saveScrapedManual(vehicle, freshResult, context);
      }
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
  targetedToManual,
  hasDtcContext,
  workerVehicle,
  workerContext,
  storedRowFromManual,
  manualItemKey,
  dedupeManualItems,
  dedupeNavigationLinks,
  mergeProbeManuals,
  perDtcProbeContext,
  runMultiDtcNavigationProbe
};