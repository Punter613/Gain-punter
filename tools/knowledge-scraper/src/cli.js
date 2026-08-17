#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { createClient } = require('@supabase/supabase-js');

const NHTSA_BASE = 'https://static.nhtsa.gov/odi/ffdd/tsbs/';
const ALL_CHUNKS = ['1995-1999','2000-2004','2005-2009','2010-2014','2015-2019','2020-2024','2025-2026'];
const DEFAULT_OUT = path.resolve(process.env.SCRAPER_OUT_DIR || path.join(__dirname, '..', 'out'));
const BATCH_SIZE = 500;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function has(name) { return process.argv.includes(`--${name}`); }
function clean(v) { return String(v ?? '').trim(); }
function norm(v) { return clean(v).toLowerCase().replace(/\s+/g, ' '); }
function keyPart(v) { return norm(v).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function sha256(v) { return crypto.createHash('sha256').update(v).digest('hex'); }
function dateFromYmd(v) {
  const s = clean(v);
  return /^\d{8}$/.test(s) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : null;
}

function parseArgs() {
  const chunks = clean(arg('chunks', '')).split(',').map(clean).filter(Boolean);
  const sink = clean(arg('sink', 'local')).toLowerCase();
  if (!['local','supabase','both'].includes(sink)) throw new Error('--sink must be local, supabase, or both');
  return {
    seed: arg('seed'),
    year: Number(arg('year')) || null,
    make: clean(arg('make')),
    model: clean(arg('model')),
    chunks: chunks.length ? ALL_CHUNKS.filter(c => chunks.includes(c)) : ALL_CHUNKS,
    sink,
    outDir: path.resolve(arg('out', DEFAULT_OUT)),
    dryRun: has('dry-run'),
    limit: Math.max(0, Number(arg('limit')) || 0)
  };
}

function loadTargets(opts) {
  const targets = [];
  if (opts.seed) {
    const p = path.resolve(opts.seed);
    const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const item of rows) {
      for (const year of item.years || []) targets.push({ year: Number(year), make: norm(item.make), model: norm(item.model) });
    }
  }
  if (opts.year || opts.make || opts.model) targets.push({ year: opts.year, make: norm(opts.make), model: norm(opts.model) });
  return targets;
}

function matchesTarget(row, targets) {
  if (!targets.length) return true;
  return targets.some(t =>
    (!t.year || t.year === row.year) &&
    (!t.make || t.make === norm(row.make)) &&
    (!t.model || t.model === norm(row.model))
  );
}

function normalizeTsb(fields, rowIndex) {
  const [nhtsaId, , , tsbDocId, mfrCommDate, , commType, make, model, modelYear, components, , , summary] = fields;
  const year = clean(modelYear) === '9999' ? null : Number(modelYear) || null;
  const makeClean = clean(make);
  const modelClean = clean(model);
  const body = clean(summary);
  if (!makeClean || !modelClean || !body) return null;

  const sourceUrl = `nhtsa://tsb/${clean(nhtsaId)}/${rowIndex}`;
  const canonical = [year, norm(makeClean), norm(modelClean), clean(tsbDocId), dateFromYmd(mfrCommDate), body].join('|');
  return {
    schema_version: 1,
    corpus_type: 'TSB',
    fingerprint: sha256(canonical),
    vehicle_key: ['nhtsa', year || 'all', keyPart(makeClean), keyPart(modelClean)].join('|'),
    year,
    make: makeClean,
    model: modelClean,
    trim: null,
    engine: null,
    title: `${clean(commType) || 'TSB'}: ${makeClean} ${modelClean}${year ? ` ${year}` : ''}`,
    source_url: sourceUrl,
    bulletin_number: clean(tsbDocId) || null,
    bulletin_date: dateFromYmd(mfrCommDate),
    group_name: clean(components) || null,
    subject: clean(components) || null,
    body_text: body,
    headings: [],
    extracted_facts: {},
    source: 'NHTSA_BULK',
    provenance: {
      authority: 'NHTSA',
      sourceType: 'manufacturer_communication_bulk',
      sourceUrl,
      collectedAt: new Date().toISOString()
    }
  };
}

function parseBuffer(buffer, targets, limit) {
  const byFingerprint = new Map();
  let start = 0;
  let rowIndex = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(0x0A, start);
    if (end === -1) end = buffer.length;
    let lineEnd = end;
    if (lineEnd > start && buffer[lineEnd - 1] === 0x0D) lineEnd--;
    if (lineEnd > start) {
      const fields = buffer.toString('utf8', start, lineEnd).split('\t');
      if (fields.length >= 14) {
        const row = normalizeTsb(fields, rowIndex);
        if (row && matchesTarget(row, targets)) {
          byFingerprint.set(row.fingerprint, row);
          if (limit && byFingerprint.size >= limit) break;
        }
      }
    }
    rowIndex++;
    start = end + 1;
  }
  return [...byFingerprint.values()];
}

function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Supabase sink requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function toExistingCorpusRow(row) {
  return {
    vehicle_key: row.vehicle_key,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim,
    engine: row.engine,
    title: row.title,
    source_url: row.source_url,
    bulletin_number: row.bulletin_number,
    bulletin_date: row.bulletin_date,
    group_name: row.group_name,
    subject: row.subject,
    body_text: row.body_text,
    headings: row.headings,
    extracted_facts: { ...row.extracted_facts, scraperFingerprint: row.fingerprint, provenance: row.provenance },
    source: row.source
  };
}

async function writeSupabase(rows, client) {
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map(toExistingCorpusRow);
    const { error } = await client.from('vehicle_tsb_corpus').upsert(batch, { onConflict: 'vehicle_key,source_url' });
    if (error) throw error;
    written += batch.length;
    process.stdout.write(`\rSupabase ${written}/${rows.length}`);
  }
  if (rows.length) process.stdout.write('\n');
}

function writeJsonl(rows, outDir, chunk) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `nhtsa-tsb-${chunk}.jsonl`);
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return file;
}

async function scrapeChunk(chunk, targets, opts, client) {
  const url = `${NHTSA_BASE}TSBS_RECEIVED_${chunk}.zip`;
  console.log(`\n[${chunk}] ${url}`);
  const started = Date.now();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`NHTSA ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  console.log(`Downloaded ${(bytes.length / 1024 / 1024).toFixed(1)} MB in ${Date.now() - started}ms`);
  const zip = new AdmZip(bytes);
  const entry = zip.getEntries().find(e => !e.isDirectory && /\.(txt|csv)$/i.test(e.entryName)) || zip.getEntries().find(e => !e.isDirectory);
  if (!entry) throw new Error('NHTSA zip contained no data file');
  const rows = parseBuffer(entry.getData(), targets, opts.limit);
  console.log(`Normalized ${rows.length.toLocaleString()} unique matching records`);

  const localFile = ['local','both'].includes(opts.sink) && !opts.dryRun ? writeJsonl(rows, opts.outDir, chunk) : null;
  if (localFile) console.log(`Wrote ${localFile}`);
  if (['supabase','both'].includes(opts.sink) && !opts.dryRun) await writeSupabase(rows, client);
  return { chunk, count: rows.length, localFile };
}

(async function main() {
  try {
    const opts = parseArgs();
    const targets = loadTargets(opts);
    if (!opts.chunks.length) throw new Error('No valid chunks selected');
    console.log('SKSK standalone knowledge scraper');
    console.log(`Sink: ${opts.sink}${opts.dryRun ? ' (dry-run)' : ''}`);
    console.log(`Targets: ${targets.length ? targets.length : 'ALL NHTSA vehicles'}`);
    console.log('Principle: collect once -> normalize once -> store -> reuse');

    const client = ['supabase','both'].includes(opts.sink) && !opts.dryRun ? supabaseClient() : null;
    const results = [];
    for (const chunk of opts.chunks) results.push(await scrapeChunk(chunk, targets, opts, client));
    const total = results.reduce((n, r) => n + r.count, 0);
    console.log(`\nDone. ${total.toLocaleString()} normalized records across ${results.length} chunk(s).`);
  } catch (err) {
    console.error('[knowledge-scraper] FAILED:', err?.message || err);
    process.exitCode = 1;
  }
})();
