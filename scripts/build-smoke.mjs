// Cross-platform smoke test for `stator build` — the proof that the production
// build works on macOS, Linux AND Windows, which the dev-loop smoke does not
// cover. The build's copy set comes from resolving the app's module graph, and
// resolution is where platforms diverge: Windows paths are case-insensitive and
// a drive letter's case need not match ours, `\` and `/` both separate, and
// esbuild reports real paths (macOS turns /var into /private/var). Get any of
// that wrong and the copy set silently classifies every app file as external —
// the build "succeeds" and ships a dist/ with nothing but static/ in it.
//
// Runs the real CLI against each app below and asserts:
//   1. the build exits 0,
//   2. dist/ contains the directories the app's code reaches,
//   3. static/ is present — it holds files nothing imports, so it can never be
//      discovered by a module graph and is never subject to one,
//   4. every `.stator` compiled to a sibling `.ts` (none left uncompiled),
//   5. the manifest is written and parses,
//   6. a directory nothing reaches is NOT copied,
//   7. the built app boots and serves a page from dist/.
//
// Exits non-zero on any failure. No test framework — it must run identically
// everywhere with only Node.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(repoRoot, 'packages', 'stator', 'src', 'cli', 'stator.js')

const APPS = [
  {
    // Server templates only — isolates the copy set from island bundling.
    dir: 'examples/minimal',
    expectDirs: ['machines', 'routes', 'static', 'templates'],
    page: '/',
    marker: 'Hello, Stator',
  },
  {
    // Islands, a lib/, a stator.config.ts, and scoped CSS: the full path.
    dir: 'examples/desksmith',
    expectDirs: ['lib', 'machines', 'routes', 'static', 'templates'],
    expectFiles: ['stator.config.ts'],
    page: '/',
    marker: '<html',
  },
]

let failures = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failures++
}
const pass = (msg) => console.log(`  ✓ ${msg}`)

const run = (args, cwd) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    let out = ''
    child.stdout.on('data', (b) => {
      out += b
    })
    child.stderr.on('data', (b) => {
      out += b
    })
    child.on('exit', (code) => done({ code, out }))
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const app of APPS) {
  const root = join(repoRoot, app.dir)
  console.log(`\n${app.dir}`)

  // A directory nothing imports, to prove it stays out of dist.
  const decoy = join(root, '__smoke_unreferenced')
  await mkdir(decoy, { recursive: true })
  await writeFile(join(decoy, 'notes.md'), '# nothing imports this\n')

  try {
    const built = await run(['build'], root)
    if (built.code !== 0) {
      fail(`build exited ${built.code}\n${built.out}`)
      continue
    }
    pass('build exited 0')
    if (!/copied:/.test(built.out)) fail('build did not report its copy set')
    else pass('build reported its copy set')

    const dist = join(root, 'dist')
    const top = readdirSync(dist)

    for (const dir of app.expectDirs) {
      if (top.includes(dir) && statSync(join(dist, dir)).isDirectory()) pass(`dist/${dir}`)
      else fail(`dist/${dir} missing — copy set resolved nothing (path handling?)`)
    }
    for (const file of app.expectFiles ?? []) {
      if (existsSync(join(dist, file))) pass(`dist/${file}`)
      else fail(`dist/${file} missing`)
    }
    if (top.includes('__smoke_unreferenced')) fail('copied a directory nothing reaches')
    else pass('unreferenced directory not copied')

    // Every .stator must have become a sibling .ts.
    const leftover = []
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const f = join(dir, e.name)
        if (e.isDirectory()) walk(f)
        else if (e.name.endsWith('.stator')) leftover.push(f)
      }
    }
    walk(dist)
    if (leftover.length > 0) fail(`uncompiled .stator files: ${leftover.join(', ')}`)
    else pass('every .stator compiled')

    const manifest = JSON.parse(readFileSync(join(dist, 'stator-manifest.json'), 'utf8'))
    if (typeof manifest.buildId === 'string' && manifest.buildId.length > 0)
      pass('manifest written')
    else fail('manifest missing a buildId')

    // Boot what was built and fetch a page — the end-to-end check that the
    // copied tree is actually complete.
    const port = 53400 + Math.floor(Math.random() * 200)
    const server = spawn(process.execPath, [bin, 'start', '--port', String(port)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', LOG_LEVEL: 'warn' },
    })
    let serverOut = ''
    server.stdout.on('data', (b) => {
      serverOut += b
    })
    server.stderr.on('data', (b) => {
      serverOut += b
    })
    try {
      let body = ''
      for (let i = 0; i < 40; i++) {
        await sleep(250)
        try {
          const res = await fetch(`http://localhost:${port}${app.page}`)
          if (res.ok) {
            body = await res.text()
            break
          }
        } catch {
          // not listening yet
        }
      }
      if (body.includes(app.marker)) pass(`dist/ serves ${app.page}`)
      else fail(`dist/ did not serve ${app.page}\n${serverOut}`)
    } finally {
      server.kill('SIGTERM')
      await sleep(500)
      server.kill('SIGKILL')
    }
  } finally {
    await rm(decoy, { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.error(`\nbuild smoke: ${failures} failure${failures === 1 ? '' : 's'}`)
  process.exit(1)
}
console.log('\nbuild smoke: ok')
