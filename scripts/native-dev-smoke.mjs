// Cross-platform smoke test for the native (Vite-free) dev server — the proof
// that the owned watch→compile→reload loop works on macOS, Linux, AND Windows,
// which is the whole reason for a CI matrix (raw `fs.watch` behaves differently
// on each; this exercises chokidar + the loader hooks + live reload for real).
//
// Runs `stator dev` (STATOR_NATIVE_DEV=1) against each app below and asserts:
//   1. the page renders, and an event round-trips to a patch,
//   2. a template/route edit live-reloads,
//   3. a machine edit live-reloads (store path),
//   4. a compile error keeps the last good build serving, then recovers,
//   5. (island apps) the island script is bundled and served.
//
// Exits non-zero on any failure so CI fails loudly. No test framework — it must
// run identically everywhere with only Node.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(repoRoot, 'packages', 'stator', 'src', 'cli', 'stator.js')

const APPS = [
  {
    // Server templates only: isolates the server loop.
    dir: 'examples/minimal',
    marker: 'Hello, Stator',
    template: 'routes/index.stator',
    templateEdit: ['Hello, Stator', 'Hello, CI-Route'],
    templateMarker: 'Hello, CI-Route',
    machine: 'machines/counter.ts',
    machineEdit: ['count is ', 'tally is '],
    machineMarker: 'tally is 0',
    event: { machine: 'CounterMachine', event: { type: 'INCREMENT' } },
    patch: 'count is 1',
  },
  {
    // The dev-server test fixture: a route importing a template importing an
    // island — covers the island bundle + per-route script injection.
    dir: 'packages/stator/tests/fixtures/dev-app',
    marker: 'count is 0',
    template: 'templates/page.stator',
    templateEdit: ['<title>dev-app</title>', '<title>CI-Route</title>'],
    // Scoped styles add a scope attribute to <title>, so match the text only.
    templateMarker: 'CI-Route',
    machine: 'machines/counter.ts',
    machineEdit: ['count is ', 'tally is '],
    machineMarker: 'tally is 0',
    event: { machine: 'CounterMachine', event: { type: 'INCREMENT' } },
    patch: 'count is 1',
    island: /src="(\/static\/assets\/templates_tick-counter-[\w-]+\.js)"/,
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let child
let restore = () => {}
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

async function runApp(spec) {
  const appDir = join(repoRoot, ...spec.dir.split('/'))
  const templateFile = join(appDir, ...spec.template.split('/'))
  const machineFile = join(appDir, ...spec.machine.split('/'))
  const originals = new Map([
    [templateFile, readFileSync(templateFile, 'utf8')],
    [machineFile, readFileSync(machineFile, 'utf8')],
  ])
  restore = () => {
    for (const [f, c] of originals) writeFileSync(f, c)
  }
  console.log(`\n▸ ${spec.dir}`)

  const port = 51000 + Math.floor(Date.now() % 4000)
  child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
    cwd: appDir,
    env: { ...process.env, STATOR_NATIVE_DEV: '1', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // The banner prints the actual bound port (findFreePort may shift it).
  let boundPort = 0
  child.stdout.on('data', (b) => {
    const m = /localhost:(\d+)/.exec(String(b))
    if (m) boundPort = Number(m[1])
  })
  child.stderr.on('data', (b) => process.stderr.write(b))
  child.on('exit', (code) => {
    if (code && code !== 0 && code !== null) fail(`dev server exited early (code ${code})`)
  })
  const deadline = Date.now() + 40000
  while (!boundPort && Date.now() < deadline) await sleep(50)
  if (!boundPort) fail('dev server printed no banner')
  const url = () => `http://localhost:${boundPort}/`

  await waitFor(url(), (b) => b.includes(spec.marker), {
    timeoutMs: 40000,
    label: 'initial render',
  })
  console.log('✓ boots and renders')

  // 1. Runtime parity: an event round-trips to a patch (shared buildHonoApp path).
  const home = await fetch(url())
  const cookie = home.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) fail('no session cookie on GET /')
  const evt = await fetch(`${url()}__events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', Cookie: cookie },
    body: JSON.stringify(spec.event),
  })
  const patched = await evt.json()
  if (!patched.patches?.some((p) => p.value === spec.patch))
    fail(`event round-trip produced no patch: ${JSON.stringify(patched)}`)
  console.log('✓ event round-trips to a patch')

  // 2. Island bundle (when the app has one): script injected, asset served.
  if (spec.island) {
    const html = await home.text()
    const m = spec.island.exec(html)
    if (!m) fail('island script not injected into <head>')
    const asset = await fetch(`http://localhost:${boundPort}${m[1]}`)
    if (asset.status !== 200 || !/javascript/.test(asset.headers.get('content-type') ?? ''))
      fail(`island asset ${m[1]} not served (status ${asset.status})`)
    console.log('✓ island bundled and served')
  }

  // 3. Template edit → incremental path.
  writeFileSync(templateFile, originals.get(templateFile).replace(...spec.templateEdit))
  await waitFor(url(), (b) => b.includes(spec.templateMarker), {
    timeoutMs: 15000,
    label: 'template edit reload',
  })
  console.log('✓ template edit live-reloads')

  // 4. Machine edit → store path.
  writeFileSync(machineFile, originals.get(machineFile).replace(...spec.machineEdit))
  await waitFor(url(), (b) => b.includes(spec.machineMarker), {
    timeoutMs: 15000,
    label: 'machine edit reload',
  })
  console.log('✓ machine edit live-reloads')

  // 5. Compile error resilience: a broken edit must NOT crash the server — it
  //    keeps serving the last good build, then recovers when the file is fixed.
  writeFileSync(templateFile, '---\nthis is not valid typescript ][\n---\n<h1>broken</h1>\n')
  await sleep(1500)
  const duringError = await fetch(url())
  if (duringError.status !== 200)
    fail(`server stopped serving during a compile error (status ${duringError.status})`)
  console.log('✓ compile error keeps last-good build alive')
  restore()
  await waitFor(url(), (b) => b.includes(spec.marker) && !b.includes(spec.machineMarker), {
    timeoutMs: 15000,
    label: 'recovery after fixing the compile error',
  })
  console.log('✓ recovers after the error is fixed')

  child.kill()
  await new Promise((r) => child.once('exit', r))
  child = undefined
}

async function main() {
  for (const spec of APPS) await runApp(spec)
  console.log('\n✓ native-dev-smoke passed')
  process.exit(0)
}

main().catch((e) => fail(e?.stack ?? String(e)))
