#!/usr/bin/env node
/**
 * Every module must load.
 *
 * This exists because `node --check` only parses: a reference to a name that was
 * never imported is a syntax-valid file that throws `ReferenceError` the moment
 * anything imports it — which for `lib/config.mjs` means the plugin does not load
 * at all. That is exactly how a one-line edit during the review broke the plugin,
 * and it was caught by running the loader rather than by checking the syntax.
 *
 * Importing each module evaluates its top-level code, which is where those errors
 * live. Exports are then touched, so a module that loads but forgot to export what
 * its callers import fails here too.
 *
 *   node scripts/test-modules-load.mjs
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', 'lib');

let failures = 0;
const files = (await readdir(libDir)).filter((f) => f.endsWith('.mjs')).sort();
console.log(`  importing ${files.length} modules from lib/`);

for (const file of files) {
  try {
    const module = await import(`../lib/${file}`);
    const exported = Object.keys(module).length;
    if (exported === 0) throw new Error('module exports nothing');
    console.log(`  ✅ ${file.padEnd(20)} ${exported} export(s)`);
  } catch (error) {
    failures += 1;
    console.log(`  ❌ ${file}\n       ${error.message}`);
  }
}

/**
 * Every imported binding must be used.
 *
 * This is the other half of "the module loads": an import that is never called is
 * a fix that was written and never wired — `readConsolidationState` was imported
 * and never invoked during one of these reviews, which left the interval gate
 * exactly as broken as before while the diff looked finished.
 */
for (const file of files) {
  const source = await (await import('node:fs/promises')).readFile(join(libDir, file), 'utf8');
  const unused = [];
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      // One occurrence is the import itself; a second means something uses it.
      if ((source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length < 2) unused.push(name);
    }
  }
  if (unused.length === 0) continue;
  failures += 1;
  console.log(`  ❌ ${file}: imported but never used → ${unused.join(', ')}`);
}

// The plugin entry point is the thing a broken import actually takes down, so it
// is loaded explicitly rather than inferred from the module list.
try {
  const plugin = await import('../lib/index.js');
  if (typeof plugin.apply !== 'function') throw new Error('apply is not exported as a function');
  if (plugin.Config === undefined) throw new Error('Config is not re-exported');
  console.log('  ✅ lib/index.js         apply + Config reachable');
} catch (error) {
  failures += 1;
  console.log(`  ❌ lib/index.js\n       ${error.message}`);
}

console.log(failures === 0
  ? '\n  module loading: all modules load\n'
  : `\n  module loading: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
