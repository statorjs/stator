// Cross-platform smoke test for the native (Vite-free) dev server — the proof
// that the owned watch→compile→reload loop works on macOS, Linux, AND Windows,
// which is the whole reason for a CI matrix (raw `fs.watch` behaves differently
// on each; this exercises chokidar + the esbuild loader + live reload for real).
//
// Boots `stator dev` (STATOR_NATIVE_DEV=1) against examples/minimal, then:
//   1. asserts the page renders,
//   2. edits a route (fast path) and asserts the change live-reloads,
//   3. edits a machine (store path) and asserts it live-reloads,
//   4. restores the files and shuts the server down.
//
// Exits non-zero on any failure so CI fails loudly. No test framework — it must
// run identically everywhere with only Node.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(repoRoot, 'examples', 'minimal')
const bin = join(repoRoot, 'packages', 'stator', 'src', 'cli', 'stator.js')
const routeFile = join(appDir, 'routes', 'index.stator')
const machineFile = join(appDir, 'machines', 'counter.ts')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const originals = new Map([
  [routeFile, readFileSync(routeFile, 'utf8')],
  [machineFile, readFileSync(machineFile, 'utf8')],
])
const restore = () => {
  for (const [f, c] of originals) writeFileSync(f, c)
}

let child
const fail = (msg) => {
  console.error(`\n✗ native-dev-smoke: ${msg}`)
  restore()
  child?.kill()
  process.exit(1)
}

// Poll a URL until `predicate(body)` holds or the deadline passes.
async function waitFor(url, predicate, { timeoutMs, label }) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      last = await res.text()
      if (res.status === 200 && predicate(last)) return last
    } catch {
      // server not up yet / mid-reload — keep polling
    }
    await sleep(100)
  }
  fail(`timed out waiting for ${label} at ${url} (last body ${last.length} bytes)`)
}

async function main() {
  const port = 51000 + Math.floor(Date.now() % 4000)
  child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
    cwd: appDir,
    env: { ...process.env, STATOR_NATIVE_DEV: '1', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // The banner prints the actual bound port (findFreePort may shift it).
  let boundPort = port
  child.stdout.on('data', (b) => {
    const m = /localhost:(\d+)/.exec(String(b))
    if (m) boundPort = Number(m[1])
  })
  child.stderr.on('data', (b) => process.stderr.write(b))
  child.on('exit', (code) => {
    if (code && code !== 0 && code !== null) fail(`dev server exited early (code ${code})`)
  })

  // Give the banner a moment so boundPort is accurate, then wait for boot.
  await sleep(500)
  const url = () => `http://localhost:${boundPort}/`

  await waitFor(url(), (b) => b.includes('Hello, Stator'), {
    timeoutMs: 40000,
    label: 'initial render',
  })
  console.log('✓ boots and renders')

  // 1. Route edit → fast path.
  writeFileSync(routeFile, originals.get(routeFile).replace('Hello, Stator', 'Hello, CI-Route'))
  await waitFor(url(), (b) => b.includes('Hello, CI-Route'), {
    timeoutMs: 15000,
    label: 'route edit reload',
  })
  console.log('✓ route edit live-reloads')

  // 2. Machine edit → store path.
  writeFileSync(machineFile, originals.get(machineFile).replace('count is ', 'tally is '))
  await waitFor(url(), (b) => b.includes('tally is 0'), {
    timeoutMs: 15000,
    label: 'machine edit reload',
  })
  console.log('✓ machine edit live-reloads')

  restore()
  child.kill()
  console.log('\n✓ native-dev-smoke passed')
  process.exit(0)
}

main().catch((e) => fail(e?.stack ?? String(e)))
