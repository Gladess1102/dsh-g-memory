#!/usr/bin/env node
/**
 * Generate a format-1 DSH plugin market index for this repository.
 *
 * The document is what Plugins → Discover → Index sources reads, and what the
 * plugin_market agent tool searches. Its shape is defined by the host's
 * @deepseek-ai/dsh-plugin-market zod schema: a header ({ format: 1, title,
 * description, metadata }) plus one entry per plugin. Each entry's
 * versions[].source is either
 *
 *   { type: 'npm', registry? }                          — a published version
 *   { type: 'git', url, commit, path? }                 — a pinned commit
 *
 * so an index can be published before the package ever reaches npm.
 *
 * Usage
 *   node scripts/gen-market-index.mjs                 # git source, HEAD commit
 *   node scripts/gen-market-index.mjs --source npm    # published npm versions
 *   node scripts/gen-market-index.mjs --out dist/index.json
 *   node scripts/gen-market-index.mjs --check         # verify, write nothing
 */

import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

const sourceKind = arg('--source', 'git')
const outPath = resolve(root, arg('--out', 'market/index.json'))
const checkOnly = process.argv.includes('--check')

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const meta = JSON.parse(await readFile(resolve(root, 'market/meta.json'), 'utf8'))
const copy = JSON.parse(await readFile(resolve(root, 'market/copy.json'), 'utf8'))

const repoUrl = (pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '')
const [, owner, repo] = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/) ?? []

if (!owner) throw new Error('package.json repository.url must be a github https URL, got: ' + repoUrl)

function git(...a) {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
}

function compareSemver(a, b) {
  const [ac, ap] = a.split('-')
  const [bc, bp] = b.split('-')
  const av = ac.split('.').map(Number)
  const bv = bc.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (av[i] !== bv[i]) return bv[i] - av[i]
  }
  if (ap === bp) return 0
  if (ap === undefined) return -1
  if (bp === undefined) return 1
  return bp.localeCompare(ap)
}

async function npmVersions(name) {
  const res = await fetch('https://registry.npmjs.org/' + name, {
    headers: { accept: 'application/json' }
  })
  if (!res.ok) throw new Error('registry responded ' + res.status + ' for ' + name)
  const data = await res.json()
  const times = data.time ?? {}
  const versions = Object.keys(data.versions ?? {})
    // Staged publishing reserves a `0.0.0-stage` placeholder before the real
    // version lands. It is not installable content, so it never belongs in an
    // index entry even when the registry still lists it.
    .filter((version) => version !== '0.0.0-stage')
    .map((version) => ({
      version,
      publishTimestamp: Math.floor(new Date(times[version]).getTime() / 1000),
      source: { type: 'npm' },
      engines: data.versions[version].engines ?? {}
    }))
    .sort((x, y) => compareSemver(x.version, y.version))
  if (versions.length === 0) throw new Error(name + ' has no published versions')
  return versions
}

const versions =
  sourceKind === 'npm'
    ? await npmVersions(pkg.name)
    : [
        {
          version: pkg.version,
          publishTimestamp: Number(git('log', '-1', '--format=%ct')),
          source: { type: 'git', url: repoUrl, commit: git('rev-parse', 'HEAD') },
          engines: pkg.engines ?? {}
        }
      ]

const index = {
  format: 1,
  title: meta.title,
  description: meta.description,
  metadata: { categories: meta.categories },
  plugins: [
    {
      name: pkg.name,
      title: owner + '/' + repo,
      description: copy,
      homepage: repoUrl,
      repository: { url: repoUrl },
      metadata: {
        category: 'memory',
        keywords: [],
        labels: [],
        sortKeys: {}
      },
      versions
    }
  ]
}

if (index.format !== 1) throw new Error('format must be 1')
if (index.plugins.length === 0) throw new Error('index has no plugins')
for (const plugin of index.plugins) {
  if (!plugin.name || !plugin.title || !plugin.repository?.url) {
    throw new Error('entry is missing name/title/repository: ' + plugin.name)
  }
  if (!plugin.description?.en) throw new Error('entry needs description.en: ' + plugin.name)
  if (plugin.versions.length === 0) throw new Error('entry has no versions: ' + plugin.name)
  for (const v of plugin.versions) {
    if (!v.version || !Number.isFinite(v.publishTimestamp)) {
      throw new Error('bad version row in ' + plugin.name)
    }
    const s = v.source ?? {}
    if (s.type === 'npm') continue
    if (s.type === 'git' && /^[0-9a-f]{40}$/.test(s.commit ?? '') && /^https:\/\//.test(s.url ?? '')) continue
    throw new Error('unsupported source in ' + plugin.name + ': ' + JSON.stringify(s))
  }
}

const text = JSON.stringify(index, null, 2) + '\n'

if (checkOnly) {
  console.log('ok: ' + index.plugins.length + ' plugin(s), ' + versions.length + ' version row(s), source=' + sourceKind)
} else {
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, text, 'utf8')
  console.log('wrote ' + outPath)
  console.log('  entries: ' + index.plugins.length + ', versions: ' + versions.length + ', source: ' + sourceKind)
  console.log('  install: ' + (sourceKind === 'npm' ? 'dsh plugin --profile <p> add ' + pkg.name : 'dsh plugin --profile <p> add github:' + owner + '/' + repo))
}
