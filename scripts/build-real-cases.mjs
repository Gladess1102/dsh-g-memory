#!/usr/bin/env node
/**
 * Build a large, auto-verified case set out of the real index.
 *
 * The hand-written calibration set is 8 questions, which is too few to quote a
 * usability rate from, and mining question/answer pairs out of the logs produced
 * almost nothing usable: people mostly ask the agent to *do* things, and a
 * request to do work is not a recall probe.
 *
 * So the facts come from the corpus and the questions are templated around them,
 * which keeps the content real while making the label checkable by machine. Every
 * generated case is then verified the only way that matters — by running the
 * real retrieval and confirming the expected token is present in the fragments
 * the gate actually admits. A case whose answer cannot be reached is discarded
 * rather than counted as a model failure, because a retrieval miss and a
 * synthesis miss are different defects.
 *
 * Usage: node scripts/build-real-cases.mjs <out.json> [target]
 */

/**
 * ⚠️ This builds a **synthesis** case set, not a retrieval benchmark.
 *
 * It keeps only the candidates whose fragment already contained the expected
 * answer, so every case is one retrieval has solved by construction — measured,
 * 17 of 53 candidates were dropped for that reason. It also asks the question as a
 * verbatim slice of the target fragment, which the lexical arm matches almost
 * exactly. Any retrieval figure computed from this file is therefore inflated;
 * quote `eval-retrieval.mjs --cases scripts/cases.calibration.json` or the
 * known-item harness instead.
 */
import { writeFile } from 'node:fs/promises';
import { readIndex, defaultIndexDir, prepareQueryVector, rrfFloor } from '../lib/store.mjs';
import { embedBatch, resolveConfig } from '../lib/embedder.mjs';
import { rerankEntries, resolveRerankConfig } from '../lib/rerank.mjs';
import { selectForInjection } from '../lib/inject.mjs';

const OUT = process.argv[2] ?? '/tmp/real-cases.json';
const TARGET = Number(process.argv[3] ?? 36);
// Read from the environment like eval-real.mjs does. Hardcoding the endpoint meant
// the case set silently reflected whichever reranker the author happened to run.
const RERANK = {
  url: process.env.DSH_G_MEMORY_RERANK_URL || 'http://127.0.0.1:11436',
  model: process.env.DSH_G_MEMORY_RERANK_MODEL || 'bge-reranker-v2-m3',
};

const index = await readIndex(defaultIndexDir());
const cfg = resolveConfig();

/** Facts worth remembering: exact values, not prose. */
const SHAPES = [
  { re: /\b(1[0-9]{4})\b/g, q: (m, ctx) => `${ctx}用的是哪个端口`, kind: '端口' },
  { re: /\b(\d+(?:\.\d+)?)\s?(MB|GB|KB)\b/g, q: (m, ctx) => `${ctx}占用多大空间`, kind: '体积' },
  { re: /\b(\d+\.\d+)\s?倍/g, q: (m, ctx) => `${ctx}是多少倍`, kind: '倍数' },
  { re: /\b(\d{3,4})\s?维/g, q: (m, ctx) => `${ctx}是多少维`, kind: '维度' },
  { re: /\bv?(\d+\.\d+\.\d+)\b/g, q: (m, ctx) => `${ctx}是什么版本`, kind: '版本' },
  { re: /\b(\d{2,3})\s?个(会话|日志|文件|片段)/g, q: (m, ctx) => `${ctx}有多少个`, kind: '计数' },
];

/**
 * Pull a short topic phrase out of the unit — never out of the line that carries
 * the answer.
 *
 * Slicing around the match produced questions like
 * "耳机笔记 v0.5.1 — 项目进度存档是什么版本", which states the answer inside the
 * question and tests nothing. The topic therefore comes from the head of the
 * unit, and any candidate still containing the expected token is rejected.
 */
function topicOf(text, token) {
  const lines = text.split('\n').map((l) => l.replace(/[`*#>|]/g, ' ').replace(/\s+/g, ' ').trim());
  for (const line of lines.slice(0, 3)) {
    const cleaned = line.replace(/^\[?\d+[\].)]?\s*/, '').trim();
    if (cleaned.length < 6 || cleaned.length > 40) continue;
    if (cleaned.includes(token)) continue;
    // Mostly-CJK heads read as topics; a head that is mostly punctuation or
    // code is a fragment of a table and makes a nonsense question.
    const cjk = (cleaned.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (cjk / cleaned.length < 0.4) continue;
    return cleaned;
  }
  return '';
}

const total = index.size ?? index.units?.length ?? 0;
const candidates = [];
for (let i = 0; i < total; i += 1) {
  const unit = index.unit(i);
  const text = String(unit?.text ?? '');
  if (text.length < 30 || text.length > 4000) continue;
  for (const shape of SHAPES) {
    shape.re.lastIndex = 0;
    const m = shape.re.exec(text);
    if (!m) continue;
    const token = m[0].replace(/\s+/g, '');
    const topic = topicOf(text, token);
    if (topic.length < 6) continue;
    candidates.push({ query: shape.q(m[0], topic), expect: [token], kind: shape.kind, unit: i });
    break;
  }
}

/** Keep the real retrieval honest: the same gate the plugin uses. */
async function admitted(query, n = 3) {
  const [v] = await embedBatch([query], cfg);
  const hits = index.recall(prepareQueryVector(v), query, { k: 20 });
  const entries = hits.map(({ index: i, score }) => {
    const u = index.unit(i);
    return { text: String(u.text ?? ''), role: u.role, time: u.time || 0, score };
  });
  const { entries: ord, reranked } = await rerankEntries(query, entries, { config: RERANK });
  const gated = reranked
    ? ord.map(({ rerankScore, ...e }) => ({ ...e, score: rerankScore }))
    : ord;
  const sel = selectForInjection(gated, {
    maxEntries: n,
    maxPreviewChars: 400,
    minScore: reranked ? resolveRerankConfig(RERANK).minScore : rrfFloor(),
  });
  return sel.selected.map((s) => s.text);
}

const lower = (t) => String(t).toLowerCase();
const seen = new Set();
const kept = [];
const dropped = [];
for (const c of candidates) {
  if (kept.length >= TARGET) break;
  const key = c.query;
  if (seen.has(key)) continue;
  seen.add(key);
  const frags = await admitted(c.query).catch(() => []);
  const reachable = c.expect.some((t) => frags.some((f) => lower(f).includes(lower(t))));
  if (reachable) kept.push({ query: c.query, any: c.expect, kind: c.kind });
  else dropped.push(c.query);
}

await writeFile(OUT, JSON.stringify(kept, null, 1), 'utf8');
console.log(`  扫描 ${total} 个索引片段 → 候选 ${candidates.length} 条`);
console.log(`  检索可达并保留 ${kept.length} 条，丢弃（答案取不到，属检索缺陷而非模型缺陷）${dropped.length} 条`);
const byKind = {};
for (const k of kept) byKind[k.kind] = (byKind[k.kind] ?? 0) + 1;
console.log('  类型分布:', JSON.stringify(byKind, null, 0));
for (const k of kept.slice(0, 8)) console.log(`    · ${k.query}   期望 ${JSON.stringify(k.any)}`);
