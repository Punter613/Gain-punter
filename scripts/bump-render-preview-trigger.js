'use strict';

const fs = require('fs');
const path = require('path');

const triggerPath = path.join(__dirname, '..', 'api', '.render-preview-trigger');
const reason = process.argv.slice(2).join(' ').trim() || 'backend runtime change';
const stamp = new Date().toISOString();

fs.writeFileSync(triggerPath, `Render preview trigger\nreason: ${reason}\nupdated: ${stamp}\n`);
console.log(`Updated ${path.relative(process.cwd(), triggerPath)} for Render PR preview generation.`);
