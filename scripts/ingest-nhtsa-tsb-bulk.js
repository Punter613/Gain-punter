#!/usr/bin/env node
/**
 * NHTSA bulk TSB ingestion.
 *
 * Downloads NHTSA's official Manufacturer Communications (TSB) bulk flat
 * files, parses them, and upserts into vehicle_tsb_corpus. This is a
 * batch/offline job — NOT called from any live route. Run manually or on
 * a periodic schedule (e.g. monthly GitHub Action), not per-request.
 *
 * Data source verified directly against NHTSA's own schema doc
 * (https://static.nhtsa.gov/odi/ffdd/tsbs/TSBS.txt) and cross-checked
 * against real sample rows before building this mapping — not guessed
 * from field position alone.
 *
 * Field layout (14 tab-separated columns per row):
 *   1  NHTSA ID Number
 *   2  Replacement Service Bulletin Number (deprecated, often empty)
 *   3  Date Added to File
 *   4  TSB/Document ID              -> bulletin_number
 *   5  Mfr Communication Date       -> bulletin_date
 *   6  Mfr Internal Campaign ID
 *   7  Communication Type
 *   8  Make                         -> make
 *   9  Model                        -> model
 *   10 Model Year (9999 = unknown)  -> year
 *   11 NHTSA Components             -> group_name
 *   12 Mfr Component System
 *   13 Mfr Component Subsystem
 *   14 Summary                      -> body_text
 *
 * IMPORTANT: buildVehicleCacheKey() (used elsewhere for LEMON-sourced
 * rows) requires engine/drivetrain to build a specific key. NHTSA's bulk
 * data has no trim/engine granularity, so NHTSA rows use a coarser
 * vehicle_key format: nhtsa|{year}|{make}|{model}. Future lookups against
 * NHTSA-sourced rows should query the year/make/model columns directly
 * (see migration 008's index) rather than expect an exact vehicle_key
 * match against a LEMON-style key.
 *
 * The TSV can legitimately contain multiple rows for the same NHTSA ID
 * (one per product/component combination per NHTSA's own docs), so
 * source_url includes a row index to stay unique per
 * (vehicle_key, source_url), not just per NHTSA ID.
 *
 * Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ingest-nhtsa-tsb-bulk.js
 * Optional: NHTSA_TSB_CHUNKS=2020-2024,2025-2026 to limit to specific chunks (comma-separated year ranges).
 */

const axios = require('axios');
const AdmZip = require('adm-zip');
const { supabase } = require('../src/db');

const BASE_URL = 'https://static.nhtsa.gov/odi/ffdd/tsbs/';
const ALL_CHUNKS = [
  '1995-1999', '2000-2004', '2005-2009', '2010-2014',
  '2015-2019', '2020-2024', '2025-2026'
];

const BATCH_SIZE = 500;

function selectedChunks() {
  const filter = (process.env.NHTSA_TSB_CHUNKS || '').trim();
  if (!filter) return ALL_CHUNKS;
  const wanted = new Set(filter.split(',').map(s => s.trim()));
  return ALL_CHUNKS.filter(c => wanted.has(c));
}

function buildNhtsaVehicleKey(year, make, model) {
  return ['nhtsa', year, make, model]
    .map(v => String(v || '').toLowerCase().trim().replace(/\s+/g, '-'))
    .join('|');
}

function formatDate(yyyymmdd) {
  const s = String(yyyymmdd || '').trim();
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function parseRow(fields, rowIndex) {
  const [
    nhtsaId, , , tsbDocId, mfrCommDate, , commType,
    make, model, modelYear, components, , , summary
  ] = fields;

  const year = modelYear === '9999' ? null : parseInt(modelYear, 10) || null;
  const makeClean = String(make || '').trim();
  const modelClean = String(model || '').trim();

  if (!makeClean || !modelClean || !summary) return null; // skip unusable rows

  return {
    vehicle_key: buildNhtsaVehicleKey(year, makeClean, modelClean),
    year,
    make: makeClean,
    model: modelClean,
    trim: null,
    engine: null,
    title: `${commType || 'TSB'}: ${makeClean} ${modelClean}${year ? ' ' + year : ''}`.trim(),
    source_url: `nhtsa://tsb/${nhtsaId}/${rowIndex}`,
    bulletin_number: tsbDocId || null,
    bulletin_date: formatDate(mfrCommDate),
    group_name: components || null,
    subject: components || null,
    body_text: summary || null,
    headings: [],
    extracted_facts: {},
    source: 'NHTSA_BULK'
  };
}

function parseTsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length < 14) continue; // malformed line, skip
    const row = parseRow(fields, i);
    if (row) rows.push(row);
  }
  return rows;
}

async function upsertBatch(rows) {
  const { error } = await supabase
    .from('vehicle_tsb_corpus')
    .upsert(rows, { onConflict: 'vehicle_key,source_url' });
  if (error) throw error;
}

async function ingestChunk(chunkLabel) {
  const url = `${BASE_URL}TSBS_RECEIVED_${chunkLabel}.zip`;
  console.log(`\n=== ${chunkLabel} ===`);
  console.log(`Downloading ${url}`);

  const started = Date.now();
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
  console.log(`Downloaded ${(response.data.length / 1024 / 1024).toFixed(1)} MB in ${Date.now() - started}ms`);

  const zip = new AdmZip(Buffer.from(response.data));
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  if (entries.length === 0) throw new Error('Zip contained no files');

  const textEntry = entries.find(e => /\.(txt|csv)$/i.test(e.entryName)) || entries[0];
  const text = textEntry.getData().toString('utf8');
  console.log(`Extracted ${textEntry.entryName} (${(text.length / 1024 / 1024).toFixed(1)} MB text)`);

  const rows = parseTsv(text);
  console.log(`Parsed ${rows.length.toLocaleString()} usable rows`);

  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await upsertBatch(batch);
    upserted += batch.length;
    process.stdout.write(`\rUpserted ${upserted.toLocaleString()} / ${rows.length.toLocaleString()}`);
  }
  console.log('');

  return { chunkLabel, rowsParsed: rows.length, rowsUpserted: upserted };
}

(async () => {
  if (!supabase) {
    console.error('Supabase not configured (need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY). Aborting.');
    process.exit(1);
  }

  const chunks = selectedChunks();
  console.log(`Ingesting ${chunks.length} chunk(s): ${chunks.join(', ')}`);

  const results = [];
  for (const chunk of chunks) {
    try {
      results.push(await ingestChunk(chunk));
    } catch (err) {
      console.error(`\n[${chunk}] FAILED: ${err.message}`);
      results.push({ chunkLabel: chunk, error: err.message });
    }
  }

  console.log('\n\n=== SUMMARY ===');
  let totalUpserted = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`${r.chunkLabel}: FAILED - ${r.error}`);
    } else {
      console.log(`${r.chunkLabel}: ${r.rowsUpserted.toLocaleString()} rows upserted`);
      totalUpserted += r.rowsUpserted;
    }
  }
  console.log(`\nTotal rows upserted: ${totalUpserted.toLocaleString()}`);
})();
