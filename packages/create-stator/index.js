#!/usr/bin/env node
// Stator scaffolder. Interactive (clack) when run bare; every prompt has a
// flag so CI and scripts stay prompt-free:
//   pnpm create stator            → prompts for directory + template
//   pnpm create stator my-app --template minimal   → no prompts
import { cp, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import * as p from '@clack/prompts'

const TEMPLATES = [
  {
    value: 'minimal',
    label: 'Minimal',
    hint: 'one machine, one page — the smallest real app',
  },
]

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    template: { type: 'string', short: 't' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (flags.help) {
  console.log(
    `Usage: pnpm create stator [directory] [--template ${TEMPLATES.map((t) => t.value).join('|')}]`,
  )
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
if (template && !TEMPLATES.some((t) => t.value === template)) {
  p.cancel(`Unknown template "${template}". Available: ${TEMPLATES.map((t) => t.value).join(', ')}`)
  process.exit(1)
}
if (!template) {
  if (TEMPLATES.length === 1) {
    template = TEMPLATES[0].value
  } else {
    const answer = await p.select({ message: 'Which template?', options: TEMPLATES })
    bailIfCancelled(answer)
    template = answer
  }
}

// --- scaffold ---
const s = p.spinner()
s.start('Copying template')
const templateDir = fileURLToPath(new URL(`./templates/${template}`, import.meta.url))
await cp(templateDir, dest, { recursive: true })

// npm strips dotfiles from published packages; ship as _gitignore and rename.
try {
  await stat(join(dest, '_gitignore'))
  await rename(join(dest, '_gitignore'), join(dest, '.gitignore'))
} catch {
  // already named .gitignore (running from the repo)
}

const name = basename(dest)
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
const pkgPath = join(dest, 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
pkg.name = name
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
s.stop(`Scaffolded ${name} (${template})`)

p.note([`cd ${target}`, 'pnpm install', 'pnpm dev'].join('\n'), 'Next steps')
p.outro('Docs: https://docs.statorjs.dev · Demo: https://demo.statorjs.dev')

function bailIfCancelled(v) {
  if (p.isCancel(v)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }
}
