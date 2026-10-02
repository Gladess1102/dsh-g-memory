# Security and quality review — dsh-g-memory

**Subject:** `dsh-g-memory` v0.3.1
**Method:** adversarial review by three independent passes — the author's own
line-by-line pass, a security audit, and a cleanliness/ecosystem-readiness audit.
Every finding below was **reproduced** before it was accepted; findings reached by
inference alone were discarded. "Verified" means a command was run or the real
Harness code was exercised, and the evidence is stated with the finding.

This document is written in English to match the rest of the package.

---

## 1. Verdict

The plugin is **safe to run** and, after the fixes below, **fit to publish**.
It has no runtime dependencies, spawns no shell, opens no socket, and transmits
nothing off the machine unless the operator names a destination.

Six of the findings were not security holes but **silent total failures**: the
plugin loaded, reported itself healthy, and did nothing. They are listed first
because they are the ones a user would never diagnose.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | critical | The plugin loaded, reported `active`, and registered nothing | fixed |
| 2 | high | Synthesis defaulted to a remote third-party endpoint, enabled | fixed |
| 3 | high | Automatic recall injected nothing for most queries | fixed |
| 4 | high | The query was sent to the synthesis endpoint unredacted | fixed |
| 5 | high | Two shipped privacy claims contradicted the code | fixed |
| 6 | high | Skipped tests were counted as passes | fixed |
| 7 | high | The npm name belonged to an unrelated package | fixed |
| 8 | medium | Redaction let 10+ common credential shapes through | fixed |
| 9 | medium | Unbounded decompression (~31,800:1 measured) | fixed |
| 10 | medium | `zstd` resolved via `PATH`, inheriting provider API keys | fixed |
| 11 | medium | Unhandled `stdin` `EPIPE` crashed the process | fixed |
| 12 | medium | Injected text could forge its framing; tool path had none | fixed |
| 13 | medium | Embedding responses were trusted without validation | fixed |
| 14 | medium | A dimension mismatch silently returned the oldest units first | fixed |
| 15 | low | A single malformed index row destroyed the whole capability | fixed |
| 16 | low | Numeric environment typos silently disabled their own limits | fixed |
| 17 | low | `readIndex` swallowed the reason the compressed copy failed | fixed |
| 18 | low | Dead code carried a documented guarantee that never ran | fixed |
| 19 | low | The `/recall` command surface | reviewed |
| 20 | info | `--out` can clobber same-named files in any directory | open |
| 21 | info | Index freshness is not surfaced to the model | open |

---

## 2. Findings

### 2.1 CRITICAL — mounted, `active`, and contributing nothing

The 0.1.x plugin never registered its tool. `plugin_manager list_plugins`
reported `{"enabled":true,"fiberPhase":"active"}`, which is why three successive
diagnoses missed it: a fiber reports `active` whenever `apply()` *returns*, and
the plugin's early-return path was silent.

Two independent Loader rules were responsible, and both had to be fixed.

**Rule one — a service must be declared.** Cordis derives each fiber's start from
the plugin's `inject` list (`Fiber._refresh`): a name absent from that list is
absent from the fiber's store, so `ctx.get('tools')` is `undefined` while
`apply()` runs — regardless of load order, including when the provider mounted
first. Verified against real Cordis: with no `inject`, the tool failed to
register in **both** load orders; with `inject: ['tools']`, it registered in both.

**Rule two — `export default` shadows every named export.** `cordis-plugin-loader`
resolves a module as `exports.default ?? exports`, so an
`export default { name, apply }` discarded the named `inject`. Adding `inject`
alone therefore changed nothing. Verified directly: with a default export
present, the resolved keys are `["name","apply"]`.

Why this stayed invisible: DSH only writes a startup log file when a *required*
entry fails (`lib/bin.js`). A non-required plugin whose `apply()` returns early
produces no log, no warning and no failed fiber. That path now throws.

The reproduction is kept as `scripts/test-loader-contract.mjs`. Red/green:
removing `inject` scores 2/5; restoring the default export scores 1/5.

### 2.2 HIGH — synthesis shipped memory to a third party by default

```js
enabled: process.env.DSH_G_MEMORY_SYNTHESIS !== 'off',                     // true
baseUrl: process.env.DSH_G_MEMORY_LLM_URL || 'https://opencode.ai/zen/go/v1',
```

The bundle passes no options, so the defaults applied: synthesis was **on**, its
destination was the package author's own gateway, and the credential it looks for
was resolvable on the machine under review. Every `memory_recall` and every
automatic recall posted retrieved session text plus `Authorization: Bearer <key>`
to a third party. Confirmed by execution, not inference.

Meanwhile `README.md` said "Everything runs on your machine. The only network
call is to a **local** embedding server" and "unset disables synthesis".

Now: no default endpoint. Unset means no synthesis, and the caller receives
`no synthesis endpoint configured` as a distinct reason from a rejected key.
Verified: `baseUrl=""`, and `synthesize()` returns that reason without any
request being issued.

### 2.3 HIGH — automatic recall injected nothing for most queries

`minScore` defaulted to `0.02`. Reciprocal rank fusion scores are **quantised**:
one arm at rank 0 scores `1/(60+0+1) = 0.01639`, both arms at rank 0 score
`2/61 = 0.03279`, and nothing falls between. A threshold of `0.02` sits inside
that gap, so it discarded every unit that only one arm found — precisely the case
fusion exists to recover.

Measured against a real 10,823-unit index, five ordinary queries:

| Query | top-1 | injected before | injected after |
|---|---|---|---|
| `llama-server token 上限是多少` | 0.03110 | 1 | 2 |
| `zstd 压缩比与索引大小` | 0.03132 | 1 | 2 |
| `皮肤插件怎么装` | 0.01639 | **0** | 2 |
| `embedding 服务监听哪个端口` | 0.01639 | **0** | 2 |
| `上次那个 bug 的原因` | 0.01639 | **0** | 2 |

Corroborating evidence: 0 of 79 session logs contained a `dsh-g-memory`
injection, i.e. the feature had effectively never fired.

The default is now `rrfFloor()` = `1/(RRF_K+1)`, and the two thresholds worth
choosing between are documented as band edges. A skipped selection now records
*why*, which is what made the miscalibration invisible.

### 2.4 HIGH — the query was not redacted

Redaction covered the candidates but not the query. On the automatic path the
query is an entire user message — pasted documents, `.env` files, CI logs
included — so the one part of the prompt that does not come from the index was
the part most likely to hold a live credential. Reproduced: an AWS key id and
`DB_PASSWORD=…` appeared verbatim in the outbound prompt.

Both are redacted now, and the automatic path caps the query at 500 characters
(matching the tool path) instead of accepting unbounded input.

### 2.5 HIGH — documented privacy claims were false

| Claim | Reality |
|---|---|
| "Everything runs on your machine. The only network call is to a local embedding server." | Synthesis was on by default, to a remote endpoint |
| "The index stores a pointer and a preview, **never the transcript** … no second copy" | The index holds 6.7 M characters of chunk text of user, assistant and tool output |
| "~9 MiB" (README, CHANGELOG) | 32.8 MiB on disk: 23.7 MiB uncompressed plus 9.09 MiB compressed |

Corrected. The index is now written `0600` inside a `0700` directory, since it is
a partial copy of the user's conversations. The distortion figures in the same
section were also stale (2,897-unit numbers presented as current).

### 2.6 HIGH — skipped checks counted as passes

Simulating a fresh machine (empty `DSH_HOME`, dead embedder) produced:

```
⚠️  live index unavailable — execution checks skipped
⚠️  no recall became ready within 30s — injection-shape checks skipped
通过了 13/13 项            ← exit code 0
```

8 of 21 checks vanished and the suite reported full marks. A separate check
contained `assert.ok(true)` — a tautology that could never fail, in the same
defect class an earlier release claimed to have fixed.

Now: skips are counted, named in the summary, and fatal under `--strict` (which
`npm test` uses). The tautology is replaced by an assertion of the observable
consequence. Verified: the same simulated machine now reports
`通过 12/13 项，跳过 2 项（未验证）`.

This is the third instance of one lesson, recorded in §3.

### 2.7 HIGH — the npm name was taken

`dsh-memory` on npm is owned by a different maintainer and describes a competing
DeepSeek Harness memory plugin (v0.1.0, published 2026-08-13). `npm publish`
would fail, and — worse — `pnpm add dsh-memory`, the command a README would
naturally teach, resolves against the registry and installs **someone else's
package**. Nearby names were taken too (`dsh-plugin-memory`, `dsh-memory-plugin`,
`dsh-recall`, `dsh-local-memory`). Renamed to `dsh-g-memory` (verified available),
with the environment prefix moved to `DSH_G_MEMORY_*`.

### 2.8 MEDIUM — redaction was incomplete

Executed against the real `redact()`: AWS access-key ids and secrets, GCP, Slack,
GitLab, npm, Hugging Face, Stripe, `Bearer …` tokens and `NAME=value` assignments
such as `DB_PASSWORD=hunter2` all passed through unchanged. One bearer token in
the live corpus survived verbatim.

Redaction now covers **21 shapes** (re-counted after the third review round), and
the rule that generalises is name-based: an assignment whose identifier *is* a
secret name — a whole `_`/`-`-separated segment, an all-caps token, or a camelCase
identifier such as `secretValue` — which is what catches `DB_PASSWORD=…`, a value
with no distinguishing form. Loopback addresses, numbers and technical terms are
deliberately preserved; verified by **26 cases (16 must redact, 10 must survive)**.

Three gaps were found and closed in that round, all of the same shape — the
document claimed coverage the code did not have:

- **A private key longer than one chunk was never redacted.** The rule matches
  `BEGIN…` against `END…` within a single string, and the strings are chunks; a
  measured 1,707-character RSA key was split, and the fragment holding the BEGIN
  line survived redaction. `chunkBySentence` now keeps a PEM block whole, and
  unterminated markers redact to the end (or from the start) as a backstop.
- **Stripe keys were matched in their documented form only** (`sk-…`), while every
  key actually issued uses underscores (`sk_live_…`, `rk_live_…`).
- **Narrowing the name rule to whole segments lost two families** (`token2=…`,
  `secretValue=…`) while this document kept describing the wide rule.

The remaining limitation is unchanged and worth stating plainly: this is a
denylist. A secret with no recognisable name and no recognisable shape — a bare
base64 blob, an opaque session cookie — passes through. Measured, 0.25% of the
index carries a ≥120-character base64 run, and redacting those would delete real
answers (base64 JSON payloads, font tables), so the denylist stops there. The
control that matters is still that synthesis is opt-in.

Redaction remains a denylist and therefore incomplete. The control that matters
is that synthesis is opt-in, and the README says so.

### 2.9 MEDIUM — unbounded decompression

Both zstd call sites buffered the child's stdout with no ceiling. Measured
expansion: 200 MB of zeros compresses to 6,284 bytes, ≈**31,800:1**, so a few KB
of hostile input becomes multiple GB of resident memory. Now capped while
reading, with the child killed on overflow (`DSH_G_MEMORY_MAX_LOG_BYTES`,
`DSH_G_MEMORY_MAX_INDEX_BYTES`).

### 2.10 MEDIUM — the decompressor was attacker-selectable and over-privileged

`spawn(process.env.DSH_G_MEMORY_ZSTD || 'zstd', …)` resolved a bare name through
`PATH` and inherited the full environment. Verified that a child spawned this way
sees a parent-only secret. In this process that environment holds provider API
keys, and the child's stdout is parsed as memory. Now: an override must be an
absolute path resolving to an executable regular file, and only `PATH`, `HOME`
and `LANG` are passed through.

### 2.11 MEDIUM — an unhandled `stdin` `EPIPE` crashed the process

Neither call site attached an `error` handler to `child.stdin`. Reproduced with a
child that exits early: `UNCAUGHT EXCEPTION: write EPIPE`. Since `writeIndex`
feeds a 24 MB buffer this way, a build could die without reaching its own error
handling. Both paths are now one hardened runner with `stdin` error handling, a
timeout and `SIGKILL` on expiry.

### 2.12 MEDIUM — injected text could forge its own framing

The untrusted notice was a prose prefix and nothing else: payload text could
quote it, and `<` was unescaped, so content could close or forge a tag. Worse,
**the tool path had no framing at all** — recalled text arrived looking like
ordinary tool output.

Now both paths share one renderer: a `<recalled-memory>` wrapper with `<`
escaped in the payload, the notice both before and after, and control,
zero-width and bidirectional characters stripped. This mirrors the convention the
Harness itself uses for untrusted snapshots (`<referenced-sessions>` with `<` →
`\u003c`) rather than inventing a shape. Locked in by two tests: exactly one real
closing tag survives a payload containing `</recalled-memory>`, and the notice
must precede the payload.

### 2.13 MEDIUM — embedding responses were trusted

No validation of vector width or finiteness. A wrong-width or `NaN` vector would
be written into the index, where its rankings are meaningless and the failure is
invisible at build time. Now validated per vector, with a named error.

### 2.14 MEDIUM — a dimension mismatch silently returned the oldest units

`int8Similarity` returns `NaN` when the widths differ, and `Array.sort` with a
`NaN` comparator is a no-op, so the vector arm returned units in index order
while `recall` still reported a finite fused score. Realistic trigger: changing
embedding model without rebuilding. Now raises an error naming both dimensions.

### 2.15 LOW — one bad row destroyed the capability

A non-string `text` made the tool throw `unit.text.slice is not a function`; a
`time` outside the `Date` range made `toISOString()` throw `RangeError`. Rows are
now coerced, out-of-range values clamped, wrong-width vectors dropped and
counted, and the index is written via temp-file + rename so a crash mid-write
cannot truncate it.

### 2.16 LOW — numeric environment typos disabled their own limits

`Number('abc')` is `NaN`, and every comparison against `NaN` is false.
`DSH_G_MEMORY_CACHE_ENTRIES=abc` made the LRU bound unreachable (unbounded cache
growth); `DSH_G_MEMORY_EMBED_TIMEOUT_MS=abc` made `AbortSignal.timeout` throw,
reported as "endpoint unreachable"; `DSH_G_MEMORY_AUTO_CANDIDATES=abc` made every
retrieval return nothing. All numeric reads now go through one validating reader
that falls back to the documented default and clamps.

### 2.17 LOW — `readIndex` swallowed its own failure

An empty `catch` around the compressed read meant a corrupt or unreadable
compressed index silently served a stale raw copy, or reported the misleading
`no index found`. The reason is now retained and reported.

### 2.18 LOW — dead code carried a documented guarantee

`renderInjection` and `InjectionLimitError` were exported and **never called**.
The claim "exceeding a limit is an error, not a silent truncation" described only
that dead function; the live path truncated and dropped. The renderer is now the
single path both callers use, so the documented behaviour is the real behaviour.
Also removed: `looksLikeZstd`, a `dirname` re-export with no consumer,
`AutoRecall.report()`/`stats` (metrics incremented in six places and discarded),
`checkLater`, and accumulated totals that were computed and never printed.

### 2.19 HIGH — rebuilds were never incremental

Not a security finding, but the most expensive one: `build` re-embedded the whole
corpus every run, because the resume checkpoint is deleted after a successful
build and nothing consulted the index it had just written. Growing the corpus by
4% cost a full re-embed (~27 minutes for 12,000 units).

Fixed by seeding reuse from the previous index, guarded on model and dimension
matching the current embedder — reusing vectors from a different model would
silently make every ranking meaningless, which is a correctness failure rather
than a speed one. Measured: 153 s, and a second build embeds nothing.
`scripts/test-incremental-build.mjs` covers all four cases.

### 2.20 LOW — the `/recall` command surface

Added in 0.3.0. A human command runs without a model turn, so it is a distinct
surface and was reviewed as one:

- The query is length-capped and passed through the same redaction-free *local*
  path as the tool; nothing reaches the network unless synthesis is configured.
- The result is rendered through the same escaped framing as every other path, so
  recalled text cannot forge its boundary here either.
- `handler` catches its own errors and returns `{kind:'error'}` with the reason,
  because a command result is user-facing and a thrown handler would surface less
  usefully.
- It cannot be driven by model output: DSH dispatches commands from the composer,
  not from a model turn.
- The one privilege it has over automatic recall is that it ignores
  `DSH_G_MEMORY_AUTO`. That is the point of an explicit request; the master kill
  switch still applies.

### 2.21 INFORMATIONAL — `--out` can clobber files (open)

`build --out DIR` writes fixed names (`index.ndjson`, `index.ndjson.zstd`,
`.embed-checkpoint.json`) into any directory it is given, so
`build --out ~/Documents` overwrites same-named files. Operator-controlled and
not reachable from content, so it is a footgun rather than a vulnerability; a
`--force` guard is the obvious fix and has not been added.

### 2.22 INFORMATIONAL — index freshness is invisible (open)

`builtAt` is stored but never surfaced, so an index that is months stale is
indistinguishable from a current one. Also noted: `lib/index.js` and
`lib/auto-recall.mjs` each hold their own index copy, so the host process keeps
two loads resident (measured ~40 MB each at this index size), and the `DEFAULT_*`
config objects read `process.env` at import time, so environment changes need a
restart.

### 2.23 HIGH — the relevance gate on the tool and `/recall` path never fired

`selectForInjection` opens with `entries.filter((entry) => Number(entry.score ?? 0) >= cap.minScore)`,
and `lib/index.js` called it as `selectForInjection(ordered, { maxEntries, maxPreviewChars })`
— no `minScore`. The filter therefore read the `INJECTION_LIMITS` default of
`0`, and since every reciprocal-rank-fusion score is positive, **every candidate
that any arm ranked at any depth passed it**. This is a different defect from
§2.3: that one was a threshold set too high, on the automatic path, and it
suppressed recall. This one is a threshold that was never passed at all, on the
tool path, and it suppressed nothing.

The consequence is the failure this plugin exists to avoid. A query the corpus
cannot answer still retrieved a candidate pool — the arms always return their
best `k`, however poor — and all of it reached the synthesiser, which answered
out of it. Measured over 8 answerable and 8 deliberately unanswerable queries,
two runs each:

| | before | after |
|---|---|---|
| unanswerable queries fed a context | 8/8 | 2/8 |
| synthesis fabricated an answer | 4/16 runs (25%) | see below |
| answerable queries fed a context | 8/8 | **8/8** |

The fabrication count is what exposed it. Two unrelated models —
MiniCPM5-2B and Qwen3.5-2B — produced *byte-identical* aggregate results:
12/16 correct, 2 false negatives, 2 misses, 4/16 fabricated, and they failed on
the same two queries. Independent models do not fail identically; a shared input
does. That pointed upstream of the model, at the context both were handed.

**The fix.** A gate needs a scale that separates an answer from a near-miss, and
RRF is not one. Measured over the same 16 queries, top-1 fused score was
0.0159–0.0315 for the answerable set and 0.0145–0.0298 for the unanswerable one —
one overlapping band, because a query hitting a single arm at a low rank lands
near the `1/61` floor regardless of relevance. The two candidate thresholds on
that scale are both bad: `0` admits everything (the bug), and `rrfFloor()` keeps
only 4 of the 8 answerable queries. The cross-encoder separates the sets — top-1
medians 5.64 against −4.41 — so when a reranker is configured, its score is what
the gate reads, and unanswerable queries reaching the synthesiser fell from 8/8
to 2/8 at no cost to the answerable ones.

Two details are load-bearing. `lib/rerank.mjs` previously computed the
cross-encoder's score and discarded it, returning only a new order — its stated
rule was "ranking only, never scoring", on the theory that a second score scale
would break a threshold calibrated against the RRF band. The measurement above
falsifies the premise: there was no useful calibration to break. And the gate
reads `resolveRerankConfig(options.rerank).minScore`, not `options.rerank.minScore`,
because a composition setting only `{ url, model }` leaves the latter `undefined`,
and `score >= undefined` is false for every candidate — which would have replaced
a gate that admitted everything with one that rejects everything, silently and in
the opposite direction.

Without a reranker there is no discriminating scale available, so `rrfFloor()`
stands in. It is the threshold automatic recall already used, and it errs toward
missing a memory rather than inventing one, which is the trade this plugin states
it wants.

**Left open, deliberately.** The default `minScore` of `0` is the point where the
cross-encoder's own decision boundary falls — a relevant pair scores positive, an
irrelevant one negative. Two negative queries still clear it (top-1 scores 2.16
and 2.95), and raising the threshold to `3.0` would reject both at the cost of one
answerable query (2.46). That is a real trade and it is configurable, but `3.0`
was not made the default: it is fitted to where those two cases happen to sit in a
16-query calibration set, and a threshold tuned to the sample that produced it is
not a threshold that generalises. The residual leak is the honest cost of a
default chosen on principle. The same reasoning applies to the automatic path,
which has no reranker and so keeps the conservative `rrfFloor()` gate — and,
measured, that gate discards 4 of the 8 answerable queries. That path is
deliberately untouched here; changing it needs its own measurement, because
injecting an unrequested wrong memory into a turn is a different risk from
answering a direct question wrongly.

### 2.24 HIGH — a verbatim abstention sentinel disabled every model under 2B

The synthesis prompt ended its rule list with

```
3. If the fragments do not answer the question, reply exactly: 未找到相关记忆
```

and both call sites tested `outcome.text.includes('未找到相关记忆')`. The intent
was an escape hatch. The effect, on MiniCPM5-1B and Qwen3.5-0.8B, was that the
escape hatch became the only thing they ever produced: **16 of 16 runs
abstained**, including questions whose answer was verbatim in the supplied
fragments.

This was found by ablation, not inference, because the obvious explanations are
all wrong:

| variant | MiniCPM5-1B | Qwen3.5-0.8B | MiniCPM5-2B |
|---|---|---|---|
| sentinel as shipped | ❌ 16/16 abstain | ❌ abstain | ✅ correct |
| delete the sentence | ✅ correct | ✅ correct | ✅ correct |
| narrow the trigger ("only if NONE mention the topic") | ❌ | ❌ | ✅ |
| add a worked counter-example | ❌ | ❌ | ✅ |
| move the rule to the end of the prompt | ❌ | ❌ | ✅ |
| English sentinel (`NOT_FOUND`) | ❌ | ❌ | ✅ |

So it is not the trigger's vagueness, not a missing example, not the rule's
position, not the language, and not model capacity — deleting one line restores
both models. What matters is the shape of the required output: a long,
sentence-like literal that a weak model can copy is the most likely continuation
in the prompt, and it collapses onto it. This also retires an earlier conclusion
of mine recorded elsewhere — that the 0.8B's failure was capacity "proven by
testing both English and Chinese prompts". Both failed *because both carried the
sentinel*; the variable under test was never the one being changed.

**The fix disables the sentinel by default.**
`DSH_G_MEMORY_LLM_SENTINEL` re-enables it. The first draft of this section kept it
on, on the strength of a measurement where MiniCPM5-2B abstained correctly on the
two weak candidates the gate admits — 0% fabricated with the sentinel against 25%
without. Re-measuring through the real plugin path retired that result, and the
reason is worth recording: the probe's own refusal detector had no length bound,
so a long answer that merely mentioned 未找到 counted as an abstention. With the
shipped `isRefusal()`, which bounds a refusal by length because a real answer is a
sentence carrying specifics, the 2B reads 14/16 correct and 25% fabricated either
way — and **every one of its abstentions traces to the relevance gate, not to the
sentinel**. The sentinel's only remaining measurable effect was to make both sub-2B
models abstain on all 16 answerable runs. A defence that never fires for the
capable model and destroys the weaker ones is not a defence.

Detection moved out of a string match into an exported `isRefusal()`, shared by
the tool path and the automatic path so they cannot drift. It recognises the
configured sentinel, the one-character fallback, and a *short* statement of
absence — the length bound exists because the previous broad regex would have
read a real answer as a refusal for containing "无法" inside a sentence that also
carried the specifics.

A methodological note, since this is the third defect in this project caused by
a probe that did not match production: the first measurement of the
no-sentinel variant reported 100% fabrication, because the probe called the
synthesiser with an **empty** fragment list while `lib/index.js` only calls it
when the gate admitted something. Six of those eight cases could not occur in
production. `scripts/eval-real.mjs` exists so that this class of error is no
longer available: it mounts the plugin the way a profile does and calls the tool,
so retrieval, the gate, the prompt and the classifier all belong to the shipped
code.

---

### 2.25 CRITICAL — six deployment defects, every one of them silent

The automatic path injected on 100% of turns (§2.23 fixed the tool path; this is
the same defect one layer down), so the automatic path was given the cross-encoder
gate too. Fixing that surfaced six further defects. All six share a property that
makes them worth reading together: **none of them raises an error a user would
see.** The memory system keeps reporting itself healthy while returning nothing,
or returns the wrong thing, or fails in a way the error message attributes to the
wrong component.

**1. The service supervisor rejected its own engines.** The supervisor fronting
the local models admitted only `/v1/chat/completions` in its POST allowlist —
correct while it served one title model, wrong from the moment it also fronted the
embedding and reranking engines. `/v1/embeddings` and `/v1/rerank` were answered
`404 {"type": "title_supervisor_error"}`, an error that names the title supervisor
for a request that had nothing to do with titles. The allowlist now admits any
`/v1/*` path and forwards the original path through.

**2. The embedding engine was launched without `--embeddings`.** llama-server
answered `501 This server does not support embeddings. Start it with
`--embeddings``, which is at least an accurate message — but it was only reachable
after fixing (1), so the two hid each other.

**3. The physical batch size was left at its default of 512 — and this is the one
that would have been mistaken for a working system.** A memory fragment is capped
at 400 CJK characters, which tokenises to roughly 560 tokens, so *every* rerank
call on real data failed:

```
HTTP 500 {"message":"input (562 tokens) is too large to process.
           increase the physical batch size (current batch size: 512)"}
```

`lib/rerank.mjs` treats a failure as "keep the fused order" — a deliberate rule
from §2.23, so that a down reranker degrades the ranking instead of failing the
recall. But the automatic path scored a non-reranked candidate `-Infinity` (see
6), so the new gate then dropped **everything**. The end state: every query
returns no memory, no error is surfaced, and the plugin reports itself `active`.
The trigger rate would have gone to 0% rather than to a correct 63%, and the only
way to notice would have been to read the debug log. `-ub 2048` on both engines.

**4. `shlex` was used without being imported.** The command-line override added
for the engines raised `name 'shlex' is not defined` on first use. Caught only
because the engines were exercised directly rather than through the plugin.

**5. The supervisor desynced on a reused connection.** With HTTP/1.1 keep-alive,
Node's `fetch` reuses connections by default, and the proxy answered the second
request on a connection incorrectly. The symptom was distinctive and easy to
misread as a server fault: **the first rerank of a process succeeded and every
one after it failed.** Responses now carry `connection: close`.

**6. A missing reranker disabled the automatic path entirely.** The new gate
scored candidates `-Infinity` when reranking was unavailable, and reranking is off
by default — so the default configuration injected nothing. This is the same
mistake as (3) one level up: a defence that cannot run must *degrade*, not *deny*.
It now falls back to the fused score behind `rrfFloor()`, matching the tool path.
This one was caught by the `injection shape` check, which had been **skipping**
rather than failing whenever a recall did not become ready — a skip that had been
read as a pass for as long as it existed, which is precisely the failure mode §3
describes.

**And the trigger rate, measured after all six were fixed**, over 8 answerable and
8 unanswerable queries:

| | before | after |
|---|---|---|
| answerable queries injected | 8/8 | **8/8** |
| unanswerable queries injected | 8/8 | **2/8** |
| trigger rate | 100% | **63%** |

The 63% is measured on a deliberately balanced 50/50 mix and is not a prediction
for real traffic, where answerable turns are a larger share. What matters is the
shape: the gate now says no, at no cost to recall.

**A note on the layering, because the first attempt at it was wrong.** VCPToolBox
separates memory by time scale and leaves its recent tier ungated — but that tier
is a *separate, small layer* (OneRing: the last few cross-window messages).
Applying the same exemption by *age* over one 13k-unit index exempts nearly
everything, because an active corpus keeps most of its units inside the last two
days. Measured with `recentDays: 2`, the gate admitted **8 of 8** unanswerable
queries — the exact defect it was built to remove. Age tiers are therefore off by
default, and a deployment that mounts a genuinely small recent layer should turn
them on deliberately.

**A note on negative test data, because two cases were invalidated by running.**
Two calibration negatives — `北极熊的冬眠周期是多长` and `明代青花瓷使用的钴料来自哪里`
— became *answerable* during this work, because the sessions that discussed them
were themselves indexed, and one later answer reads "属于「不可回答」类别（被正确拒绝）".
That is the system working as designed: it indexes real conversations, including
conversations about its own tests. But it means a hand-written negative has a
shelf life, and the end-to-end check now mints a random token at run time instead
of naming a plausible-sounding question.

---

## 3. The recurring failure: verification that could not fail

Three defects in this project shared one cause, and it was never the code — it
was the method.

1. **A mock that could not reject.** The unit test's fake registry accepted any
   object as a tool definition, so it exercised `apply()` against a registry with
   no ability to fail. The real registry rejects a schema keyword outside the
   Harness subset (`minimum`/`maximum` are not in it), which is exactly what was
   happening — the tool definition was refused, and the tool silently did not
   exist. A permissive stand-in is worse than no test, because it returns a
   confident answer.

2. **An `await` that was never there.** `check()` called its callback
   synchronously, so every `async` assertion returned a pending promise that was
   neither awaited nor caught. Two checks were unconditional greens: not "too
   lenient" but *absent*, while still occupying a passing slot.

3. **Skips recorded as passes.** Described in §2.6: the fewer prerequisites a
   machine had, the better the suite looked.

The generalisation, which now governs this package's tests: **the credibility of
a "pass" depends on whether the check is capable of failing**, and that has to be
established deliberately — it cannot be inferred from a pass rate. Every fix in
this release was confirmed by reintroducing the defect and watching it fail.

A fourth instance points the other way. While adding the index-row validation
above, the author's own new check `vector.length !== header.dim` dropped **every**
row — the stored layout is `[float32 scale][dim int8 codes]`, i.e. `dim + 4`. It
was caught immediately by the end-to-end test, which is the argument for having
one.

---

## 4. Where nothing was found

Stated plainly, because a review that only lists problems is not a review.

- **Shell command injection: none.** Exactly two child processes, both `spawn`
  with an argv array, no `shell: true`, no `exec`/`execSync`, no `fork`.
  Filenames are never interpolated into a command line. §2.10 and §2.11 concern
  *which* binary runs and what it can do, not shell parsing.
- **Path traversal: none.** Every on-disk name is a literal. The tool accepts
  only `query` and `limit` and touches no path. Index content never becomes a
  path.
- **Prototype pollution: none.** All three `JSON.parse` sites assign explicit
  fields; `__proto__` in a row or log event cannot reach a prototype.
- **Dynamic code execution: none.** No `eval`, no `Function`, no listener.
- **Content-driven SSRF: none.** Every URL comes from configuration; no URL is
  derived from indexed content.
- **Credential logging or credential-on-disk: none.** The key is never written
  anywhere by the plugin, never included in an error message, and the credentials
  file is read-only. The defect here was *transmission* (§2.2, §2.4), not storage.
- **Machine-specific values in library code: none.** No home paths, usernames or
  hostnames anywhere in `lib/` or `bin/`, and the Harness location is derived from
  `process.execPath` rather than a hard-coded prefix.
- **Harness event contract: correct.** Both listeners match the published
  signatures, and injected messages carry `source.kind = 'plugin'`, so recall
  output is not re-indexed as a human turn.
- **Supply chain: zero runtime dependencies**, no `link:`/`file:` dependency in
  the manifest, and `npm pack` excludes the index (which contains private session
  text) while including everything needed to run.

---

## 5. Residual risk

| Risk | Why it is accepted |
|---|---|
| Redaction is a denylist and cannot be complete | Synthesis is opt-in; the README states the limitation |
| The embedding endpoint sees raw chunk text | Loopback by default; the README calls it a trust boundary |
| A hostile `zstd` earlier in `PATH` still runs | Unavoidable without vendoring a decompressor; bounded by the output ceiling and the minimal environment |
| The index is a partial copy of conversations | Unavoidable for a retrieval index; stated in the README, written `0600`, excluded from the package |
| The local embedder is unauthenticated | Standard for a loopback `llama-server`; a forged response requires first winning a race for the port |

---

## 6. Verification performed

| Check | Result |
|---|---|
| `npm test` | 29/29 unit + 5/5 loader contract + 5/5 incremental build, exit 0 |
| `npm run test:loader` (Loader contract) | 5/5 — red/green verified at 2/5 and 1/5 |
| `plugincheck` (offline mount check, no restart) | passes; fails non-zero on a rejected definition |
| End-to-end in a live DSH 0.1.6-alpha.2 | `memory_recall` registers and returns framed results |
| Redaction suite | 20/20 (17 must redact, 3 must survive) |
| Privacy assertion | no endpoint configured ⇒ no request issued |
| Recall threshold | 2/5 ⇒ 5/5 queries inject |
| `node --check` on every source file | passes |
| Dead code, `TODO`/`FIXME`, `console.*` in `lib/` | 0 |
| Runtime dependencies | 0 |

---

## 7. Before publishing

- [ ] Add `repository`, `homepage`, `bugs` and `author` to `package.json`.
      `LICENSE` names only "contributors", so no legal entity is identified.
- [x] `scripts/eval-retrieval.mjs` no longer ships a machine-specific default. It
      generates cases from the index under test by default (any machine), and the
      original labelled corpus moved to `scripts/cases.calibration.json`, reached
      through `--cases` / `npm run eval:calibration`.
- [ ] Consider addressing §2.19 (`--out` guard) and §2.22 (freshness signal).
