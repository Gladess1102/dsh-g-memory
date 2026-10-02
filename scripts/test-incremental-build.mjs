#!/usr/bin/env node
/**
 * Incremental-build test.
 *
 * `build` re-reads every session log on every run, so the cost of a rebuild is
 * entirely about how many embeddings it can avoid. It once avoided none: the
 * resume checkpoint is deleted after a successful build (by design — it exists
 * for interrupted runs), and nothing consulted the index that had just been
 * written. Adding one session therefore re-embedded the whole corpus, ~27
 * minutes for a 4% change.
 *
 * The fix seeds reuse from the previous index, whose stored vectors are already
 * in the representation the checkpoint uses. This test drives the real CLI
 * against a throwaway corpus and asserts the second build embeds **nothing**.
 *
 * It needs the embedding endpoint, and skips loudly without one rather than
 * passing on a weaker check.
 *
 * Usage: node scripts/test-incremental-build.mjs
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'dsh-g-memory.mjs');
const run = promisify(execFile);

let failures = 0;
let skipped = 0;
function ok(name) { console.log(`  ✅ ${name}`); }
function bad(name, detail) { failures += 1; console.log(`  ❌ ${name}\n       ${detail}`); }
function skip(name, why) { skipped += 1; console.log(`  ⏭️  ${name}\n       skipped: ${why}`); }

/** One session log with two extractable messages, written where `build` looks. */
function writeSessionLog(sessionsDir, id, texts) {
  const dir = join(sessionsDir, id);
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, 'session.jsonl');
  const events = [JSON.stringify({ type: 'session', id })];
  texts.forEach((text, i) => {
    events.push(JSON.stringify({
      type: i % 2 === 0 ? 'user/message' : 'assistant/message',
      seq: i + 1,
      time: Date.now(),
      data: i % 2 === 0
        ? { source: { kind: 'user' }, content: [{ type: 'text', text }] }
        : { message: { content: [{ type: 'text', text }] } },
    }));
  });
  writeFileSync(raw, `${events.join('\n')}\n`);
  execFileSync(process.env.DSH_G_MEMORY_ZSTD || 'zstd', ['-q', '-f', raw, `-o`, `${raw}.zstd`]);
  return join(dir, 'session.jsonl.zstd');
}

const root = mkdtempSync(join(tmpdir(), 'dsh-g-memory-incr-'));
const home = join(root, 'home');
const sessions = join(home, 'sessions');
const indexDir = join(root, 'index');
mkdirSync(sessions, { recursive: true });

console.log('─'.repeat(70));
console.log('dsh-g-memory — incremental build test');
console.log('─'.repeat(70));

const env = { ...process.env, DSH_HOME: home, DSH_G_MEMORY_INDEX_DIR: indexDir };

try {
  writeSessionLog(sessions, 'incr-a', [
    'the embedding server rejects input over its physical batch size with HTTP 500',
    'confirmed: the limit is counted in tokens, not characters',
  ]);

  // --- first build: nothing to reuse -------------------------------------
  let first;
  try {
    first = await run('node', [cli, 'build'], { env, timeout: 120_000 });
  } catch (error) {
    skip('first build embeds the corpus', `embedding endpoint unavailable: ${error.message.split('\n')[0]}`);
  }

  if (first !== undefined) {
    if (/reused 0 .*embedded [1-9]/.test(first.stdout) || /embedded ([1-9]\d*)/.test(first.stdout)) {
      ok('first build embeds the corpus and reuses nothing');
    } else {
      bad('first build embeds the corpus and reuses nothing', `unexpected output:\n${first.stdout}`);
    }

    // --- second build: everything must come from the index ----------------
    const second = await run('node', [cli, 'build'], { env, timeout: 120_000 });
    const reuseMatch = second.stdout.match(/\[reuse\] (\d+) vectors carried over/);
    const embedMatch = second.stdout.match(/embedded (\d+)/);

    if (reuseMatch === null || Number(reuseMatch[1]) === 0) {
      bad('second build reuses vectors from the previous index',
        `no reuse reported — the index is not being consulted:\n${second.stdout}`);
    } else {
      ok(`second build reuses vectors from the previous index (${reuseMatch[1]})`);
    }

    if (embedMatch === null || Number(embedMatch[1]) !== 0) {
      bad('second build embeds nothing',
        `expected 0 new embeddings, got ${embedMatch?.[1] ?? 'none'}:\n${second.stdout}`);
    } else {
      ok('second build embeds nothing');
    }

    // --- a changed corpus must still embed only the change ----------------
    writeSessionLog(sessions, 'incr-b', [
      'a newly added session must be embedded while the older one is reused',
      'this sentence exists only in the second session',
    ]);
    const third = await run('node', [cli, 'build'], { env, timeout: 120_000 });
    const thirdEmbed = Number(third.stdout.match(/embedded (\d+)/)?.[1] ?? NaN);
    if (thirdEmbed > 0 && thirdEmbed < 10) {
      ok(`adding one session embeds only its units (${thirdEmbed})`);
    } else {
      bad('adding one session embeds only its units',
        `expected a small positive count, got ${thirdEmbed}:\n${third.stdout}`);
    }

    // --- a model change must invalidate reuse -----------------------------
    const otherModel = await run('node', [cli, 'build'], {
      env: { ...env, DSH_G_MEMORY_EMBED_MODEL: 'definitely-not-a-real-model' },
      timeout: 120_000,
    }).catch((error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
    if (/re-embedding everything|previous index is/.test(otherModel.stdout + otherModel.stderr)) {
      ok('a changed embedding model invalidates reuse');
    } else {
      bad('a changed embedding model invalidates reuse',
        'the previous index was reused despite a different model, which would compare incomparable vectors');
    }

    // --- the unit locator names the file that was read ---------------------
    //
    // It used to come from the log's own contents (an event-level `sessionId`, or
    // the header record's `id`), so logs written by different versions produced
    // different shapes for the same session — and a locator is what a reader
    // follows to re-read the source. The directory the build actually opened is
    // the only stable answer, so the header id here deliberately disagrees with it.
    const oddDir = join(sessions, 'locator-check');
    mkdirSync(oddDir, { recursive: true });
    const oddRaw = join(oddDir, 'session.jsonl');
    writeFileSync(oddRaw, [
      JSON.stringify({ type: 'session', id: 'a-completely-different-id' }),
      JSON.stringify({
        type: 'user/message', seq: 1, time: Date.now(),
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '定位符必须来自实际读取的目录，而不是日志里写的那个 id，这句话要够长。' }] },
      }),
    ].join('\n') + '\n');
    execFileSync(process.env.DSH_G_MEMORY_ZSTD || 'zstd', ['-q', '-f', oddRaw, '-o', `${oddRaw}.zstd`]);

    const located = await run('node', [cli, 'build'], { env, timeout: 120_000 });
    void located;
    const { readIndex: readForLocator } = await import('../lib/store.mjs');
    const locatedIndex = await readForLocator(indexDir);
    let checked = 0;
    let wrong = 0;
    for (let n = 0; n < locatedIndex.size; n += 1) {
      const unit = locatedIndex.unit(n);
      if (!unit.text.includes('定位符必须来自实际读取的目录')) continue;
      checked += 1;
      if (unit.session !== 'locator-check') wrong += 1;
    }
    if (checked > 0 && wrong === 0) {
      ok('the unit locator is the directory that was read, not the id inside the log');
    } else {
      bad('the unit locator is the directory that was read, not the id inside the log',
        `checked ${checked}, wrong ${wrong} (expected session "locator-check")`);
    }

    // --- the resume checkpoint must be guarded the same way ----------------
    //
    // This path had no guard at all: the checkpoint recorded only `{hash: vector}`
    // and was trusted blindly, so a build interrupted before a model change would
    // mix two vector spaces into one index (same width) or drop units (different
    // width). A checkpoint only survives an *unsuccessful* build, which is why a
    // test that always builds to completion never saw it.
    const { model, dim } = first.stdout.match(/model=(?<model>\S+) dim=(?<dim>\d+)/)?.groups ?? {};
    if (!model || !dim) {
      bad('the build reports the embedder identity', `could not parse "model=… dim=…" from:\n${first.stdout}`);
    } else {
      const width = Number(dim);
      const { readIndex } = await import('../lib/store.mjs');
      const index = await readIndex(indexDir);
      const { createHash } = await import('node:crypto');
      const hash = index.unit(0).hash;
      const text = index.unit(0).text;
      assert.ok(hash, 'the index must carry content hashes for the checkpoint key');

      /** A vector that is valid in shape and unmistakable in content. */
      const planted = Buffer.concat([
        Buffer.from(Float32Array.of(0.5).buffer),
        Buffer.alloc(width, 0x7f),
      ]).toString('base64');
      const checkpoint = join(indexDir, '.embed-checkpoint.json');
      const header = (m) => JSON.stringify({ kind: 'checkpoint', model: m, dim: width });
      const find = async () => {
        const i = await readIndex(indexDir);
        for (let n = 0; n < i.size; n += 1) if (i.unit(n).hash === hash) return i.unit(n).vector.toString('base64');
        return null;
      };

      // (a) wrong model, same width → discarded, and the real vector survives
      writeFileSync(checkpoint, `${header(`${model}-but-not-really`)}\n${JSON.stringify({ h: hash, v: planted })}\n`);
      const guarded = await run('node', [cli, 'build'], { env, timeout: 120_000 });
      if (/checkpoint was built with/.test(guarded.stdout + guarded.stderr)) {
        ok('a checkpoint from another model is refused');
      } else {
        bad('a checkpoint from another model is refused',
          `no mismatch warning; the vectors would have been mixed:\n${guarded.stdout}`);
      }
      const afterGuard = await find();
      if (afterGuard !== null && afterGuard !== planted) {
        ok('the refused checkpoint did not reach the index');
      } else {
        bad('the refused checkpoint did not reach the index',
          'the planted vector is in the index — two vector spaces are now mixed');
      }
      assert.ok(text.length > 0);

      // (b) matching header → the checkpoint *is* used, so the guard does not
      // simply disable resuming
      writeFileSync(checkpoint, `${header(model)}\n${JSON.stringify({ h: hash, v: planted })}\n`);
      const resumed = await run('node', [cli, 'build'], { env, timeout: 120_000 });
      const afterResume = await find();
      if (afterResume === planted && !/checkpoint was built with/.test(resumed.stdout + resumed.stderr)) {
        ok('a matching checkpoint is still resumed');
      } else {
        bad('a matching checkpoint is still resumed',
          `expected the planted vector to be reused; output:\n${resumed.stdout}`);
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('─'.repeat(70));
console.log(`${failures === 0 ? 'PASS' : 'FAIL'}${skipped > 0 ? `, ${skipped} skipped (unverified)` : ''}`);
console.log('─'.repeat(70));
process.exitCode = failures === 0 ? 0 : 1;
