# Market index

`scripts/gen-market-index.mjs` turns this repository into a format-1 DSH plugin
market index — the document that "Plugins → Discover → Index sources" reads and
that the `plugin_market` agent tool searches. The shape is fixed by the host's
`@deepseek-ai/dsh-plugin-market` zod schema, so the generator exists to keep the
hand-written metadata (`market/catalog-entry.yml`, `market/copy.json`) honest
rather than to invent a format of its own.

## Regenerate

```sh
node scripts/gen-market-index.mjs                 # git source, pinned to HEAD
node scripts/gen-market-index.mjs --source npm    # one row per published version
node scripts/gen-market-index.mjs --out dist/index.json
node scripts/gen-market-index.mjs --check         # validate, write nothing
```

`--check` builds the document in memory and validates every entry (name,
description, at least one version, and a source of either `npm` or a full
40-character commit on an https URL). It is the gate to run before committing a
change to the generator; it does not compare against the file already on disk.

## The two sources

| `--source` | `versions[]` rows | Use when |
|---|---|---|
| `git` (default) | the version in `package.json`, pinned to the current commit | the package is not on npm yet, or you want the index to track main |
| `npm` | every published version, newest first | the package is live and users should install from npm |

The git form is what makes the index publishable *before* the first npm release:
the entry carries `{ type: 'git', url, commit }`, which the host can install
directly.

## Why `0.0.0-stage` is filtered out

npm's staged publishing reserves a placeholder version (`0.0.0-stage`, a few
hundred bytes, description "Temporary package placeholder for staged
publishing") before the real tarball is approved. It stays in the registry
document next to real versions. An index built straight from that list would
advertise a version that installs nothing, so the generator drops it.

## Files

| path | role |
|---|---|
| `market/index.json` | generated document (committed, so the repo serves it directly) |
| `market/catalog-entry.yml` | the one-file entry a market PR asks for |
| `market/copy.json` | en/zh descriptions, kept in sync with the entry |
| `market/PR.md` | the PR body, including what was verified against the checklist |
