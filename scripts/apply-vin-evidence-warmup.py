from pathlib import Path
import re


def read(path):
    return Path(path).read_text()


def write(path, content):
    Path(path).write_text(content)


def replace_once(path, old, new):
    content = read(path)
    if old not in content:
        raise RuntimeError(f"Patch anchor not found in {path}: {old[:140]!r}")
    write(path, content.replace(old, new, 1))


def replace_regex(path, pattern, replacement):
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"Regex patch anchor not found in {path}: {pattern}")
    write(path, updated)


write('src/services/vehicle.warmup.js', r'''const { decodeVinNhtsa } = require('./vin');
const { scrapeLEMONManuals } = require('./lemon');
const { harvestVehicleTsbs } = require('./tsb.harvester');
const { buildVehicleCacheKey } = require('../db');

const warmups = new Map();

function clean(value) {
  return String(value || '').trim();
}

function mergeVehicleProfile(decoded = {}, supplied = {}, vin = '') {
  const driveType = decoded.driveType || supplied.driveType || supplied.drivetrain || supplied.drive || '';
  return {
    vin: clean(vin || supplied.vin),
    year: decoded.year || supplied.year || '',
    make: decoded.make || supplied.make || '',
    model: decoded.model || supplied.model || '',
    trim: supplied.trim || decoded.trim || '',
    engine: decoded.engine || supplied.engine || supplied.trim || '',
    engineCylinders: decoded.engineCylinders || supplied.engineCylinders || '',
    driveType,
    drivetrain: driveType || supplied.drivetrain || '',
    bodyClass: decoded.bodyClass || supplied.bodyClass || '',
    transmissionStyle: decoded.transmissionStyle || supplied.transmissionStyle || ''
  };
}

async function resolveVehicleProfile(vin = '', supplied = {}) {
  const normalizedVin = clean(vin || supplied.vin);
  if (normalizedVin.length === 17) {
    const decoded = await decodeVinNhtsa(normalizedVin);
    if (!decoded) throw new Error('VIN decoded without a usable vehicle profile');
    return mergeVehicleProfile(decoded, supplied, normalizedVin);
  }
  return mergeVehicleProfile({}, supplied, normalizedVin);
}

function warmupKey(vehicle) {
  return buildVehicleCacheKey(vehicle);
}

function warmVehicleEvidence(vehicle, options = {}) {
  if (!vehicle?.year || !vehicle?.make || !vehicle?.model) {
    return { status: 'SKIPPED', key: '', reason: 'vehicle identity incomplete', promise: Promise.resolve(null) };
  }

  const key = warmupKey(vehicle);
  const existing = warmups.get(key);
  if (existing) return { status: existing.status, key, promise: existing.promise };

  const entry = { status: 'PENDING', startedAt: Date.now(), finishedAt: null, promise: null };
  entry.promise = Promise.allSettled([
    scrapeLEMONManuals(vehicle, {}),
    harvestVehicleTsbs(vehicle, {}, { maxPages: options.maxPages })
  ]).then(results => {
    entry.status = 'READY';
    entry.finishedAt = Date.now();
    entry.results = results;
    console.log(`[Vehicle Warmup] READY ${key} in ${entry.finishedAt - entry.startedAt}ms`);
    return results;
  }).catch(error => {
    entry.status = 'FAILED';
    entry.finishedAt = Date.now();
    entry.error = error.message;
    console.warn(`[Vehicle Warmup] FAILED ${key}: ${error.message}`);
    return null;
  });

  warmups.set(key, entry);
  console.log(`[Vehicle Warmup] STARTED ${key}`);
  return { status: 'STARTED', key, promise: entry.promise };
}

async function waitForVehicleWarmup(vehicle, timeoutMs = 2500) {
  if (!vehicle?.year || !vehicle?.make || !vehicle?.model) return { status: 'SKIPPED' };
  const key = warmupKey(vehicle);
  const entry = warmups.get(key);
  if (!entry) return { status: 'NOT_STARTED', key };
  if (entry.status !== 'PENDING') return { status: entry.status, key, elapsedMs: entry.finishedAt ? entry.finishedAt - entry.startedAt : 0 };

  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve('PENDING'), Math.max(0, Number(timeoutMs) || 0));
  });
  const settled = entry.promise.then(() => entry.status);
  const status = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return { status, key, elapsedMs: Date.now() - entry.startedAt };
}

function getVehicleWarmupStatus(vehicle) {
  if (!vehicle?.year || !vehicle?.make || !vehicle?.model) return { status: 'SKIPPED' };
  const key = warmupKey(vehicle);
  const entry = warmups.get(key);
  return entry ? { status: entry.status, key, startedAt: entry.startedAt, finishedAt: entry.finishedAt } : { status: 'NOT_STARTED', key };
}

module.exports = {
  mergeVehicleProfile,
  resolveVehicleProfile,
  warmVehicleEvidence,
  waitForVehicleWarmup,
  getVehicleWarmupStatus
};
''')

write('src/routes/vehicle.js', r'''const express = require('express');
const router = express.Router();
const { resolveVehicleProfile, warmVehicleEvidence } = require('../services/vehicle.warmup');

router.post('/decode', async (req, res) => {
  try {
    const vin = String(req.body?.vin || '').trim();
    if (vin.length !== 17) {
      return res.status(400).json({ success: false, error: 'A valid 17-character VIN is required.' });
    }

    const vehicle = await resolveVehicleProfile(vin, {});
    const warmup = warmVehicleEvidence(vehicle);

    return res.json({
      success: true,
      vehicle,
      evidenceWarmup: warmup.status,
      evidenceKey: warmup.key
    });
  } catch (error) {
    console.error('[Vehicle Decode]', error.message);
    return res.status(502).json({ success: false, error: 'VIN decode failed.', details: error.message });
  }
});

module.exports = router;
''')

replace_once('api/server.js',
             "const fleetRouter = require('../src/routes/fleet');\n",
             "const fleetRouter = require('../src/routes/fleet');\nconst vehicleRouter = require('../src/routes/vehicle');\n")
replace_once('api/server.js',
             "app.use('/api/fleet', fleetRouter);\n",
             "app.use('/api/fleet', fleetRouter);\napp.use('/api/vehicle', vehicleRouter);\n")

replace_once('src/services/vehicle.evidence.js',
             "const NodeCache = require('node-cache');\n",
             "const NodeCache = require('node-cache');\nconst crypto = require('crypto');\n")
replace_once('src/services/vehicle.evidence.js', r'''function vehicleKey(vehicle) {
  return [
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.trim,
    vehicle.engine,
    vehicle.drivetrain || vehicle.driveType || vehicle.drive
  ].map(clean).join('|').toLowerCase();
}
''', r'''function vehicleKey(vehicle) {
  return [
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.trim,
    vehicle.engine,
    vehicle.drivetrain || vehicle.driveType || vehicle.drive
  ].map(clean).join('|').toLowerCase();
}

function evidenceContextKey(context = {}) {
  const payload = JSON.stringify({
    symptoms: clean(context.symptoms),
    mechanicNotices: Array.isArray(context.mechanicNotices) ? context.mechanicNotices.map(clean) : clean(context.mechanicNotices),
    obdCodes: Array.isArray(context.obdCodes) ? context.obdCodes.map(clean) : clean(context.obdCodes),
    keywords: Array.isArray(context.keywords) ? context.keywords.map(clean) : clean(context.keywords)
  });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function tsbContextEligible(reference, context = {}) {
  const symptomText = clean([
    context.symptoms,
    ...(Array.isArray(context.mechanicNotices) ? context.mechanicNotices : []),
    ...(Array.isArray(context.keywords) ? context.keywords : [])
  ].filter(Boolean).join(' ')).toLowerCase();
  const bulletinText = clean([
    reference.title,
    reference.subject,
    reference.groupName,
    reference.snippet,
    JSON.stringify(reference.extractedFacts || {})
  ].filter(Boolean).join(' ')).toLowerCase();
  const codes = (Array.isArray(context.obdCodes) ? context.obdCodes : [])
    .map(code => String(code || '').trim().toLowerCase())
    .filter(Boolean);
  const codeMatch = codes.some(code => bulletinText.includes(code));

  const symptomNoise = /clunk|noise|chatter|vibration|knock|thud|bump/.test(symptomText);
  const bulletinNoise = /clunk|noise|chatter|vibration|knock|thud|bump|ping|creak/.test(bulletinText);
  const steeringOverlap = /steering|full lock|tie rod|rack/.test(symptomText) && /steering|full lock|tie rod|rack/.test(bulletinText);
  const drivelineOverlap = /driveline|driveshaft|propeller shaft|u joint|universal joint|transfer case|differential|torque reversal/.test(symptomText) && /driveline|driveshaft|propeller shaft|u joint|universal joint|transfer case|differential|torque reversal/.test(bulletinText);
  const loadOverlap = /deceler|throttle release|accelerator[^.]{0,20}release|load change|torque reversal|reverse|neutral[^.]{0,20}drive/.test(symptomText) && /deceler|throttle release|accelerator[^.]{0,20}release|load change|torque reversal|reverse|neutral[^.]{0,20}drive/.test(bulletinText);

  if (codeMatch) return true;
  if (symptomNoise) return bulletinNoise && (steeringOverlap || drivelineOverlap || loadOverlap);
  return steeringOverlap || drivelineOverlap || loadOverlap || Number(reference.relevanceScore || 0) >= 24;
}

function selectRelevantTsbs(vehicleEvidence, context = {}, minScore = 12) {
  return (vehicleEvidence?.tsbs?.references || [])
    .filter(ref => Number(ref.relevanceScore || 0) >= Number(minScore || 0))
    .filter(ref => tsbContextEligible(ref, context))
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));
}
''')
replace_once('src/services/vehicle.evidence.js',
             "async function collectVehicleEvidence(vehicle, context = {}) {\n",
             "async function collectVehicleEvidence(vehicle, context = {}, options = {}) {\n")
replace_once('src/services/vehicle.evidence.js',
             "  const key = vehicleKey(vehicle);\n",
             "  const key = `${vehicleKey(vehicle)}|${evidenceContextKey(context)}`;\n")
replace_once('src/services/vehicle.evidence.js', r'''  const [manualResult, tsbResult, nhtsaResult] = await Promise.allSettled([
    scrapeLEMONManuals(vehicle, context),
    harvestVehicleTsbs(vehicle, { ...context, keywords: context.keywords || [] }),
    scrapeNhtsa(vehicle)
  ]);
''', r'''  const [manualResult, tsbResult, nhtsaResult] = await Promise.allSettled([
    scrapeLEMONManuals(vehicle, context),
    harvestVehicleTsbs(vehicle, { ...context, keywords: context.keywords || [] }),
    options.includeNhtsa === false ? Promise.resolve(null) : scrapeNhtsa(vehicle)
  ]);
''')
replace_once('src/services/vehicle.evidence.js', r'''  if (nhtsaResult.status === 'fulfilled') {
    const nhtsa = nhtsaResult.value || {};
    result.recalls = nhtsa.recalls || [];
    result.knownIssues = nhtsa.knownIssues || [];
    result.complaintCount = nhtsa.complaintCount || 0;
    if (result.recalls.length || result.knownIssues.length) result.sources.push('NHTSA_ODI');
  } else result.errors.push(`NHTSA: ${nhtsaResult.reason?.message || 'lookup failed'}`);
''', r'''  if (options.includeNhtsa !== false) {
    if (nhtsaResult.status === 'fulfilled') {
      const nhtsa = nhtsaResult.value || {};
      result.recalls = nhtsa.recalls || [];
      result.knownIssues = nhtsa.knownIssues || [];
      result.complaintCount = nhtsa.complaintCount || 0;
      if (result.recalls.length || result.knownIssues.length) result.sources.push('NHTSA_ODI');
    } else result.errors.push(`NHTSA: ${nhtsaResult.reason?.message || 'lookup failed'}`);
  }
''')
replace_once('src/services/vehicle.evidence.js',
             "module.exports = { collectVehicleEvidence };\n",
             "module.exports = { collectVehicleEvidence, selectRelevantTsbs, tsbContextEligible, evidenceContextKey };\n")

replace_once('src/routes/estimate.js',
             "const { collectVehicleEvidence } = require('../services/vehicle.evidence');\nconst { decodeVinNhtsa } = require('../services/vin');\n",
             "const { collectVehicleEvidence, selectRelevantTsbs } = require('../services/vehicle.evidence');\nconst { resolveVehicleProfile, waitForVehicleWarmup } = require('../services/vehicle.warmup');\n")
replace_regex('src/routes/estimate.js', r"async function buildEvidenceVehicle[\s\S]*?function getRelevantTsbs\(vehicleEvidence\) \{[\s\S]*?\n\}\n\n", '')
replace_once('src/routes/estimate.js',
             "    const evidenceVehicle = await buildEvidenceVehicle(vehicle, vin);\n\n",
             r'''    let evidenceVehicle = vehicle;
    try {
      evidenceVehicle = await resolveVehicleProfile(vin, vehicle);
    } catch (err) {
      console.warn('[Estimate Evidence] VIN/profile resolution failed (non-fatal):', err.message);
    }
    const evidenceContext = {
      symptoms: customerStates.join(' '),
      mechanicNotices,
      obdCodes,
      keywords
    };
    const warmupStatus = await waitForVehicleWarmup(evidenceVehicle, 2500);

''')
replace_once('src/routes/estimate.js', r'''      vehicleEvidence = await collectVehicleEvidence(evidenceVehicle, {
        symptoms: customerStates.join(' '), mechanicNotices, obdCodes, keywords
      });
''', r'''      vehicleEvidence = await collectVehicleEvidence(evidenceVehicle, evidenceContext, { includeNhtsa: false });
''')
replace_once('src/routes/estimate.js', r'''    const vehicleStr = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ') || 'Unknown Vehicle';
    const relevantTsbs = getRelevantTsbs(vehicleEvidence);
''', r'''    const vehicleStr = [evidenceVehicle.year, evidenceVehicle.make, evidenceVehicle.model, evidenceVehicle.trim].filter(Boolean).join(' ') || 'Unknown Vehicle';
    const relevantTsbs = selectRelevantTsbs(vehicleEvidence, evidenceContext, MIN_TSB_RELEVANCE);
''')
replace_once('src/routes/estimate.js',
             "      unsupportedTorqueSpecsRemoved\n    };\n",
             "      unsupportedTorqueSpecsRemoved,\n      warmupStatus: warmupStatus.status\n    };\n")

replace_once('src/routes/diagnose.js',
             "const { recordGuardCatch } = require('../core/learning/guard.catch.recorder');\n",
             "const { recordGuardCatch } = require('../core/learning/guard.catch.recorder');\nconst { collectVehicleEvidence, selectRelevantTsbs } = require('../services/vehicle.evidence');\nconst { resolveVehicleProfile, waitForVehicleWarmup } = require('../services/vehicle.warmup');\n")
replace_once('src/routes/diagnose.js', r'''    const targetSymptoms = [
      ...customerSymptomContext,
      ...(Array.isArray(mechanicNotices) ? mechanicNotices : [])
    ].map(s => String(s).toLowerCase().trim()).filter(Boolean);

''', r'''    const targetSymptoms = [
      ...customerSymptomContext,
      ...(Array.isArray(mechanicNotices) ? mechanicNotices : [])
    ].map(s => String(s).toLowerCase().trim()).filter(Boolean);

    let resolvedVehicle = vehicle;
    try {
      resolvedVehicle = await resolveVehicleProfile(vin, vehicle);
      if (resolvedVehicle?.make) executionTrace.log('VIN_PROFILE', `${resolvedVehicle.year} ${resolvedVehicle.make} ${resolvedVehicle.model} ${resolvedVehicle.driveType || ''}`.trim());
    } catch (err) {
      executionTrace.log('VIN_PROFILE_WARN', `VIN/profile resolution failed: ${err.message}`);
    }

''')
replace_once('src/routes/diagnose.js',
             "        vehicle, vin, axleCode, symptoms: targetSymptoms, codes: targetCodes, notes, laborRate, mileage\n",
             "        vehicle: resolvedVehicle, vin, axleCode, symptoms: targetSymptoms, codes: targetCodes, notes, laborRate, mileage\n")
replace_once('src/routes/diagnose.js',
             "    const localProfile = getVehicleRiskProfile(vehicle, vin);\n",
             "    const localProfile = getVehicleRiskProfile(resolvedVehicle, vin);\n")
replace_once('src/routes/diagnose.js', r'''    const inputMake = (vehicle.make || '').toLowerCase();
    const inputModel = (vehicle.model || '').toLowerCase();
''', r'''    const inputMake = (resolvedVehicle.make || '').toLowerCase();
    const inputModel = (resolvedVehicle.model || '').toLowerCase();
''')
replace_once('src/routes/diagnose.js',
             "    let systemPrompt = `You are the expert diagnostic logic unit of SKSK ProTech — a master automotive diagnostician with 25 years of real shop experience.\n",
             r'''    const evidenceContext = {
      symptoms: customerSymptomContext.join(' '),
      mechanicNotices: mechanicContext,
      obdCodes: targetCodes,
      keywords
    };
    let vehicleEvidence = { available: false, oem: { references: [] }, tsbs: { references: [] }, sources: [], errors: [] };
    let warmupStatus = { status: 'NOT_STARTED' };
    if (resolvedVehicle?.year && resolvedVehicle?.make && resolvedVehicle?.model) {
      try {
        warmupStatus = await waitForVehicleWarmup(resolvedVehicle, 2500);
        vehicleEvidence = await collectVehicleEvidence(resolvedVehicle, evidenceContext, { includeNhtsa: false });
      } catch (err) {
        executionTrace.log('EVIDENCE_WARN', `Vehicle evidence unavailable: ${err.message}`);
      }
    }
    const relevantTsbs = selectRelevantTsbs(vehicleEvidence, evidenceContext, 12);
    const oemReferences = (vehicleEvidence.oem?.references || []).slice(0, 6);
    const compactEvidence = {
      OEM_FACTORY_REFERENCES: oemReferences.map(x => ({ title: x.title, url: x.url, type: x.evidenceType, facts: x.extractedFacts })),
      TSB_CANDIDATES: relevantTsbs.slice(0, 5).map(x => ({ title: x.title, url: x.url, facts: x.extractedFacts, relevanceScore: x.relevanceScore })),
      SOURCES: (vehicleEvidence.sources || []).filter(source => source !== 'NHTSA_ODI' && source !== 'NHTSA ODI')
    };

    let systemPrompt = `You are the expert diagnostic logic unit of SKSK ProTech — a master automotive diagnostician with 25 years of real shop experience.
''')
replace_once('src/routes/diagnose.js',
             "    const userPrompt = `Vehicle: ${vehicle.make || 'N/A'} ${vehicle.model || 'N/A'} | VIN: ${vin || 'N/A'} | Mileage: ${mileage || 'N/A'} | Codes: ${targetCodes.join(', ') || 'None'} | LOW-WEIGHT CUSTOMER SYMPTOM CONTEXT (~5%): ${customerSymptomContext.join(', ') || 'N/A'} | HIGH-WEIGHT MECHANIC / TECH OBSERVATIONS: ${mechanicContext.join(', ') || 'N/A'}`;\n",
             r'''    const userPrompt = `Vehicle: ${[resolvedVehicle.year, resolvedVehicle.make, resolvedVehicle.model, resolvedVehicle.trim || resolvedVehicle.engine].filter(Boolean).join(' ') || 'N/A'} | Drivetrain: ${resolvedVehicle.driveType || resolvedVehicle.drivetrain || 'unknown'} | VIN: ${vin || 'N/A'} | Mileage: ${mileage || 'N/A'} | Codes: ${targetCodes.join(', ') || 'None'} | LOW-WEIGHT CUSTOMER SYMPTOM CONTEXT (~5%): ${customerSymptomContext.join(', ') || 'N/A'} | HIGH-WEIGHT MECHANIC / TECH OBSERVATIONS: ${mechanicContext.join(', ') || 'N/A'}\n\nVEHICLE EVIDENCE:\n${JSON.stringify(compactEvidence)}`;
''')
replace_once('src/routes/diagnose.js',
             "        vehicle,\n        completedWork: guardResult.completedWork,\n",
             "        vehicle: resolvedVehicle,\n        completedWork: guardResult.completedWork,\n")
replace_once('src/routes/diagnose.js', r'''    const finalResult = { ...safeResult(), ...parsed };

    res.json({ success: true, result: finalResult, traceLog: { traceId: executionTrace.traceId, logs: executionTrace.logs } });
''', r'''    const finalResult = { ...safeResult(), ...parsed };
    finalResult.knownIssues = relevantTsbs.slice(0, 3).map(x =>
      `TSB candidate: ${x.title || 'Factory service bulletin reference'}${x.url ? ` — ${x.url}` : ''}`
    );
    finalResult.evidence = {
      oem: oemReferences,
      tsbs: relevantTsbs.slice(0, 5),
      sources: compactEvidence.SOURCES,
      available: !!(oemReferences.length || relevantTsbs.length),
      drivetrain: resolvedVehicle.driveType || resolvedVehicle.drivetrain || '',
      warmupStatus: warmupStatus.status
    };

    res.json({ success: true, result: finalResult, traceLog: { traceId: executionTrace.traceId, logs: executionTrace.logs } });
''')

replace_regex('public/index.html', r"        async function decodeVin\(vin, yearEl, makeEl, modelEl, trimEl\) \{[\s\S]*?        \}\n\n        document\.getElementById\('btnDecodeVin'\)", r'''        function storeActiveVehicle(vehicle) {
            window.skskActiveVehicle = vehicle || null;
            try {
                if (vehicle) sessionStorage.setItem('sksk_active_vehicle', JSON.stringify(vehicle));
                else sessionStorage.removeItem('sksk_active_vehicle');
            } catch (_) {}
        }

        function activeVehicleForVin(vin) {
            const wanted = String(vin || '').trim().toUpperCase();
            let vehicle = window.skskActiveVehicle || null;
            if (!vehicle) {
                try { vehicle = JSON.parse(sessionStorage.getItem('sksk_active_vehicle') || 'null'); } catch (_) {}
            }
            if (!vehicle || String(vehicle.vin || '').trim().toUpperCase() !== wanted) return {};
            return vehicle;
        }

        async function decodeVin(vin, yearEl, makeEl, modelEl, trimEl) {
            if (!vin || vin.length !== 17) {
                alert('Enter a valid 17-character VIN first.');
                return;
            }
            try {
                const res = await fetchWithTimeout(`${API_BASE}/api/vehicle/decode`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ vin })
                });
                const data = await readBody(res);
                if (!res.ok || !data.vehicle) throw new Error(data.error || 'No decode result');
                const r = data.vehicle;
                storeActiveVehicle(r);

                if (yearEl) document.getElementById(yearEl).value = r.year || '';
                if (makeEl) document.getElementById(makeEl).value = r.make || '';
                if (modelEl) document.getElementById(modelEl).value = r.model || '';
                if (trimEl) document.getElementById(trimEl).value = [r.trim, r.engineCylinders ? r.engineCylinders + 'cyl' : '', r.engine].filter(Boolean).join(' ');

                let recallCount = 0;
                try {
                    const recallRes = await fetch(`https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(r.make)}&model=${encodeURIComponent(r.model)}&modelYear=${r.year}`);
                    const recallData = await recallRes.json();
                    recallCount = recallData.Count || 0;
                } catch (_) {}

                saveForm();
                alert(`✅ VIN Decoded!\n${r.year} ${r.make} ${r.model}${r.driveType ? ' · ' + r.driveType : ''}\n\n⚠️ Open Recalls: ${recallCount}${recallCount > 0 ? '\nCheck NHTSA.gov for details!' : ''}\n\n📚 Factory/TSB evidence warmup: ${data.evidenceWarmup || 'started'}`);
            } catch (e) {
                alert('VIN decode failed — check the VIN and try again.');
            }
        }

        document.getElementById('btnDecodeVin')''')
replace_once('public/index.html', r'''                    vehicle: {
                        year: parseInt(document.getElementById('vehicleYear').value.trim(), 10) || 2008,
                        make: document.getElementById('vehicleMake').value.trim(),
                        model: document.getElementById('vehicleModel').value.trim(),
                        trim: document.getElementById('vehicleTrim').value.trim()
                    },
''', r'''                    vehicle: {
                        ...activeVehicleForVin(document.getElementById('vin').value.trim()),
                        year: parseInt(document.getElementById('vehicleYear').value.trim(), 10) || activeVehicleForVin(document.getElementById('vin').value.trim()).year || '',
                        make: document.getElementById('vehicleMake').value.trim() || activeVehicleForVin(document.getElementById('vin').value.trim()).make || '',
                        model: document.getElementById('vehicleModel').value.trim() || activeVehicleForVin(document.getElementById('vin').value.trim()).model || '',
                        trim: document.getElementById('vehicleTrim').value.trim() || activeVehicleForVin(document.getElementById('vin').value.trim()).trim || ''
                    },
''')
replace_once('public/index.html', r'''                const payload = {
                    vin: document.getElementById('diagVin').value.trim(),
                    mileage: Number(document.getElementById('diagMileage').value || 0),
''', r'''                const diagVin = document.getElementById('diagVin').value.trim();
                const payload = {
                    vin: diagVin,
                    vehicle: activeVehicleForVin(diagVin),
                    mileage: Number(document.getElementById('diagMileage').value || 0),
''')
replace_once('public/index.html', r'''            try {
                localStorage.removeItem('sksk_form');
            } catch (_) {}
''', r'''            try {
                localStorage.removeItem('sksk_form');
                sessionStorage.removeItem('sksk_active_vehicle');
                window.skskActiveVehicle = null;
            } catch (_) {}
''')

write('scripts/test-evidence-selection.js', r'''const assert = require('assert');
const { selectRelevantTsbs, evidenceContextKey } = require('../src/services/vehicle.evidence');

const context = {
  symptoms: 'clunking noise when accelerator is released and steering is at full lock',
  mechanicNotices: [],
  obdCodes: ['P0300', 'P0171'],
  keywords: ['clunk', 'full steering lock', 'torque reversal', 'driveline']
};

const evidence = {
  tsbs: {
    references: [
      {
        title: 'Engine Controls - Engine Management DTCs P2135 and P2138',
        subject: 'Electronic throttle control correlation',
        snippet: 'Diagnostic information for accelerator position sensor DTC P2135 and P2138.',
        relevanceScore: 24,
        extractedFacts: {}
      },
      {
        title: '2003-2009 Driveline Noise on 4WD Equipped Sorento Models',
        subject: 'Driveline noise on 4WD Sorento',
        snippet: 'Sharp metallic ping or creak through driveshaft and transfer case during Neutral to Drive or Reverse load change.',
        relevanceScore: 28,
        extractedFacts: { symptoms: ['driveline noise'], conditions: ['reverse', 'drive'] }
      }
    ]
  }
};

const selected = selectRelevantTsbs(evidence, context, 12);
assert.equal(selected.length, 1);
assert.ok(selected[0].title.includes('Driveline Noise'));
assert.notEqual(evidenceContextKey({ symptoms: 'clunk' }), evidenceContextKey({ symptoms: 'misfire' }));

const codeContext = { ...context, symptoms: 'accelerator pedal warning', obdCodes: ['P2135'], keywords: [] };
const codeSelected = selectRelevantTsbs(evidence, codeContext, 12);
assert.ok(codeSelected.some(item => item.title.includes('P2135')));

console.log('evidence selection regression: PASS');
''')

write('scripts/test-vehicle-profile-merge.js', r'''const assert = require('assert');
const { mergeVehicleProfile } = require('../src/services/vehicle.warmup');

const merged = mergeVehicleProfile(
  { year: '2008', make: 'KIA', model: 'Sorento', engine: '3.8L', engineCylinders: '6', driveType: '4WD' },
  { year: '2007', make: 'Wrong', model: 'Wrong', trim: 'BL 6cyl 3.8L' },
  'KNDJC736385765089'
);
assert.equal(merged.year, '2008');
assert.equal(merged.make, 'KIA');
assert.equal(merged.model, 'Sorento');
assert.equal(merged.driveType, '4WD');
assert.equal(merged.drivetrain, '4WD');
assert.equal(merged.trim, 'BL 6cyl 3.8L');
console.log('vehicle profile merge regression: PASS');
''')

print('VIN evidence warmup patch applied.')
