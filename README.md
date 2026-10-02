# dsh-g-memory

Cross-session **semantic memory** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DSH already ships an FTS5 full-text index over session history. That finds sessions
whose *titles* or exact tokens match. It cannot answer "what did we decide about the
retry policy three weeks ago". This plugin adds the missing layer: a local,
semantic index of what happened across your sessions, queried on demand.

Retrieval runs entirely on your machine: the only network call is to a **local**
embedding server. Optional LLM synthesis is **off unless you name an endpoint**
(see [Network and privacy](#network-and-privacy)).

---

## What it remembers

| Source | Kept? | Why |
|---|---|---|
| `user/message` (human turns) | ✅ | The actual conversation. Runtime injections (`source.kind = plugin`, e.g. prompt snapshots and reminders) are filtered out — they are not memory and would otherwise dominate the index. |
| `assistant/message` (durable prose) | ✅ | What was concluded, explained or decided. |
| Streaming fragment events (`chunk` families) | ❌ | 84.6% of all events in a typical log; no independent meaning. |
| `tool/result` — measurements, errors, command output | ✅ | **The most fact-dense content in the log.** On the development corpus the strings `5.95`, `-0.000033` and `512 token` appeared **zero** times in conversation prose and *only* in tool output. Without these, the memory can recall "what we discussed" but never "what we measured". |
| `tool/result` — file reads, blob JSON | ❌ | Re-readable on demand, and they crowd out real memories. |

Chunks are cut at **sentence boundaries** (800 chars for prose, 1200 for tool
output, 120-char overlap). This is not cosmetic: fixed-width cutting separated
values from the labels that explain them, and sentence-aligned cutting is what
lets the retrieval arms complement each other.

## Retrieval

Two arms, fused with Reciprocal Rank Fusion:

- **vector** — BGE-M3 (1024-d), int8-quantised, cosine over every unit
- **lexical** — adjacent-character **bigram** tokenisation over CJK plus whole
  Latin words, idf-weighted

Measured on this machine's corpus with 8 labelled Chinese queries:

| Arm | top-1 | top-3 | top-20 |
|---|---|---|---|
| vector | 4/8 | 5/8 | 7/8 |
| lexical (bigram) | 5/8 | 6/8 | 7/8 |
| **RRF fusion** | 4/8 | 6/8 | **8/8** |

Two findings worth knowing:

1. **CJK needs bigram tokenisation.** With naive substring matching the lexical
   arm scored 4/8; bigrams took it to 5/8 — *better than the vector arm*. DSH's
   built-in FTS5 uses `unicode61`, which treats a whole CJK run as one token and
   has the same blind spot.
2. **The retriever is tuned for recall, not precision.** The best top-1 across
   the three arms is 5/8 (62.5%) — the lexical arm — so no arm is reliable at
   rank 1, while the fused top-20 is 8/8. Getting the right unit *into the
   candidate pool* is this layer's job; choosing the answer is the consumer's.

## Storage

int8 quantisation is effectively lossless here: mean cosine distortion
`-0.000033`, max `0.003191`, top-1 agreement with float32 `5/5`. zstd then
compresses int8 noticeably better than float32 (1.51× vs 1.19× at 2,897 units;
about 2.0× at the current index size, because it is dominated by 1 KB vectors
rather than by text).

| Representation | 10,823 units |
|---|---|
| int8 codes + scales | 23.7 MiB (`index.ndjson`) |
| **int8 + zstd-19** | **9.09 MiB** (`index.ndjson.zstd`) |
| on disk, both | **32.8 MiB** |

**What is stored is chunk text, not just pointers.** The index holds the
extracted chunks themselves — 6.7 M characters at the size above, being 800- and
1200-char slices of user messages, assistant prose and selected tool output. So
the index is a partial copy of your conversations and should be treated as
sensitive: it is written `0600` inside a `0700` directory for that reason.

`index.ndjson` (uncompressed) is written as a fallback for when the `zstd` CLI is
unavailable; `readIndex` prefers the compressed copy. Delete the uncompressed
one to reclaim two thirds of the space — it is rebuilt on the next `build`.

## Requirements

- Node.js >= 20 (`toWellFormed`, `AbortSignal.timeout`).
- The **`zstd` CLI on `PATH`**, or `DSH_G_MEMORY_ZSTD` pointing at one. This is a
  hard requirement, not an optimisation: DSH writes session logs as a sequence of
  independently flushed zstd frames, which `node:zlib` refuses, so indexing
  cannot read them without it. Note that stock macOS does **not** ship `zstd`
  (`brew install zstd`).
- A BGE-M3-compatible `/v1/embeddings` endpoint for building the index and for
  every query. `llama-server` with an embedding model works; see `DSH_G_MEMORY_EMBED_URL`.

## Install

This package is a **Host-only bundle**: it registers one model-callable tool and
declares no `dsh.client` block, because it has no browser half. Its
`package.json` carries `dsh.bundle.patch`, so the insert row that mounts the
plugin travels *with the package* rather than being hand-written into each
profile.

On DSH 0.1.6 and later, install it through the Plugin Manager, which performs
package installation and bundle selection and can also unload it at runtime.
`install_bundle` takes an absolute path to a package directory; the call needs
`danger-full-access` (or approval), because it runs a package install.

```
plugin_manager { action: install_bundle, target: "/absolute/path/to/dsh-g-memory" }
```

From the shell, the equivalent for a published package is:

```bash
npm install -g dsh-g-memory        # or: npm install dsh-g-memory  (per project)
dsh-g-memory selfcheck             # is the embedding endpoint reachable?
dsh-g-memory build                 # build the index from $DSH_HOME/sessions
```

Then check the mount, which needs no restart:

```bash
dsh-g-memory plugincheck
```

If you installed into a profile rather than globally, the binary lives beside the
package and the profile directory is your working directory:

```bash
cd ~/.dsh/profiles/web
node node_modules/dsh-g-memory/bin/dsh-g-memory.mjs build
```

Installing a **new** bundle activates through HMR, so no restart is needed.
Replacing an already-installed package does need one, to load a fresh module
generation.

To remove it: `plugin_manager { action: remove_bundle, target: "dsh-g-memory" }`.
Nothing else is left behind — the index directory holds two files (the compressed
index and an uncompressed fallback) and can be deleted on its own.

### Export shape (why there is no `export default`)

A Host plugin must export `name`, `apply`, and an `inject` list naming every
service it reads. This package exports exactly those three and **no default**,
for two reasons that are easy to get wrong and invisible when you do:

- The Loader resolves a plugin module as `exports.default ?? exports`, so a
  default export discards every named export — `inject` included.
- Without a declared `inject`, a service is simply absent while `apply()` runs:
  the Loader derives each fiber's start from its declared dependencies. The
  plugin then returns early and the fiber still reports `active`, so the
  capability vanishes with nothing logged and nothing failing.

`scripts/test-loader-contract.mjs` drives the real Cordis through both rules, in
both load orders, so neither mistake can ship again. Both are documented in
`docs/SECURITY-REVIEW.md`.

### Reranking (recommended)

Fusion is tuned for recall — on a real 12k-unit index, fused **recall@20 is 8/8
while top-1 is only 4/8**. The answer is nearly always in the candidate pool;
the *ranking* is what fails. A cross-encoder fixes exactly that, because it
scores a (query, document) pair together rather than comparing two independently
produced vectors.

Run any llama.cpp reranker (for example `bge-reranker-v2-m3`) and point the
plugin at it:

```bash
llama-server -m bge-reranker-v2-m3-Q8_0.gguf --rerank --port 11436 -c 2048
export DSH_G_MEMORY_RERANK_URL=http://127.0.0.1:11436
```

Measured effect: **top-1 4/8 → 7/8, top-3 6/8 → 8/8, no case regressed.**

The reranker also supplies the score the relevance gate reads, and that is not a
detail — it is what stops the synthesiser being handed irrelevant fragments. The
fused RRF score cannot do that job: measured over 8 answerable and 8 deliberately
unanswerable queries, the two sets occupy one overlapping band (top-1 RRF
0.0159–0.0315 against 0.0145–0.0298), because a query hitting a single arm at a
low rank lands near the `1/61` floor however irrelevant it is. The cross-encoder
scores them at medians of 5.64 and −4.41 instead. Gating on it took unanswerable
queries reaching the synthesiser from 8/8 to 2/8 while keeping all 8 answerable
ones. `DSH_G_MEMORY_RERANK_MIN_SCORE` (default `0`) moves that gate.

Two further behaviours worth knowing: any failure falls back to the fused order,
so a reranker that is down makes recall worse, never broken — and without a
reranker configured the gate falls back to `rrfFloor()`, the same conservative
threshold automatic recall uses.

### Reasoning is off by default

Synthesis condenses three fragments; it does not reason. Thinking costs real
time and tokens here, and measured on MiniCPM5-2B it also *hurt accuracy* — the
same cases went from a false negative and an empty completion to 24/24 correct
with thinking disabled, at 1.4 s and 15 output tokens instead of 3.9 s and 59.
Set `DSH_G_MEMORY_LLM_THINKING=on` if your endpoint rejects the extra field.

## Manual recall

Memory is reachable three ways, and they are independent:

| How | Who starts it | Reaches the model? |
|---|---|---|
| `memory_recall` tool | the model decides | yes, as the tool result |
| Automatic recall | the plugin, on each user message | yes, as framed context |
| **`/recall <query>`** | **you** | **yes — shown to you and injected on the next step** |

`/recall` exists because the other two are both guesses about when memory is
wanted. Typing it is not a guess:

```
/recall what did we decide about the embedding batch size
```

The result is returned to the conversation and, at the same time, armed for the
model's next step — so the memory reaches the model rather than only being
printed for you. It is consumed exactly once, like automatic recall, so a manual
recall colours one turn and does not linger.

Two deliberate behaviours: the command ignores `DSH_G_MEMORY_AUTO` (an explicit
request is not speculation), but it does respect the `DSH_G_MEMORY_ENABLED` kill
switch. And it is registered only when the profile has the commands service; a
profile without it still gets the tool and automatic recall.

## Network and privacy

| What | Where it goes | When |
|---|---|---|
| Chunk text for embedding | `DSH_G_MEMORY_EMBED_URL` (default `http://127.0.0.1:11439`) | Every `build`, and every query |
| Query + top candidates for synthesis | `DSH_G_MEMORY_LLM_URL` | Only if you set that variable |

Two consequences worth stating plainly:

- **Synthesis is opt-in and has no default endpoint.** With `DSH_G_MEMORY_LLM_URL`
  unset there is no synthesis at all, and the plugin tells you so rather than
  guessing at a URL. Nothing about your sessions leaves the machine unless you
  name a destination for it.
- **Pointing `DSH_G_MEMORY_EMBED_URL` at a remote host sends it everything.**
  The embedding endpoint receives raw, unredacted chunk text — redaction applies
  to the synthesis path only, because that is the path designed to cross a trust
  boundary. Treat the embedding endpoint as a trust boundary too.

When synthesis *is* configured, the query and the candidate text are redacted
before they are sent (private keys — a PEM block is kept whole by the chunker so
the `BEGIN`/`END` pair survives, cloud and provider tokens including
`sk_live_…`/`rk_live_…`, `NAME=value` assignments for anything named like a secret,
emails, home paths and non-loopback IPs). Redaction is a denylist and therefore incomplete: the control that matters
is that synthesis does not run unless you asked for it.

## Configuration

All optional; defaults suit a single-machine setup.

| Variable | Default | Purpose |
|---|---|---|
| `DSH_G_MEMORY_ENABLED` | `on` | Master kill switch. `off` disables both tool and auto-recall. |
| `DSH_G_MEMORY_AUTO` | `on` | Automatic recall. `off` keeps only the explicit tool. |
| `DSH_G_MEMORY_AUTO_MIN_SCORE` | `0.01639` | Minimum fused score before anything is injected. RRF scores are quantised: one arm at rank 0 scores `1/61 = 0.01639`, both arms at rank 0 score `2/61 = 0.03279`, and **nothing falls between**. The default is the floor, so any single-arm hit counts; raise it to `0.03279` to require that both arms agree. |
| `DSH_G_MEMORY_EMBED_URL` | `http://127.0.0.1:11439` | Embedding endpoint. |
| `DSH_G_MEMORY_EMBED_MODEL` | `embed-gemma` | Model name sent to the endpoint. |
| `DSH_G_MEMORY_LLM_URL` | *(unset)* | Synthesis chat endpoint; unset disables synthesis. |
| `DSH_G_MEMORY_LLM_MODEL` | `deepseek-v4-flash` | Synthesis model. |
| `DSH_G_MEMORY_SYNTHESIS` | `on` | Set `off` to skip synthesis entirely. |
| `DSH_G_MEMORY_CACHE_ENTRIES` | `256` | Synthesis cache size. |
| `DSH_G_MEMORY_CACHE_TTL_MS` | `86400000` | Cache entry lifetime. |
| `DSH_G_MEMORY_ZSTD` | `zstd` | Path to the zstd binary. |
| `DSH_G_MEMORY_INDEX_DIR` | `$DSH_HOME/dsh-g-memory/index` | Where the index lives. |
| `DSH_G_MEMORY_MAX_LOG_BYTES` | `268435456` | Refuse to decompress a session log past this size. |
| `DSH_G_MEMORY_MAX_INDEX_BYTES` | `536870912` | Same ceiling for the index. |
| `DSH_G_MEMORY_AUTO_CANDIDATES` | `8` | Candidate pool depth handed to synthesis. |
| `DSH_G_MEMORY_SYNTHESIS_MAX_CHARS` | `1200` | Synthesis output cap. |
| `DSH_G_MEMORY_LLM_TIMEOUT_MS` | `60000` | Synthesis request timeout. |
| `DSH_G_MEMORY_AUTO_STATS` | *(unset)* | Path to a JSONL decision log: one line per gate, injection, skip and failed recall. `scripts/telemetry-report.mjs` reads it. Unset means no telemetry. |
| `DSH_G_MEMORY_RERANK_KEY` | — | Bearer token for the reranker, if it needs one. |
| `DSH_G_MEMORY_RERANK_PATH` | `/v1/rerank` | Reranker route, for servers that do not use the default. |
| `DSH_G_MEMORY_RERANK_TIMEOUT_MS` | `30000` | Rerank request timeout. |
| `DSH_G_MEMORY_CARDS` | `$DSH_HOME/dsh-g-memory/cards.ndjson` | Card store path. |
| `DSH_G_MEMORY_CARD_MIRROR` | `on` | `off` disables the human-readable `cards/MEMORY.md` mirror, for reading as well as writing. |

Every knob below can also be set per deployment in the composition
(`config.policy`), which takes precedence over the environment:

| Variable | Default | Purpose |
|---|---|---|
| `DSH_G_MEMORY_GATE` | `0` | Final-score floor for the long-term tier, on the cross-encoder's scale (relevant pairs score positive). |
| `DSH_G_MEMORY_MARGIN_GATE` | `0` (off) | Head-margin floor for the automatic path: inject nothing when `score[0] − score[2]` falls below it. Measured on this corpus (134 answerable, 8 unanswerable): AUC 0.786, and at `1.18` the negatives admitted fall 8/8 → 2/8 while **24% of answerable turns lose their memory**. Off by default because eight negatives is thin evidence. |
| `DSH_G_MEMORY_RECENT_DAYS` | `0` | Age still counted as the recent tier. `0` disables the tier, because VCP's recent layer is a small separate window, not "anything from today" — applied by age over one index it exempts nearly everything. |
| `DSH_G_MEMORY_RECENT_GATE` | `-Infinity` | Floor for the recent tier. |
| `DSH_G_MEMORY_MID_DAYS` | `7` | Age still counted as the mid tier. |
| `DSH_G_MEMORY_MID_GATE` | `-1` | Floor for the mid tier. |
| `DSH_G_MEMORY_DECAY_DAYS` | `0` (off) | `::TimeDecay` period. Off by default: VCP warns it does not suit permanent settings. |
| `DSH_G_MEMORY_DECAY_FACTOR` | `0.5` | Score multiplier removed per decay period. |
| `DSH_G_MEMORY_K_MULTIPLIER` | `1` | Dynamic K — a multiplier on the requested entry count, not a fixed number. |
| `DSH_G_MEMORY_BRIEF_SCORE` | `2` | Score at or above which a candidate gets the full preview. |
| `DSH_G_MEMORY_BRIEF_CHARS` | `200` | Preview size for a marginal candidate. |
| `DSH_G_MEMORY_FULL_CHARS` | `400` | Preview size for a confident one. |
| `DSH_G_MEMORY_MAX_ENTRIES` | `3` | Hard cap on injected entries. |
| `DSH_G_MEMORY_MAX_TOTAL_CHARS` | `1200` | Hard cap on the **whole injected block**, frame included. |
| `DSH_G_MEMORY_RECALL_MODE` | `hybrid` | `context` (inject only), `tools` (tool only) or `hybrid`. |
| `DSH_G_MEMORY_CONSOLIDATE` | `off` | Enables the self-cycling consolidation pass. |
| `DSH_G_MEMORY_CONSOLIDATE_HOURS` | `24` | Minimum interval between consolidation runs. |
| `DSH_G_MEMORY_CONSOLIDATE_MIN_TURNS` | `5` | Material gate: turns a session needs before it is worth distilling. |
| `DSH_G_MEMORY_CONSOLIDATE_IDLE_MS` | `600000` | Idle time that counts as "this session finished". |

## CLI

```bash
node bin/dsh-g-memory.mjs plugincheck      # verify the mount WITHOUT restarting DSH
node bin/dsh-g-memory.mjs selfcheck        # verify the embedding endpoint
node bin/dsh-g-memory.mjs build            # build the index from session logs
node bin/dsh-g-memory.mjs build --no-tool  # conversation only (smaller index)
node bin/dsh-g-memory.mjs stats            # composition and on-disk size
node bin/dsh-g-memory.mjs recall "when did we fix the title server?"
```

### `plugincheck` — run this after changing the tool definition

A plugin that fails while loading costs **only its own tool**. Nothing else
breaks, no message appears in the conversation, and the harness looks perfectly
healthy — the tool is just quietly absent from the list. Nothing in the model's
view hints that memory exists and is broken.

The usual cause is a tool schema the registry rejects. The Harness accepts a
deliberately small JSON Schema subset — `type`, `oneOf`, `properties`,
`required`, `additionalProperties`, `items`, `enum`, `const`, plus `description`
/ `title` / `default` / `examples` — and throws from `register()` on anything
else. `minimum` and `maximum` are **not** in it, which is why the `limit`
parameter carries an `enum` instead.

`plugincheck` loads `lib/index.js` through a fake registry that applies the
registry's real preconditions, using the Harness's own `assertSupportedJsonSchema`
when a checkout is reachable. It exits non-zero on a definition the real registry
would reject, so the failure surfaces in a second instead of after a restart spent
wondering why the tool never appeared.

```bash
node bin/dsh-g-memory.mjs plugincheck
# plugin       dsh-g-memory
# tool         memory_recall (timeout 60000ms)
# result       OK — the registry accepts this definition
```

`DSH_CHECKOUT` overrides the checkout path it looks for the validator in.

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `DSH_G_MEMORY_EMBED_URL` | `http://127.0.0.1:11439` | embedding endpoint |
| `DSH_G_MEMORY_EMBED_MODEL` | `embed-gemma` | model name sent to the endpoint |
| `DSH_G_MEMORY_EMBED_TIMEOUT_MS` | `120000` | per-request timeout |
| `DSH_G_MEMORY_EMBED_KEY` | — | bearer token, if the endpoint needs one |
| `DSH_G_MEMORY_ZSTD` | `zstd` | path to the zstd binary |
| `DSH_G_MEMORY_RERANK_MAX_CHARS` | `300` | how much of each document the cross-encoder reads; `0` sends the whole document |
| `DSH_G_MEMORY_LIVE` | `on` | keep the index current from session events without a manual build |
| `DSH_G_MEMORY_LIVE_DEBOUNCE_MS` | `30000` | how often the debounced worker wakes up |
| `DSH_G_MEMORY_LIVE_QUIET_MS` | `90000` | a session must be quiet this long before it is indexed |
| `DSH_G_MEMORY_LIVE_MAX_UNITS` | `400` | units embedded per pass |
| `DSH_G_MEMORY_LIVE_BUDGET_MS` | `20000` | wall-clock budget per pass |
| `DSH_G_MEMORY_CARD_MIN_SIMILARITY` | `0.35` | how similar a card must be to be admitted when no reranker is configured; `0` disables the rule |
| `DSH_G_MEMORY_SYNTHESIS_MARGIN` | `0.2` | synthesise only when the top-two score gap is below this — i.e. when the entries must be assembled; `0` never synthesises and returns verbatim entries |

## Tests

```bash
npm test            # the full chain: 12 stages, ~170 checks, no network, no models
npm run test:strict # same, but every skip counts as a failure (release check)
```

The suite is hermetic — stub endpoints, fixture indexes, temp directories — with two
deliberate exceptions: the JSON-schema validator and the Cordis loader are driven for
real, because a mock registry once hid the most likely way this plugin breaks (the
tool silently missing after a restart). Those two need a DSH installation. Without
one they fail, unless `DSH_MEMORY_ALLOW_MISSING_HARNESS=1` is set, which records a
skip and says so in the summary.

CI sets that flag, because a clean runner cannot have the Harness: `@deepseek-ai/dsh`
and even `@deepseek-ai/cordis` depend on packages that are not published
(`@deepseek-ai/dsh-desktop-host` returns 404 from the registry). Everything else —
retrieval, gating, provenance, redaction, cards, the incremental build, live indexing,
consolidation, and a hermetic end-to-end run — runs there on Node 20 and 22.

## License

MIT. This implementation is original work; it borrows *ideas* from several
agent-memory systems (recall-oriented candidate fusion via reciprocal rank
fusion, evidence-preserving synthesis prompts, explicit emptiness over padding)
but contains no third-party code.

It has no runtime dependencies at all, including on the Harness itself: the Host
half reads the `tools` service off `ctx` and never imports a `@deepseek-ai/*`
package. That is deliberate — a bundled dependency would pin this plugin to one
DSH build. `scripts/test-plugin.mjs` and `bin/dsh-g-memory.mjs plugincheck` reach
into a checkout only when one is present, to validate against its schema rules,
and degrade to a weaker check when it is not.
