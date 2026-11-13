// Smoke test for the starters: what `pnpm create stator` hands a new user has
// to install, check, test, build and serve, OUTSIDE this workspace.
//
// Inside the monorepo an example resolves the framework through the workspace
// and borrows the root's dev dependencies, so it can pass every check here and
// still be broken as a starter: a dependency it never declared, a file that
// only exists in the repo, a script its README names that it does not have.
//
// For each template the scaffolder offers, this runs the real scaffolder
// against the working tree's examples, points the app at a packed copy of the
// framework as it would be published, and runs each script a new user would.
//
//   node scripts/starter-smoke.mjs            every template
//   node scripts/starter-smoke.mjs minimal    just these
//
// Needs network for `pnpm install` of each app's public dependencies.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scaffolder = join(repo, 'packages/create-stator/index.js')
const templates = [...readFileSync(scaffolder, 'utf8').matchAll(/^\s+value: '([\w-]+)',$/gm)].map(
  (m) => m[1],
)
const wanted = process.argv.slice(2)
const selected = wanted.length > 0 ? wanted : templates
const pnpmVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).packageManager

const work = mkdtempSync(join(tmpdir(), 'stator-starters-'))
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts })
const tail = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n')

const packed = run('pnpm', ['pack', '--pack-destination', work], {
  cwd: join(repo, 'packages/stator'),
})
const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'))
if (packed.status !== 0 || !tarball) {
  console.error(`could not pack the framework\n${tail(packed)}`)
  process.exit(1)
}

/** Start the built app, fetch its home page, stop it. */
async function serves(dir, port) {
  const child = spawn('pnpm', ['start'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  })
  try {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250))
      try {
        const res = await fetch(`http://localhost:${port}/`)
        await res.arrayBuffer()
        return res.status
      } catch {
        // not up yet
      }
    }
    return 0
  } finally {
    try {
      if (process.platform === 'win32') run('taskkill', ['/pid', String(child.pid), '/t', '/f'])
      else process.kill(-child.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

const failures = []
let port = 4810
for (const template of selected) {
  const dir = join(work, template)
  const steps = []
  const step = (name, r) => {
    const ok = r.status === 0
    steps.push(`${name} ${ok ? 'ok' : 'FAILED'}`)
    if (!ok) failures.push(`${template}: ${name}\n${tail(r)}`)
    return ok
  }

  const scaffolded = step(
    'scaffold',
    run(process.execPath, [scaffolder, dir, '--template', template, '--no-install', '--no-git'], {
      env: { ...process.env, STATOR_TEMPLATES_DIR: join(repo, 'examples') },
    }),
  )
  if (scaffolded) {
    const pkgPath = join(dir, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.dependencies['@statorjs/stator'] = `file:${join(work, tarball)}`
    pkg.packageManager = pnpmVersion
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

    const ok =
      step('install', run('pnpm', ['install', '--ignore-workspace'], { cwd: dir })) &&
      step('check', run('pnpm', ['check'], { cwd: dir })) &&
      step('test', run('pnpm', ['test'], { cwd: dir })) &&
      step('build', run('pnpm', ['build'], { cwd: dir }))
    if (ok) {
      const status = await serves(dir, port++)
      steps.push(`start ${status === 200 ? 'ok' : `FAILED (GET / gave ${status || 'nothing'})`}`)
      if (status !== 200) failures.push(`${template}: start: GET / gave ${status || 'no response'}`)
    }
  }
  console.log(`${template.padEnd(14)} ${steps.join(' · ')}`)
}

rmSync(work, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\n${failures.join('\n\n')}`)
  process.exit(1)
}
console.log(`\n${selected.length} starter${selected.length === 1 ? '' : 's'} ok`)
