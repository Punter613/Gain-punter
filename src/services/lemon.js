const { getCachedManual, saveScrapedManual } = require('../db');
const { buildCanonicalSearchTerms } = require('../core/automotive.normalization');
const {
  scrapeTargetedEvidence,
  scorePage: scoreTargetedPage
} = require('../../scripts/scrape-lemon-targeted-evidence');

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
    schemaVersion: 4,
    source: output.source || 'LEMON_MANUALS',
    vehicle: output.vehicle || {},
    query: output.query || {},
    items: (output.pages || []).map(pageToManualItem),
    crawled_urls: Number(output.crawledPages || 0),
    relevant_pages: Number(output.selectedPages || 0),
    resolved_url: output.resolvedUrl || '',
    path_resolution: output.pathResolution || '',
    applicability: output.applicability || null,
    scraped: true,
    scraped_at: output.scrapedAt || new Date().toISOString()
  };
}

async function scrapeLEMONManuals(vehicle, context = {}) {
  if (!vehicle || !vehicle.make || !vehicle.year || !vehicle.model) {
    return { items: [], error: 'Insufficient vehicle data for scraping' };
  }

  const cached = await getCachedManual(vehicle, context);
  if (cached && cached.data) {
    console.log(`[Scraper] Context cache HIT for ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
    return { ...cached.data, fromCache: true, cachedAt: cached.scraped_at };
  }

  console.log(`[Scraper] Context cache MISS for ${vehicle.year} ${vehicle.make} ${vehicle.model} - tuned targeted Repair & Diagnosis scrape`);
  try {
    const targeted = await scrapeTargetedEvidence(
      vehicle,
      {
        ...context,
        query: context.query || '',
        symptoms: context.symptoms || context.query || ''
      },
      context.scope || 'diagnosis',
      {
        maxPages: Number(process.env.LEMON_LIVE_MAX_PAGES || 80),
        maxDepth: Number(process.env.LEMON_LIVE_MAX_DEPTH || 4),
        allowUnknownDrivetrain: true,
        onFetchError: (url, error) => console.warn(`[Scraper] Manual fetch failed for ${url}: ${error.message}`)
      }
    );
    const freshResult = targetedToManual(targeted);
    if (freshResult.items.length > 0) await saveScrapedManual(vehicle, freshResult, context);
    return { ...freshResult, fromCache: false };
  } catch (error) {
    return { items: [], source: null, error: error.message, fromCache: false };
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