/**
 * Real-browser acceptance test for the comment-marker region migration.
 *
 * happy-dom cannot verify this: it does not implement the HTML parser's table
 * insertion modes, so a foster-parenting bug passes there. This drives the ACTUAL
 * production `applyPatches` (bundled from src/wire/apply.ts) against a real
 * `<table>` in system Chrome and checks — via `--dump-dom` on the post-script DOM
 * — that keyed insert/remove/move/replace keep the rows correct AND inside the
 * `<tbody>` (a `<span>` wrapper would have been foster-parented out).
 *
 * Zero install: uses the system Chrome binary + `--dump-dom` (no driver, no
 * browser download). Run: `node browser-tests/tables.mjs`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const here = fileURLToPath(new URL('.', import.meta.url))

// 1. Bundle the real client applier for the browser.
const bundled = await build({
  entryPoints: [join(here, '../src/wire/apply.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'StatorApply',
  platform: 'browser',
  write: false,
})
const applyJs = bundled.outputFiles[0].text

const row = (id) => `<tr data-id="${id}"><td>${id}</td></tr>`
const slot = { kind: 'slot', id: 'list' }

// 2. A page: a real table whose rows are delimited by comment markers (the server
//    output shape), plus a script that runs a filter/reorder patch sequence and
//    self-checks the resulting DOM.
const page = `<!doctype html><html><body>
<table><tbody><!--s:list-->${['a', 'b', 'c', 'd', 'e'].map(row).join('')}<!--/s:list--></tbody></table>
<script>${applyJs}</script>
<script>
  const slot = ${JSON.stringify(slot)}
  // Filter [a,b,c,d,e] -> [a,c,e] (remove right-to-left, as the server emits).
  StatorApply.applyPatches([
    { target: slot, op: 'remove', index: 3 },
    { target: slot, op: 'remove', index: 1 },
  ])
  // Insert a new row at index 1 -> [a, NEW, c, e].
  StatorApply.applyPatches([
    { target: slot, op: 'insert', index: 1, value: ${JSON.stringify(row('NEW'))} },
  ])
  // Move index 0 (a) to the end -> [NEW, c, e, a].
  StatorApply.applyPatches([{ target: slot, op: 'move', from: 0, to: 3 }])

  const tbody = document.querySelector('tbody')
  const rows = Array.from(tbody.querySelectorAll('tr'))
  const order = rows.map((r) => r.getAttribute('data-id')).join(',')
  const allInTbody = rows.every((r) => r.parentElement === tbody)
  const markers = Array.from(tbody.childNodes).filter((n) => n.nodeType === 8).map((n) => n.data)
  const markersOk = markers.includes('s:list') && markers.includes('/s:list')
  const ok = order === 'NEW,c,e,a' && allInTbody && markersOk
  document.documentElement.setAttribute(
    'data-result',
    ok ? 'PASS' : 'FAIL order=' + order + ' inTbody=' + allInTbody + ' markers=' + markersOk,
  )
</script>
</body></html>`

const dir = mkdtempSync(join(tmpdir(), 'stator-browser-'))
const file = join(dir, 'tables.html')
writeFileSync(file, page)

// 3. Parse in real Chrome; --dump-dom serializes the post-script DOM.
const dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--dump-dom', `file://${file}`], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
})

const match = dom.match(/data-result="([^"]*)"/)
const result = match ? match[1] : '(no data-result — script did not run)'
const tbody = dom.match(/<tbody>.*?<\/tbody>/s)?.[0] ?? '(no tbody)'

if (result === 'PASS') {
  console.log('✓ tables real-browser acceptance: PASS')
  console.log('  final tbody:', tbody)
  process.exit(0)
} else {
  console.error('✗ tables real-browser acceptance: ' + result)
  console.error('  final tbody:', tbody)
  process.exit(1)
}
