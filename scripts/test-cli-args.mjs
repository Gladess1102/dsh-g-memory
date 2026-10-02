#!/usr/bin/env node
/**
 * CLI argument checks.
 *
 * The flags were parsed by `argv[++i]` with no validation, which produced three
 * distinct failures: a flag could be swallowed as another flag's value
 * (`stats --out --fresh` tried to read an index from a directory named
 * `--fresh`), a missing count became `NaN` and reached `.slice()` as an empty,
 * successful result, and `distill`'s documented `--recent/--model/--url` were
 * never parsed at all while the error message told the operator to use `--url`.
 *
 *   node scripts/test-cli-args.mjs
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dsh-g-memory.mjs');
let failures = 0;

/** @returns {Promise<{code:number, out:string}>} */
const runCli = (argv) => new Promise((resolve) => {
  execFile('node', [cli, ...argv], { timeout: 20_000 }, (error, stdout, stderr) => {
    resolve({ code: error?.code ?? 0, out: `${stdout}${stderr}` });
  });
});

const check = async (name, argv, expected) => {
  const { code, out } = await runCli(argv);
  const problems = [];
  if (code !== expected.code) problems.push(`exit ${code}, expected ${expected.code}`);
  if (expected.match && !expected.match.test(out)) problems.push(`output did not match ${expected.match}`);
  if (expected.absent && expected.absent.test(out)) problems.push(`output unexpectedly matched ${expected.absent}`);
  if (problems.length === 0) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.log(`  ❌ ${name}\n       ${problems.join('; ')}\n       got: ${out.split('\n')[0].slice(0, 120)}`);
  }
};

await check('a flag is never accepted as another flag\'s value',
  ['stats', '--out', '--fresh'], { code: 1, match: /--out needs a value/ });
await check('a missing count is an error, not NaN',
  ['recall', 'x', '--top'], { code: 1, match: /--top needs a value/ });
await check('a non-numeric count is an error',
  ['recall', 'x', '--top', 'abc'], { code: 1, match: /--top needs a positive number/ });
await check('a zero count is an error',
  ['build', '--limit', '0'], { code: 1, match: /--limit needs a positive number/ });
await check('the same guard applies to --recent',
  ['distill', '--recent'], { code: 1, match: /--recent needs a value/ });
await check('an argument error is reported without a stack trace',
  ['stats', '--out', '--fresh'], { code: 1, absent: /^\s+at .*dsh-g-memory\.mjs:\d+/m });
await check('--help succeeds',
  ['--help'], { code: 0, match: /dsh-g-memory/ });
await check('no command is a usage error',
  [], { code: 1, match: /dsh-g-memory/ });

// `distill --url` used to be ignored while the failure message recommended it.
// Now that it is parsed, an unreachable endpoint fails as a connection problem.
await check('distill honours --url instead of claiming none was given',
  ['distill', '--url', 'http://127.0.0.1:9/v1', '--recent', '1'],
  { code: 1, absent: /no synthesis endpoint configured/ });

console.log(failures === 0
  ? '\n  cli arguments: all checks passed\n'
  : `\n  cli arguments: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
