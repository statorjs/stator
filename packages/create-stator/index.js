#!/usr/bin/env node
// Stator scaffolder. First-party templates live in the monorepo's
// `examples/` directory and are FETCHED at scaffold time (create-astro
// style) — they update with every push, and `--template` accepts any giget
// source (`github:user/repo/path`) so community templates work for free.
//
// Interactive (clack) when run bare; every prompt has a flag so CI and
// scripts stay prompt-free:
//   pnpm create stator                                → prompts
//   pnpm create stator my-app --template todomvc      → no prompts
//   pnpm create stator my-app -t github:you/your-template
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as p from '@clack/prompts'
import { downloadTemplate } from 'giget'

const TEMPLATES = [
  {
    value: 'minimal',
    label: 'Minimal',
    hint: 'one machine, one page — the smallest real app',
  },
  {
    value: 'todomvc',
    label: 'TodoMVC',
    hint: 'the classic, with server-owned todos and zero-JS editing',
  },
]

/** First-party templates resolve into the monorepo's examples/. */
const FIRST_PARTY = 'gh:statorjs/stator/examples'
/** Scaffolded apps get a real semver for the framework (the examples
 *  themselves use workspace linking in-repo). Bumped with releases. */
const STATOR_RANGE = '^1.1.0'

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    template: { type: 'string', short: 't' },
    ref: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (flags.help) {
  console.log(
    `Usage: pnpm create stator [directory] [--template ${TEMPLATES.map((t) => t.value).join('|')}]`,
  )
  console.log('       pnpm create stator my-app --template github:user/repo/path')
  console.log('       --ref <branch|tag>   fetch first-party templates from a specific ref')
  process.exit(0)
}

p.intro('create-stator')

// --- target directory ---
let target = positionals[0]
if (!target) {
  const answer = await p.text({
    message: 'Where should the project live?',
    placeholder: './my-stator-app',
    validate: (v) => (v.trim() === '' ? 'A directory is required.' : undefined),
  })
  bailIfCancelled(answer)
  target = answer
}
const dest = resolve(process.cwd(), target)

try {
  const existing = await readdir(dest)
  if (existing.length > 0) {
    p.cancel(`${target} exists and is not empty — refusing to overwrite.`)
    process.exit(1)
  }
} catch {
  // does not exist — fine
}

// --- template ---
let template = flags.template
const isRemoteSource = (t) => t.includes(':') || t.includes('/')
if (template && !isRemoteSource(template) && !TEMPLATES.some((t) => t.value === template)) {
  p.cancel(
    `Unknown template "${template}". Available: ${TEMPLATES.map((t) => t.value).join(', ')} ` +
      `(or any giget source, e.g. github:user/repo/path)`,
  )
  process.exit(1)
}
if (!template) {
  const answer = await p.select({ message: 'Which template?', options: TEMPLATES })
  bailIfCancelled(answer)
  template = answer
}

// --- fetch ---
const ref = flags.ref ? `#${flags.ref}` : ''
const source = isRemoteSource(template) ? template : `${FIRST_PARTY}/${template}${ref}`
const s = p.spinner()
s.start(`Fetching ${template}`)
try {
  await downloadTemplate(source, { dir: dest, force: true })
} catch (err) {
  s.stop('Fetch failed')
  p.cancel(
    `Could not download "${source}" — scaffolding needs network access.\n   ${String(err?.message ?? err)}`,
  )
  process.exit(1)
}

// --- stamp ---
const name = basename(dest)
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
const pkgPath = join(dest, 'package.json')
try {
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  pkg.name = name
  // In-repo examples link the framework via the workspace; a scaffolded
  // app pins the published release instead.
  if (pkg.dependencies?.['@statorjs/stator'] === 'workspace:*') {
    pkg.dependencies['@statorjs/stator'] = STATOR_RANGE
  }
  delete pkg.private
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  s.stop(`Scaffolded ${name} (${template})`)
} catch {
  s.stop(`Scaffolded ${name} (${template}) — no package.json to stamp`)
}

p.note([`cd ${target}`, 'pnpm install', 'pnpm dev'].join('\n'), 'Next steps')
p.outro('Docs: https://docs.statorjs.dev · Demo: https://demo.statorjs.dev')

function bailIfCancelled(v) {
  if (p.isCancel(v)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }
}
