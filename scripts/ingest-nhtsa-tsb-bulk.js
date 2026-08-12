#!/usr/bin/env node
/**
 * NHTSA bulk TSB ingestion.
 *
 * Downloads NHTSA's official Manufacturer Communications (TSB) bulk flat
 * files, parses them, optionally filters to a specific vehicle, and upserts
 * into vehicle_tsb_corpus. This is a batch/offline job — NOT called from any
 * live route. Run manually or on a periodic schedule, not per-request.
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

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function vehicleFilter() {
  const rawYear = String(process.env.NHTSA_TSB_YEAR || '').trim();
  return {
    year: rawYear ? parseInt(rawYear, 10) : null,
    make: normalize(process.env.NHTSA_TSB_MAKE),
    model: normalize(process.env.NHTSA_TSB_MODEL)
  };
}

function matchesVehicleFilter(row, filter) {
  if (filter.year && row.year !== filter.year) return false;
  if (filter.make && normalize(row.make) !== filter.make) return false;
  if (filter.model && normalize(row.model) !== filter.model) return false;
  return true;
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

  if (!makeClean || !modelClean || !summary) return null;

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

function parseTsv(text, filter) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length < 14) continue;
    const row = parseRow(fields, i);
    if (row && matchesVehicleFilter(row, filter)) rows.push(row);
  }
  return rows;
}

function describeError(err) {
  const cause = err?.cause;
  return {
    name: err?.name,
    message: err?.message,
    code: err?.code,
    details: err?.details,
    hint: err?.hint,
    cause: cause ? {
      name: cause?.name,
      message: cause?.message,
      code: cause?.code,
      errno: cause?.errno,
      syscall: cause?.syscall,
      address: cause?.address,
      port: cause?.port
    } : undefined,
    stack: err?.stack
  };
}

async function upsertBatch(rows, startIndex) {
  try {
    const { error } = await supabase
      .from('vehicle_tsb_corpus')
      .upsert(rows, { onConflict: 'vehicle_key,source_url' });

    if (error) {
      console.error(`\n[NHTSA Upsert] Supabase error at batch starting row ${startIndex}:`, describeError(error));
      throw error;
    }
  } catch (err) {
    console.error(`\n[NHTSA Upsert] Transport/request failure at batch starting row ${startIndex}:`, describeError(err));
    throw err;
  }
}

async function ingestChunk(chunkLabel, filter) {
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

  const rows = parseTsv(text, filter);
  console.log(`Matched ${rows.length.toLocaleString()} usable rows after vehicle filtering`);

  if (rows.length === 0) {
    console.log('No matching rows; nothing to upsert for this chunk.');
    return { chunkLabel, rowsParsed: 0, rowsUpserted: 0 };
  }

  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await upsertBatch(batch, i);
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
  if (chunks.length === 0) {
    console.error('No valid NHTSA chunks selected.');
    process.exit(1);
  }

  const filter = vehicleFilter();
  if (String(process.env.NHTSA_TSB_YEAR || '').trim() && !filter.year) {
    console.error(`Invalid NHTSA_TSB_YEAR: ${process.env.NHTSA_TSB_YEAR}`);
    process.exit(1);
  }

  console.log(`Ingesting ${chunks.length} chunk(s): ${chunks.join(', ')}`);
  console.log('Vehicle filter:', {
    year: filter.year || 'ALL',
    make: filter.make || 'ALL',
    model: filter.model || 'ALL'
  });

  const results = [];
  let hadFailure = false;

  for (const chunk of chunks) {
    try {
      results.push(await ingestChunk(chunk, filter));
    } catch (err) {
      hadFailure = true;
      console.error(`\n[${chunk}] FAILED:`, describeError(err));
      results.push({ chunkLabel: chunk, error: err?.message || String(err) });
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

  if (hadFailure) {
    console.error('\nOne or more requested NHTSA chunks failed; marking ingestion unsuccessful.');
    process.exitCode = 1;
  }
})();
