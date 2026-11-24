#!/usr/bin/env node
// Validates directories/data/directories.json against the rules in schema.json. Node 18+, no dependencies.
// Usage: node directories/scripts/validate.mjs [path/to/directories.json]
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'data/directories.json');
const schema = JSON.parse(readFileSync(resolve(root, 'data/schema.json'), 'utf8'));
const item = schema.items;

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`✗ ${file}: ${e.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const today = new Date().toISOString().slice(0, 10);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function checkValue(where, value, rule) {
  if (rule.enum) {
    if (!rule.enum.includes(value)) errors.push(`${where}: ${JSON.stringify(value)} is not one of ${rule.enum.map((x) => JSON.stringify(x)).join(', ')}`);
    return;
  }
  const types = [].concat(rule.type);
  if (!types.includes(typeOf(value))) {
    errors.push(`${where}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
    return;
  }
  if (typeof value === 'string') {
    if (rule.minLength && value.length < rule.minLength) errors.push(`${where}: empty`);
    if (rule.maxLength && value.length > rule.maxLength) errors.push(`${where}: longer than ${rule.maxLength} characters`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${where}: ${JSON.stringify(value)} does not match ${rule.pattern}`);
    if (rule.format === 'uri') {
      try { new URL(value); } catch { errors.push(`${where}: not a valid URL`); }
    }
  }
  if (Array.isArray(value)) {
    if (rule.minItems && value.length < rule.minItems) errors.push(`${where}: needs at least ${rule.minItems} item(s)`);
    if (rule.maxItems && value.length > rule.maxItems) errors.push(`${where}: at most ${rule.maxItems} items`);
    value.forEach((v, i) => checkValue(`${where}[${i}]`, v, rule.items));
  }
}

if (!Array.isArray(data)) {
  errors.push('top level must be an array');
} else {
  const slugs = new Set();
  const domains = new Map();
  data.forEach((entry, i) => {
    const at = `[${i}] ${entry?.slug ?? '?'}`;
    if (typeOf(entry) !== 'object') return errors.push(`${at}: not an object`);
    for (const key of item.required) if (!(key in entry)) errors.push(`${at}: missing ${key}`);
    for (const key of Object.keys(entry)) {
      if (!item.properties[key]) errors.push(`${at}: unknown field ${key}`);
      else checkValue(`${at}.${key}`, entry[key], item.properties[key]);
    }
    if (slugs.has(entry.slug)) errors.push(`${at}: duplicate slug`);
    slugs.add(entry.slug);
    for (const d of entry.referrer_domains ?? []) {
      if (d.startsWith('www.')) errors.push(`${at}: referrer domain ${d} must not start with www.`);
      if (domains.has(d)) errors.push(`${at}: referrer domain ${d} is also claimed by ${domains.get(d)}`);
      domains.set(d, entry.slug);
    }
    // Rules the JSON Schema cannot express.
    if (entry.status === 'verified') {
      if (!entry.last_checked) errors.push(`${at}: verified needs a last_checked date`);
      if (!entry.check_source) errors.push(`${at}: verified needs a check_source`);
    }
    if (entry.last_checked) {
      const d = new Date(`${entry.last_checked}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== entry.last_checked) errors.push(`${at}: last_checked is not a real date`);
      else if (entry.last_checked > today) errors.push(`${at}: last_checked is in the future`);
      else if ((Date.now() - d.getTime()) / 864e5 > 180) warnings.push(`${at}: last checked more than 180 days ago`);
    }
    if (entry.pricing && entry.pricing !== 'free' && !entry.price_note) warnings.push(`${at}: ${entry.pricing} without a price_note`);
    const sentences = (entry.how_it_works ?? '').split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (sentences < 2 || sentences > 3) warnings.push(`${at}: how_it_works has ${sentences} sentences (aim for 2-3)`);
  });
}

for (const w of warnings) console.warn(`! ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n${errors.length} error(s) in ${file}`);
  process.exit(1);
}
const n = data.length;
const v = data.filter((e) => e.status === 'verified').length;
console.log(`✓ ${n} entries valid (${v} verified, ${n - v} unverified), ${warnings.length} warning(s)`);
