// Generate the docs "Changelog" page from the monorepo root CHANGELOG.md.
// Single source of truth — the root file stays the record; this just wraps it
// with Starlight frontmatter so the docs site can host it. Runs pre-dev and
// pre-build (see apps/docs/package.json); the output is gitignored.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..') // apps/docs/scripts → repo root
const src = resolve(root, 'CHANGELOG.md')
const out = resolve(here, '../src/content/docs/changelog.md')

let body = readFileSync(src, 'utf8')
// The page title comes from frontmatter, so drop the file's own `# Changelog`
// h1 to avoid a duplicate heading (keep the intro prose that follows it).
body = body.replace(/^#\s+Changelog\s*\n/, '')

const frontmatter = `---
title: Changelog
description: "Release stories for @statorjs/stator — the arc of each minor. Per-package changelogs (the complete mechanical record) live in each package's own CHANGELOG.md."
sidebar:
  order: 99
tableOfContents: false
---

<!-- GENERATED from the repo-root CHANGELOG.md by scripts/sync-changelog.mjs. Do not edit here. -->

`

writeFileSync(out, frontmatter + body.trimStart())
console.log(`docs: synced changelog → ${out.replace(`${root}/`, '')}`)
