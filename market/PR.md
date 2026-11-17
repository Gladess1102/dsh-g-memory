<!-- Thanks for contributing! Quick checklist / 提交前快速自查 -->

- [x] I added **one file** at `data/plugins/Gladess1102__dsh-g-memory.yml`
- [x] My repo's `package.json` declares **`dsh.bundle`** (not just `dsh.client`)
- [x] My repo is at least **1 day old**
- [x] `category` is `memory`
- [x] Description states what the plugin does, no superlatives
- [x] My repo has the `dsh-plugin` topic

---

Adds `data/plugins/Gladess1102__dsh-g-memory.yml`.

**What it does.** Cross-session semantic memory for DSH. It indexes the session history locally through an EmbeddingGemma 2 embedding endpoint and recalls the passages relevant to the current turn, injecting them as clearly framed untrusted context. No npm runtime dependencies; synthesis is opt-in.

**Verification against the checklist**

- `package.json` declares `dsh.bundle.patch` → `./cordis.patch.yml`, and that file contains the matching `id`/`name` row
- repo carries the `dsh-plugin` topic
- repo is older than one day and actively maintained (v0.15.0 tagged 2026-11-11)
- real, working code: host plugin, CLI, index builder, and a test suite in the repo
- installs with the command below today

**Status.** Merged 2026-11-14 as awesome-dsh-plugin PR #15216; the entry now
lives at `data/plugins/Gladess1102__dsh-g-memory.yml` and renders at
<https://awesome-dsh-plugin.com/p/Gladess1102/dsh-g-memory/>. The entry was
submitted as a GitHub install because npm was still blocked at the time; the
package reached npm on 2026-11-17 (`0.15.0` from the CLI, `0.15.1` through
trusted publishing), so `dsh plugin --profile <p> add dsh-g-memory` works as
well and the entry can move to the npm form without another PR.

**Install**

```sh
dsh plugin --profile <profile> add github:Gladess1102/dsh-g-memory
```

Category: `memory`. Description states function only; the counts and endpoint names in it match the code (the embedding model is set in `lib/config.mjs`, and `package.json` has no `dependencies` block at all).