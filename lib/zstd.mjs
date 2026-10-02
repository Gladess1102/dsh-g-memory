/**
 * The one place this package runs the `zstd` CLI.
 *
 * `node:zlib` cannot read these files: DSH writes session logs as a sequence of
 * independently flushed zstd frames, and Node's decompressor aborts on that
 * layout ("Unknown frame descriptor"). The CLI concatenates frames by default,
 * which is exactly the required behaviour, so a child process is unavoidable.
 *
 * Running a child process to read untrusted-shaped data needs four things that
 * a bare `spawn` does not give you, and each of them is a real defect otherwise:
 *
 *   1. **A ceiling on the output.** Compression is unbounded in the expansion
 *      direction: measured, 200 MB of zeros compresses to 6,284 bytes, about
 *      31,800:1. A few KB of hostile input therefore expands into multiple GB of
 *      resident memory before anything looks wrong. The cap is enforced while
 *      reading, not after, and the child is killed on overflow.
 *   2. **A deadline.** A child that never exits (a FIFO, a wedged binary) would
 *      otherwise leave the promise pending forever and leak the process.
 *   3. **A minimal environment.** The child inherits the full environment by
 *      default, which in this process includes provider API keys. A decompressor
 *      has no business holding them.
 *   4. **A handled `stdin`.** Writing to a child that has already exited raises
 *      an unhandled `EPIPE` on that stream, which crashes the process instead of
 *      rejecting the promise.
 *
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { numberEnv } from './env.mjs';

/** Ceiling for one decompressed session log. */
export const MAX_LOG_BYTES = numberEnv('DSH_G_MEMORY_MAX_LOG_BYTES', 256 * 1024 * 1024, { min: 1024 });
/** Ceiling for the decompressed index. */
export const MAX_INDEX_BYTES = numberEnv('DSH_G_MEMORY_MAX_INDEX_BYTES', 512 * 1024 * 1024, { min: 1024 });
/** Wall-clock limit for one zstd invocation. */
// Measured on this machine: `zstd -19` runs at ~0.33 s/MB, so the declared
// 512 MB ceiling needs ~170 s. At the old 120 s default the limit could never be
// reached — compression timed out first, and the failure looked like a zstd error
// rather than a ceiling doing its job.
const TIMEOUT_MS = numberEnv('DSH_G_MEMORY_ZSTD_TIMEOUT_MS', 300_000, { min: 1_000 });

/**
 * Resolve the configured `zstd` binary to a concrete file.
 *
 * A bare name is resolved through `PATH` by the OS, which means whichever
 * `zstd` happens to come first runs — and its stdout is parsed as memory. An
 * explicit override is required to be an absolute path for the same reason: a
 * relative override resolves against whatever the process working directory
 * happens to be, which is not something the person who set it can rely on.
 *
 * @param {string} [configured]
 * @returns {string} the binary to execute
 */
export function resolveZstdBinary(configured = process.env.DSH_G_MEMORY_ZSTD) {
  if (configured === undefined || configured === '') return discoverZstd();
  if (!isAbsolute(configured)) {
    throw new Error(
      `DSH_G_MEMORY_ZSTD must be an absolute path, got ${JSON.stringify(configured)}`,
    );
  }
  const real = realpathSync(configured);
  const info = statSync(real);
  if (!info.isFile()) throw new Error(`DSH_G_MEMORY_ZSTD is not a regular file: ${real}`);
  accessSync(real, constants.X_OK);
  return real;
}

/**
 * The bare name when `PATH` can actually provide it, else a conventional absolute
 * path.
 *
 * A host launched by the OS — the desktop app — starts with
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, where Homebrew's zstd is invisible. Every
 * session read and every index build inside that host then failed with ENOENT,
 * while the identical code worked from a terminal, which is the kind of difference
 * that looks like a plugin bug for an afternoon. Retrieval survived only because
 * the index keeps an uncompressed copy beside the compressed one.
 */
function discoverZstd() {
  const path = process.env.PATH ?? '';
  if (path.split(':').some((dir) => dir && existsSync(join(dir, 'zstd')))) return 'zstd';
  for (const candidate of ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd']) {
    if (existsSync(candidate)) return candidate;
  }
  // Nothing found: return the bare name so the spawn reports the same ENOENT the
  // caller already turns into a readable error.
  return 'zstd';
}

/** Only what a decompressor needs; never the caller's provider credentials. */
function minimalEnv() {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'C',
  };
}

/**
 * Run zstd, returning everything it wrote to stdout.
 *
 * @param {string[]} args argv *without* the binary; the binary is resolved here
 * @param {Buffer | null} input bytes for stdin, or null to close it immediately
 * @param {number} maxOutputBytes hard ceiling on decompressed output
 * @returns {Promise<Buffer>}
 */
export function runZstd(args, input, maxOutputBytes) {
  return new Promise((resolve, reject) => {
    let binary;
    try {
      binary = resolveZstdBinary();
    } catch (error) {
      reject(error);
      return;
    }

    let child;
    try {
      child = spawn(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: minimalEnv(),
        timeout: TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
    } catch (cause) {
      reject(new Error(`cannot run ${binary}: ${cause.message}`));
      return;
    }

    const chunks = [];
    let total = 0;
    let stderr = '';
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxOutputBytes) {
        fail(new Error(
          `${binary} output exceeded the ${maxOutputBytes} byte ceiling; refusing to buffer more`,
        ));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (cause) => fail(new Error(`cannot run ${binary}: ${cause.message}`)));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const why = signal ? `killed by ${signal}` : `exited ${code}`;
        reject(new Error(`${binary} ${why}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    // A child that exits before reading stdin raises EPIPE here. Unhandled, it
    // takes down the whole process rather than rejecting this promise.
    child.stdin.on('error', () => { /* reported through 'close' */ });
    child.stdin.end(input ?? undefined);
  });
}
