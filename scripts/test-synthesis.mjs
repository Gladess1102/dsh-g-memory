#!/usr/bin/env node
/**
 * Smoke-test the synthesis layer against whatever endpoint is configured.
 *
 * This is a manual diagnostic, not part of `npm test`: it makes a real network
 * request and therefore sends the candidate text to the configured endpoint. It
 * refuses to run unless `DSH_G_MEMORY_LLM_URL` is set, for that reason.
 *
 * The candidates come from the live index by default, so the check never depends
 * on files that exist only on the author's machine.
 *
 * Usage:
 *   node scripts/test-synthesis.mjs [--query "..."] [--index DIR] [--candidates FILE]
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile } from 'node:fs/promises';
import { synthesize, resolveApiKey, redact, defaultSynthesisConfig } from '../lib/synthesize.mjs';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { embedBatch, resolveConfig } from '../lib/embedder.mjs';

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const next = args[i + 1];
  // A missing value used to come back as `undefined` — silently replacing a
  // deliberate default with nothing. A flag is not a value either.
  if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
  return next;
}

const query = argOf('--query', 'what is the physical batch limit of the embedding server?');
const indexDir = argOf('--index', defaultIndexDir());
const candidatesFile = argOf('--candidates', undefined);

console.log('─'.repeat(70));
console.log('synthesis smoke test');
console.log('─'.repeat(70));

const synthesisDefaults = defaultSynthesisConfig();
if (!String(synthesisDefaults.baseUrl || '').trim()) {
  console.error('DSH_G_MEMORY_LLM_URL is not set, so synthesis is disabled by design.');
  console.error('Set it to an endpoint you are willing to send session text to, then re-run.');
  process.exitCode = 1;
  process.exit();
}
console.log(`endpoint: ${synthesisDefaults.baseUrl}`);
console.log(`model:    ${synthesisDefaults.model}`);

const key = await resolveApiKey('OPENCODE_GO_API_KEY');
// The length is enough to tell "found" from "not found". Never print any part of
// the value: this output lands in terminals, logs and bug reports.
console.log(`API key:  ${key ? `found (${key.length} chars)` : 'MISSING'}`);

/**
 * Candidate sources, best first: an explicit file, then the live index, then a
 * built-in sample. The built-in sample is deliberately self-contained so the
 * script can be exercised with no index at all.
 */
let candidates = [];
let source = 'built-in sample';
if (candidatesFile !== undefined) {
  const saved = JSON.parse(await readFile(candidatesFile, 'utf8'));
  const entry = Array.isArray(saved) ? saved[0] : saved;
  candidates = (entry.candidates || []).slice(0, 12).map((c) => ({ role: 'assistant', when: '', text: c.text }));
  source = candidatesFile;
} else {
  try {
    const index = await readIndex(indexDir);
    const [vector] = await embedBatch([query], resolveConfig());
    candidates = index
      .recall(prepareQueryVector(vector), query, { k: 8 })
      .map(({ index: i }) => {
        const unit = index.unit(i);
        return { role: unit.role, when: unit.time ? new Date(unit.time).toISOString() : '', text: unit.text };
      });
    source = `live index at ${indexDir}`;
  } catch (error) {
    console.log(`live index unavailable (${error.message}); using the built-in sample`);
  }
}

if (candidates.length === 0) {
  candidates = [
    { role: 'assistant', when: '', text: 'The embedding server rejects input over 512 tokens with HTTP 500 rather than truncating it.' },
    { role: 'tool', when: '', text: 'Error: input (521 tokens) is too large to process. increase the physical batch size (current batch size: 512)' },
  ];
}

console.log(`candidates: ${candidates.length} (${source})`);
for (const c of candidates.slice(0, 5)) {
  console.log(`  [${c.role}] ${c.text.slice(0, 90).replace(/\s+/g, ' ')}`);
}

console.log('\ncalling synthesis…');
const started = Date.now();
const result = await synthesize(query, candidates);
console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (!result.ok) {
  console.error(`\nFAILED: ${result.reason}`);
  process.exitCode = 1;
} else {
  console.log(`model: ${result.model}`);
  console.log('\nresult:');
  console.log('─'.repeat(70));
  console.log(redact(result.text));
  console.log('─'.repeat(70));
}
