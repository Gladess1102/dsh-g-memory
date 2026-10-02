#!/usr/bin/env node
/**
 * Redaction checks.
 *
 * `redact` runs over session text before it is sent to a synthesiser, and over
 * the model's output before it is stored. The second pass is why over-matching is
 * not cosmetic: a rule that redacts content rather than secrets writes the damage
 * into a durable card.
 *
 *   node scripts/test-redaction.mjs
 */
import assert from 'node:assert/strict';
import { redact } from '../lib/synthesize.mjs';

let failures = 0;
// `await fn()`, not `fn()`. Without it an async check returned a promise nobody
// looked at: the assertion failure became an unhandled rejection and the check
// printed ✅ — which is how the private-key test passed while the fix it was
// written for was removed. Found by mutation testing, not by reading.
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

/** Text that merely contains a secret-looking word must survive untouched. */
const NOT_SECRETS = [
  'tokenizer: bge-m3',
  'monkey: business',
  'keyboard: mechanical',
  'max_tokens: 120000',
  'tokens: 500',
  'secretary: 张三',
  'passwords are stored hashed',
  'the token bucket is full',
  'key: value',
  'secrets are rotated quarterly',
];

/** Assigned values that must be removed. */
const SECRETS = [
  ['DB_PASSWORD=hunter2', /DB_PASSWORD=\[redacted-secret\]/],
  ['OPENCODE_GO_API_KEY="sk-abc123456"', /OPENCODE_GO_API_KEY=\[redacted-secret\]/],
  ['aws_secret_access_key = wJalrXUtnFEMI', /aws_secret_access_key=\[redacted-secret\]/],
  ['api-key: abcdef123456', /api-key=\[redacted-secret\]/],
  ['MYTOKEN: abcdefgh', /MYTOKEN=\[redacted-secret\]/],
  ['dbPassword=abc123456', /dbPassword=\[redacted-secret\]/],
  ['apiToken: xyz789012', /apiToken=\[redacted-secret\]/],
  ['mySecretKey=abcdefg', /mySecretKey=\[redacted-secret\]/],
  ['token2=abc123456', /token2=\[redacted-secret\]/],
  ['secretValue=abc123456', /secretValue=\[redacted-secret\]/],
  ['tokenValue: xyz789012', /tokenValue=\[redacted-secret\]/],
  ['sk_live_51H8xYzAbCdEfGhIjKlMnOpQr', /\[redacted-key\]/],
  ['rk_live_51H8xYzAbCdEfGhIjKlMnOpQr', /\[redacted-key\]/],
  ['Bearer abcdefghijklmnop', /Bearer \[redacted-token\]/],
  ['an email to someone@example.com', /\[redacted-email\]/],
  ['home is /Users/someone/work', /\[redacted-home\]/],
];

await check('content that merely looks like a secret name is left alone', () => {
  for (const text of NOT_SECRETS) {
    assert.equal(redact(text), text, `"${text}" must not be rewritten`);
  }
});

await check('assigned secrets are still removed', () => {
  for (const [input, expected] of SECRETS) {
    assert.match(redact(input), expected, `"${input}" must be redacted`);
  }
});

await check('a secret embedded in a sentence is redacted without eating the sentence', () => {
  const out = redact('部署时把 DB_PASSWORD=hunter2 写进了 config.env，后来改掉了。');
  assert.match(out, /DB_PASSWORD=\[redacted-secret\]/);
  assert.match(out, /部署时把/);
  assert.match(out, /后来改掉了。/);
});

await check('loopback addresses survive — they are frequently the answer', () => {
  const text = '嵌入服务在 127.0.0.1:11439，重排器在 127.0.0.1:11436。';
  assert.equal(redact(text), text);
});

await check('a private address is still removed', () => {
  assert.match(redact('网关是 192.168.1.1'), /\[redacted-ip\]/);
});

await check('a private key split across chunks is still redacted', async () => {
  // The paired rule needs BEGIN and END in one string, and candidates are chunks —
  // so a key longer than a chunk used to cross the trust boundary intact. The
  // chunker now keeps a PEM block whole; this asserts the pair still matches on one
  // fragment, which is the property the README promises.
  const { chunkBySentence } = await import('../lib/chunker.mjs');
  const { createHash } = await import('node:crypto');
  let body = '';
  let seed = 'MIIEowIBAAKCAQEA';
  while (body.length < 1700) { seed = createHash('sha256').update(seed).digest('base64').replace(/[^A-Za-z0-9+/]/g, ''); body += seed; }
  body = body.slice(0, 1620).replace(/(.{64})/g, '$1\n').trim();
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
  const material = body.replace(/\n/g, '').slice(200, 240);

  const chunks = chunkBySentence(pem, 800);
  assert.equal(chunks.length, 1, 'the block must not be split');
  assert.doesNotMatch(redact(chunks[0]), new RegExp(material), 'no key material may survive');

  // And the backstop: a fragment that holds only one end.
  const head = pem.slice(0, 900);
  const tail = pem.slice(-900);
  assert.doesNotMatch(redact(head), new RegExp(material.slice(0, 40)), 'an unterminated BEGIN must redact to the end');
  assert.doesNotMatch(redact(tail), /MIIEowIBAAKCAQEA/, 'an unterminated END must redact from the start');
});

await check('redaction is idempotent', () => {
  const once = redact('DB_PASSWORD=hunter2 and someone@example.com');
  assert.equal(redact(once), once, 'running it twice must not change it again');
});

console.log(failures === 0
  ? '\n  redaction: all checks passed\n'
  : `\n  redaction: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
