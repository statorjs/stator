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
import { spawn, spawnSync } from 'node:child_process'
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
  {
    value: 'desksmith',
    label: 'Desksmith',
    hint: "the tutorial's finished app — catalog, cart, checkout, theme island",
  },
  {
    value: 'live-poll',
    label: 'Live poll',
    hint: 'shared app-machine state, pushed to every visitor over SSE',
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
    install: { type: 'boolean' },
    'no-install': { type: 'boolean' },
    git: { type: 'boolean' },
    'no-git': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  },
})

/** The package manager that LAUNCHED us (`pnpm create stator` → pnpm), via
 *  the standard npm_config_user_agent header. Defaults to npm. */
function detectPackageManager() {
  const agent = process.env.npm_config_user_agent ?? ''
  if (agent.startsWith('pnpm')) return 'pnpm'
  if (agent.startsWith('yarn')) return 'yarn'
  if (agent.startsWith('bun')) return 'bun'
  return 'npm'
}
const pm = detectPackageManager()
const runCmd = (script) => (pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`)

/** Resolve a yes/no choice: explicit flag > --yes > prompt (TTY) > safe
 *  default for non-interactive runs. */
async function decide({ yesFlag, noFlag, message, fallback }) {
  if (yesFlag) return true
  if (noFlag) return false
  if (flags.yes) return true
  if (!process.stdout.isTTY) return fallback
  const answer = await p.confirm({ message, initialValue: true })
  bailIfCancelled(answer)
  return answer
}

if (flags.help) {
  console.log(
    `Usage: pnpm create stator [directory] [--template ${TEMPLATES.map((t) => t.value).join('|')}]`,
  )
  console.log('       pnpm create stator my-app --template github:user/repo/path')
  console.log('       --ref <branch|tag>     fetch first-party templates from a specific ref')
  console.log('       --install/--no-install install dependencies after scaffolding')
  console.log('       --git/--no-git         initialize a git repository')
  console.log('       -y, --yes              accept all defaults (install + git)')
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

// --- install? ---
const wantInstall = await decide({
  yesFlag: flags.install,
  noFlag: flags['no-install'],
  message: `Install dependencies with ${pm}?`,
  fallback: false,
})
let installed = false
if (wantInstall) {
  const si = p.spinner()
  si.start(`Installing with ${pm}`)
  installed = await new Promise((done) => {
    const child = spawn(pm, ['install'], { cwd: dest, stdio: 'ignore', shell: true })
    child.on('close', (code) => done(code === 0))
    child.on('error', () => done(false))
  })
  si.stop(installed ? 'Dependencies installed' : `${pm} install failed — run it yourself`)
}

// --- git? ---
const wantGit = await decide({
  yesFlag: flags.git,
  noFlag: flags['no-git'],
  message: 'Initialize a git repository?',
  fallback: false,
})
if (wantGit) {
  const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  if (hasGit) {
    spawnSync('git', ['init', '-q'], { cwd: dest, stdio: 'ignore' })
    spawnSync('git', ['add', '-A'], { cwd: dest, stdio: 'ignore' })
    // May no-op if user.name/email are unset — an initialized repo without
    // a first commit is still a win.
    spawnSync('git', ['commit', '-q', '-m', 'Initial commit from create-stator'], {
      cwd: dest,
      stdio: 'ignore',
    })
    p.log.success('Initialized a git repository')
  } else {
    p.log.warn('git not found — skipped repository setup')
  }
}

p.note(
  [`cd ${target}`, ...(installed ? [] : [`${pm} install`]), runCmd('dev')].join('\n'),
  'Next steps',
)
p.outro('Docs: https://docs.statorjs.dev · Demo: https://demo.statorjs.dev')

function bailIfCancelled(v) {
  if (p.isCancel(v)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }
}
