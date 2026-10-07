#!/usr/bin/env node
/**
 * Task instruction prefixes, tested at the wire.
 *
 * EmbeddingGemma 2 wants a role-specific instruction in front of the text
 * ("task: search result | query: ..." for queries, "title: none | text: ..." for
 * documents). The plugin sends them from one place — the request builder — and
 * callers only state the role, so this checks the three things that could break
 * silently:
 *
 *   1. the right prefix reaches the wire for each role, and nothing else does;
 *   2. the default stays empty, so a deployment that wants no prefix is unchanged;
 *   3. `embedAdaptive`'s bisection keeps the prefix on BOTH halves — the failure
 *      that would otherwise shrink a long fragment's prefix to one half and leave
 *      the other bare, which no error would ever report.
 *
 * Hermetic: a stub endpoint on an ephemeral port, no model, no network.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { embedBatch, embedAdaptive, probe, resolveConfig } from '../lib/embedder.mjs';
import { Config } from '../lib/config.mjs';
import { MemoryIndex, serializeIndex, deserializeIndex, INDEX_VERSION } from '../lib/store.mjs';

/** Requests the stub saw, in order. */
const seen = [];

/**
 * Inputs longer than this are refused the way llama-server refuses them.
 *
 * The value has to sit above `embedAdaptive`'s 128-character floor for
 * bisecting at all: a stub that refuses texts the real server would accept
 * tests the client's give-up path, not its splitting path.
 */
const TOO_LONG = 200;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    seen.push(payload);
    const texts = Array.isArray(payload.input) ? payload.input : [];
    const tooLong = texts.find((t) => String(t).length > TOO_LONG);
    if (tooLong !== undefined) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'input is too large to process' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: texts.map((_, i) => ({ embedding: [1, 0, i] })) }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;

const QUERY = 'task: search result | query: ';
const DOC = 'title: none | text: ';
const cfg = { url, model: 'stub', queryPrefix: QUERY, docPrefix: DOC };

let failures = 0;
async function check(name, fn) {
  seen.length = 0;
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message ? error.message : String(error)));
  }
}

console.log('task prefixes');

await check('a query gets the query prefix', async () => {
  await embedBatch(['债务红线'], cfg, { purpose: 'query' });
  assert.equal(seen.length, 1, 'one request');
  assert.deepEqual(seen[0].input, [QUERY + '债务红线']);
});

await check('a document gets the document prefix', async () => {
  await embedBatch(['债务红线'], cfg, { purpose: 'doc' });
  assert.deepEqual(seen[0].input, [DOC + '债务红线']);
});

await check('no purpose sends the raw text', async () => {
  await embedBatch(['债务红线'], cfg);
  assert.deepEqual(seen[0].input, ['债务红线']);
});

await check('the roles do not leak into each other', async () => {
  await embedBatch(['a', 'b'], cfg, { purpose: 'query' });
  assert.deepEqual(seen[0].input, [QUERY + 'a', QUERY + 'b']);
  await embedBatch(['a', 'b'], cfg, { purpose: 'doc' });
  assert.deepEqual(seen[1].input, [DOC + 'a', DOC + 'b'], 'the second request is the document one');
  assert.equal(seen.length, 2, 'no extra requests');
});

await check('empty prefixes mean no change at all', async () => {
  await embedBatch(['x'], { url, model: 'stub' }, { purpose: 'doc' });
  assert.deepEqual(seen[0].input, ['x']);
});

await check('the environment supplies both prefixes', async () => {
  const before = { q: process.env.DSH_G_MEMORY_EMBED_QUERY_PREFIX, d: process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX };
  process.env.DSH_G_MEMORY_EMBED_QUERY_PREFIX = 'Q: ';
  process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX = 'D: ';
  try {
    const resolved = resolveConfig();
    assert.equal(resolved.queryPrefix, 'Q: ');
    assert.equal(resolved.docPrefix, 'D: ');
  } finally {
    if (before.q === undefined) delete process.env.DSH_G_MEMORY_EMBED_QUERY_PREFIX;
    else process.env.DSH_G_MEMORY_EMBED_QUERY_PREFIX = before.q;
    if (before.d === undefined) delete process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX;
    else process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX = before.d;
  }
});

await check('an unspecified prefix stays unspecified, so the environment still wins', async () => {
  // The schema used to fill in an empty string for "not configured", which did not mean "no
  // prefix" — it meant "shadow whatever DSH_G_MEMORY_EMBED_*_PREFIX said", so the
  // plugin and every CLI path embedded into different conventions.
  const parsed = Config['~standard'].validate({ embed: { url: 'http://127.0.0.1:1', model: 'stub' } });
  assert.ok(!parsed.issues, 'the composition validates');
  assert.ok(!('queryPrefix' in parsed.value.embed), 'queryPrefix must be absent, not empty');
  assert.ok(!('docPrefix' in parsed.value.embed), 'docPrefix must be absent, not empty');

  const before = process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX;
  process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX = 'FROM-ENV: ';
  try {
    const resolved = resolveConfig(parsed.value.embed);
    assert.equal(resolved.docPrefix, 'FROM-ENV: ', 'the environment supplies the value');
  } finally {
    if (before === undefined) delete process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX;
    else process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX = before;
  }

  // An explicit composition value still wins over the environment.
  const explicit = Config['~standard'].validate({ embed: { docPrefix: 'EXPLICIT: ' } });
  const before2 = process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX;
  process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX = 'FROM-ENV: ';
  try {
    assert.equal(resolveConfig(explicit.value.embed).docPrefix, 'EXPLICIT: ');
  } finally {
    if (before2 === undefined) delete process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX;
    else process.env.DSH_G_MEMORY_EMBED_DOC_PREFIX = before2;
  }
});

await check('an unknown role is an error, not a silent bare embedding', async () => {
  await assert.rejects(
    () => embedBatch(['x'], cfg, { purpose: 'querry' }),
    /unknown embed purpose/,
    'a typo in the role must not degrade to "no prefix"',
  );
});

await check('the index header records the prefixes, and "unknown" differs from "none"', async () => {
  const units = [{ text: 'u', role: 'user', session: 's', seq: 1, time: 1, hash: 'h', vector: Buffer.alloc(3 + 4) }];
  const built = new MemoryIndex({ version: INDEX_VERSION, dim: 3, model: 'stub', queryPrefix: QUERY, docPrefix: DOC, builtAt: 1, units });
  const reread = deserializeIndex(serializeIndex(built));
  assert.equal(reread.data.queryPrefix, QUERY);
  assert.equal(reread.data.docPrefix, DOC);

  // An index written before the fields existed means "no prefix", not "unknown".
  const serialized = serializeIndex(built).split('\n');
  const header = JSON.parse(serialized[0]);
  delete header.queryPrefix;
  delete header.docPrefix;
  const legacy = deserializeIndex([JSON.stringify(header), ...serialized.slice(1)].join('\n'));
  assert.equal(legacy.data.docPrefix, undefined, 'a missing field means "unknown", not "empty"');
  assert.equal(legacy.data.queryPrefix, undefined);
  // ...and an index that genuinely recorded the no-prefix convention says so.
  const explicit = { ...JSON.parse(serialized[0]), queryPrefix: '', docPrefix: '' };
  const none = deserializeIndex([JSON.stringify(explicit), ...serialized.slice(1)].join('\n'));
  assert.equal(none.data.docPrefix, '', 'a recorded empty prefix stays empty');
  assert.notEqual(none.data.docPrefix, legacy.data.docPrefix, 'the two states must be distinguishable');
});

await check('bisection keeps the prefix on both halves', async () => {
  // Longer than embedAdaptive's 128-character floor for bisecting at all.
  const long = 'x'.repeat(400);
  const vector = await embedAdaptive(long, cfg, { purpose: 'doc' });
  assert.equal(vector.length, 3, 'a vector came back');
  const halves = seen.filter((p) => p.input.some((t) => String(t).length <= TOO_LONG + DOC.length));
  assert.ok(halves.length >= 2, 'the text was split into at least two halves');
  for (const request of halves) {
    for (const text of request.input) {
      assert.ok(String(text).startsWith(DOC), 'every half carries the prefix: ' + String(text).slice(0, 20));
    }
  }
});

await check('the probe sends no prefix', async () => {
  const result = await probe(cfg);
  assert.equal(result.ok, true);
  assert.deepEqual(seen[0].input, ['dimension probe']);
});

server.close();
console.log(failures === 0 ? 'result   PASS' : 'result   FAIL (' + failures + ')');
process.exitCode = failures === 0 ? 0 : 1;
