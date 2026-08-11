/**
 * Real-browser acceptance test for the variant-picker island, in the style of
 * the framework's browser-tests: system Chrome + `--dump-dom`, zero install.
 *
 * The island's contract is browser behavior happy-dom can't prove: radio
 * `:checked` carrying the selection, `change` bubbling into the client
 * machine, client-lowered `read()` slots, the live `disabled` bind, and the
 * declared-attr channel (`stock` patches → `stockChanged` → typed event).
 * This drives the REAL compiled client module against the REAL server-rendered
 * shell and checks the post-script DOM.
 *
 * Run: `pnpm test:browser` (requires Chrome at the standard macOS path).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from '@statorjs/stator/compiler'
import { createDevApp } from '@statorjs/stator/dev'
import { build } from 'esbuild'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// 1. The server-rendered shell, exactly as the PDP route produces it —
//    picker markup plus the badge strip the island reveals badges in.
const app = await createDevApp({
  root,
  machinesDir: join(root, 'machines'),
  routesDir: join(root, 'routes'),
  staticDir: join(root, 'static'),
})
const pdp = await (await app.fetch(new Request('http://test/p/the-longshore'))).text()
await app.close()
const shell = pdp.match(/<variant-picker[\s\S]*?<\/variant-picker>/)?.[0]
const badges = pdp.match(/<div class="stock-badges"[\s\S]*?<\/div>/)?.[0]
if (!shell || !badges) {
  console.error('FAIL: PDP render missing picker shell or badge strip')
  process.exit(1)
}

// 2. The real compiled client module, bundled for the browser with server
//    machine imports stubbed to `{ name }` (what the vite plugin does).
const src = await readFile(join(root, 'templates/variant-picker.stator'), 'utf8')
const { clientCode } = compile(src, { filename: 'templates/variant-picker.stator' })
const entry = join(root, 'templates/.picker-browser-entry.ts')
writeFileSync(entry, clientCode)
let pickerJs
try {
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    plugins: [
      {
        name: 'machine-stub',
        setup(b) {
          b.onResolve({ filter: /machines\/[^/]+\.ts$/ }, (args) => {
            const abs = resolve(args.resolveDir, args.path)
            if (!abs.startsWith(join(root, 'machines'))) return null
            return { path: abs, namespace: 'machine-stub' }
          })
          b.onLoad({ filter: /.*/, namespace: 'machine-stub' }, async (args) => {
            // The stub needs only the machine's name — read it off the
            // definition text (importing the module would drag the server
            // graph into Node).
            const name = (await readFile(args.path, 'utf8')).match(/name:\s*'([^']+)'/)?.[1]
            if (!name) throw new Error(`no machine name found in ${args.path}`)
            return { contents: `export default { name: ${JSON.stringify(name)} }` }
          })
        },
      },
    ],
  })
  pickerJs = bundled.outputFiles[0].text
} finally {
  rmSync(entry, { force: true })
}

// 3. A page: shell + badge strip + the island bundle + a self-checking script.
const page = `<!doctype html><html><body>
${badges}
${shell}
<script>${pickerJs}</script>
<script>
  const fail = (why) => document.documentElement.setAttribute('data-result', why)
  // A client text slot is an <!--sN--> comment with a text node materialized
  // after it by bindSlot — read that text, scoped to the island (the badge
  // strip has its own, unrelated wire slots).
  const slotText = (n) => {
    const stack = [document.querySelector('variant-picker')]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node.nodeType === 8 && node.data === 's' + n) {
        return node.nextSibling && node.nextSibling.nodeType === 3 ? node.nextSibling.data : ''
      }
      for (let c = node.firstChild; c; c = c.nextSibling) stack.push(c)
    }
    return null
  }
  const shown = () => {
    const b = document.querySelector('.stock-badge.is-shown')
    return b ? b.getAttribute('data-sku') : null
  }
  try {
    // Hydration: seeded from attrs, slots materialized, initial badge shown.
    if (slotText(0) !== 'Gull') throw new Error('seed colorLabel: ' + slotText(0))
    if (slotText(1) !== 'EU 36') throw new Error('seed sizeLabel: ' + slotText(1))
    if (shown() !== 'the-longshore--gull--36') throw new Error('initial badge: ' + shown())

    // Pick a color by clicking its radio — change bubbles into the machine.
    document.querySelector('input[name="vp-color"][value="squid-ink"]').click()
    if (slotText(0) !== 'Squid Ink') throw new Error('picked colorLabel: ' + slotText(0))
    if (shown() !== 'the-longshore--squid-ink--36') throw new Error('picked badge: ' + shown())
    const plate = document.querySelector('.plate')
    if (!plate.getAttribute('style').includes('#2c3038')) throw new Error('plate not recolored')

    // Pick a size.
    document.querySelector('input[name="vp-size"][value="43"]').click()
    if (slotText(1) !== 'EU 43') throw new Error('picked sizeLabel: ' + slotText(1))

    // Live stock arriving through the declared-attr channel: zero out the
    // selected sku, as a server patch would.
    const picker = document.querySelector('variant-picker')
    picker.setAttribute('stock', JSON.stringify({ 'the-longshore--squid-ink--43': 0 }))
    const btn = document.querySelector('.vp-add')
    if (!btn.disabled) throw new Error('add button not disabled at zero stock')
    if (slotText(2) !== 'Out of stock') throw new Error('status: ' + slotText(2))

    // Restock: the verdict follows the attr back.
    picker.setAttribute('stock', JSON.stringify({ 'the-longshore--squid-ink--43': 3 }))
    if (btn.disabled) throw new Error('add button still disabled after restock')
    if (slotText(2) !== '') throw new Error('status after restock: ' + slotText(2))

    document.documentElement.setAttribute('data-result', 'PASS')
  } catch (err) {
    fail(String(err))
  }
</script>
</body></html>`

// 4. Chrome renders it; the post-script DOM carries the verdict.
const dir = mkdtempSync(join(tmpdir(), 'store-picker-'))
const file = join(dir, 'picker.html')
writeFileSync(file, page)
const dom = execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--virtual-time-budget=2000',
    '--dump-dom',
    pathToFileURL(file).href,
  ],
  { encoding: 'utf8' },
)
rmSync(dir, { recursive: true, force: true })

const verdict = dom.match(/data-result="([^"]*)"/)?.[1]
if (verdict === 'PASS') {
  console.log('PASS: variant-picker island behaves in a real browser')
} else {
  console.error(`FAIL: ${verdict ?? 'no verdict written — island script likely crashed'}`)
  process.exit(1)
}
