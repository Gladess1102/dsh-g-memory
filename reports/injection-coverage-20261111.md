# Injection coverage: what the model actually receives

Measured 2026-11-11 on the live index (58,668 units / 343 cards / 364 sessions).
Every number below comes from a script in `scripts/`, not from a spreadsheet.

## Why this measurement existed

`eval-retrieval.mjs` scores recall@20 over the fused pool and reports 22/22 on
`cases.calibration.json`. The automatic path continues past that point:
`recall -> cardEntries -> rerankEntries -> selectByPolicy -> renderRecall`. A case
can sit at rank 2 and still never reach the model, and the regression gate would
still be green. Nothing measured that last step.

`scripts/eval-injection-coverage.mjs` does, reproducing the order in
`lib/auto-recall.mjs` (the block that starts at the `index.recall` call and ends
at `renderRecall`).

## The number

With the configuration as shipped (candidates 8, maxEntries 3, fullChars 400,
policy budget 1200, render budget 1200, gate -1):

    cases=22  injected 7/22 (32%)  covered 4/22 (18%)
    per block 3 entries / 1027 chars (frame 792)

15 of 22 cases returned `kept: 3` with `chars: 0`: three entries selected, none
rendered, and `reason: null` because the drop happened in `selectByPolicy`'s
budget branch rather than in the gate. Silent from every angle an operator reads.

## Root cause: the frame spends two thirds of the budget

`INJECTION_FRAME_CHARS` is 792 (the untrusted-data notice plus the closing
provenance lines; the 626 in the comment is stale — `FRAME_CLOSE` gained five
lines after it was written). `renderRecall` counts the frame against
`maxTotalChars`, so 1200 leaves 408 for entries.

An entry line is a 400-character slice plus a ~60-character provenance prefix:

| budget | net after frame | full entries that fit |
|---|---|---|
| **1200 (was)** | **408** | **0** |
| 2400 | 1608 | 3 |
| 3000 | 2208 | 4 |

Unit length on this index backs the arithmetic: p50 744 characters, p75 1,156,
p90 1,188 (sampled every 600th unit). Only the brief tier (200 chars) and short
units could ever land, which is why `eval-quality` measured 1.48 entries per
block against a configured 3.

## Budget sweep

Each stage measured on the same 22 cases, cross-encoder reranking live:

| candidates | maxEntries | policy budget | render budget | coverage | injected |
|---|---|---|---|---|---|
| 8 | 3 | 1200 | 1200 | 18% | 32% |
| 8 | 3 | 1200 | 2400 | 55% | 100% |
| 20 | 3 | 1200 | 2400 | 64% | 100% |
| 20 | 6 | 6000 | 8000 | 73% | 100% |
| 20 | 6 | 6000 | 8000, fullChars 1200 | 96% | 100% |

Three independent losses, in order of size: the render ceiling (+37 points, no
retrieval cost), the candidate depth (+9 points, only rerank latency), and
`fullChars: 400` truncating the answer out of the entry (+23 points — the same
defect the `maxChars 300 -> 800` change fixed on the rerank side, still open on
the injection side).

The automatic path's candidate depth is **8** (`DSH_G_MEMORY_AUTO_CANDIDATES` in
`lib/auto-recall.mjs`), not the 20 the evaluation scripts use. That gap is why the
gate and the live path were measuring different pools.

## The negatives are contaminated

`scripts/cases.negatives.json` reports 0/13 usable: every `mustNot` string occurs
in 3-17 retrieved units. The file itself was read by an agent, its tool output was
indexed, and it now answers the questions it was written to test. The historical
gate calibration in `lib/policy.mjs` ("gate 1.18 admitted 7/13 irrelevant queries")
was measured against those queries, so it described the opposite class.

`scripts/check-negatives.mjs` validates a negative set by searching the index for
its own `mustNot` strings. 19 of 24 invented-entity candidates passed; they are in
`scripts/cases.negatives.v2.json`.

## Gate recalibration, and why it cannot be applied

Clean positives (22) against clean negatives (19), candidates 20, maxEntries 6,
budget 2400/2400:

| gate | coverage | false inject |
|---|---|---|
| -1 (shipped) | 59% | 90% |
| 2 | 59% | 63% |
| 3 | 55% | 21% |
| 3.5 | 55% | 5% |
| 4 | 50% | 0% |

Top-1 cross-encoder scores: positives p10/p50/p90 = 3.72 / 4.88 / 6.33, negatives
= -5.28 / 2.12 / 3.17. Separable on this set, and 3.5 looks free.

It is not. Real traffic over the last 14 days (329 gate events) has top-1
p10/p50/p90 = -2.51 / **-0.08** / 2.54; the pass group medians 0.81, the drop
group -2.01. A gate of 3.5 would admit 12 of 329 turns (4%) instead of 218 (66%).

The two distributions differ by five points because a labelled case asks "what is
fact X in this repository" while a live message is a fragment like "接着做". No
single absolute threshold serves both. `gate: -1.0` is therefore not a calibrated
relevance boundary — it removes the 34% of turns whose best candidate scores below
-1 and admits everything else. That is the design the plugin actually runs
(discrimination delegated to the judge); the comment history implies otherwise.

## Real-traffic funnel

2,154 judge decisions: 1,054 fire (49.8%), 1,071 skip. Of the fires, **399 (37.9%)
found nothing to inject** and fell through to the one-line `hint` — the single
largest loss in the pipeline, and the same shape as Raw-RAG's finding that
evidence access, not reader capability, is the bottleneck.

## The index layer is not the problem

343 cards (303 alive), 72 ever read. Only **13 of those 72 are inside the 17
entries the index layer shows**; 59 were reached through `memory_recall`. The
resident block works as a map ("memories exist here"), not as navigation, and
widening it from 17 to 27 entries would touch a small fraction of what is actually
read.

## What changed

Three constants, all defaulting the injection budget to 2400:

- `lib/inject.mjs` `INJECTION_LIMITS.maxTotalChars`
- `lib/config.mjs` composition default
- `lib/policy.mjs` `DSH_G_MEMORY_MAX_TOTAL_CHARS` default

The first two must move together: one decides how many entries are selected, the
other how many survive rendering. Changing only one selects entries the renderer
discards — the exact defect being fixed.

Verified: `test-policy`, `test-quality`, `test-inject`, `test-e2e-hermetic` all
pass; the 22-case check goes from 32% injected / 18% covered to 100% / 55% at
2,154 characters per block.

## Not changed, on purpose

- **Candidate depth 8 -> 20.** Worth +9 points offline at zero token cost, but the
  live score distribution is much weaker than the labelled corpus, and the rerank
  call grows with the pool. Needs a day of live traffic, not a table.
- **`fullChars: 400 -> 800`.** Worth +23 points offline, but most live units are
  tool output; widening the slice may spend the budget on log lines. Measure the
  live length mix first.
- **Any gate change.** See above: the offline optimum cuts live recall by 94%.

## Reproduce

```bash
export DSH_G_MEMORY_EMBED_URL=http://127.0.0.1:11439
export DSH_G_MEMORY_EMBED_MODEL=embeddinggemma-2
export 'DSH_G_MEMORY_EMBED_QUERY_PREFIX=task: question answering | query: '
export DSH_G_MEMORY_RERANK_URL=http://127.0.0.1:11436
export DSH_G_MEMORY_RERANK_MAX_CHARS=800

node scripts/eval-injection-coverage.mjs scripts/cases.calibration.json
SW_CANDIDATES=8,20 SW_ENTRIES=3,6 SW_BUDGETS=1200,2400 SW_RENDER=1200,2400,4000 \
  node scripts/sweep-injection-budget.mjs scripts/cases.calibration.json
SG_NO_CARDS=1 node scripts/sweep-gate.mjs scripts/cases.calibration.json \
  scripts/cases.negatives.v2.json
node scripts/check-negatives.mjs scripts/cases.negatives.json     # 0/13, expected
```

## Open

- 22 labelled cases: one case is worth 4.5 points. The calibration set is a
  regression gate, not a measurement instrument.
- `cases.challenge.json` is `[]`; `eval:challenge` runs with `--min-rate 0` and
  always exits 0. There is no tracked failure surface.
- `eval-quality.mjs` reports `truncated 55.3%` from card-writing ellipses (73 of
  123 blocks, `provenance=written memory`), not from injection-time cuts (5).
  Do not read it as a budget signal.
