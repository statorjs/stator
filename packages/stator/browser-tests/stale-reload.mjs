/**
 * A live page whose HTML comes from a cache holding build A while the origin
 * runs build B. Real Chromium, real client bundle, real origin; a tiny proxy
 * stands in for the CDN. Checks that the tab reloads a bounded number of times
 * when the cache ignores the reload's revalidation headers, and exactly once
 * when it honours them.
 *
 * Not part of `pnpm test`. Needs a Chromium binary (`CHROME`, default
 * /usr/bin/chromium).
 * Run: node --import @statorjs/stator/register browser-tests/stale-reload.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../tests/fixtures')
const CHROME = process.env.CHROME ?? '/usr/bin/chromium'
const PAGE = '/live-head'
const RUN_MS = 8000

const boot = (buildId) =>
  createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    buildId,
  })

const staleRes = await (await boot('build-A')).fetch(new Request(`http://localhost${PAGE}`))
const staleHtml = await staleRes.text()
const staleCacheControl = staleRes.headers.get('cache-control')

const origin = await boot('build-B')
const { port: originPort } = await origin.listen(0)

/** `honourRevalidation`: a request carrying max-age=0 / no-cache goes to origin. */
async function run(honourRevalidation) {
  const pageGets = []
  let sseConnects = 0
  const t0 = Date.now()
  const proxy = http.createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path === '/__sse') sseConnects++
    if (path === PAGE) {
      const cc = req.headers['cache-control'] ?? null
      const wantsFresh = /max-age=0|no-cache/.test(cc ?? '') || req.headers.pragma === 'no-cache'
      const served = honourRevalidation && wantsFresh ? 'origin' : 'cache'
      pageGets.push({
        t: Date.now() - t0,
        served,
        'cache-control': cc,
        pragma: req.headers.pragma ?? null,
        cookie: req.headers.cookie ? 'present' : null,
      })
      if (served === 'cache') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=UTF-8',
          'cache-control': staleCacheControl,
          age: '30',
        })
        res.end(staleHtml)
        return
      }
    }
    const up = http.request(
      {
        host: '127.0.0.1',
        port: originPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers)
        upRes.pipe(res)
      },
    )
    up.on('error', () => res.destroy())
    res.on('close', () => up.destroy())
    req.pipe(up)
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  const port = proxy.address().port

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'stator-repro-'))}`,
      `http://127.0.0.1:${port}${PAGE}`,
    ],
    { stdio: 'ignore' },
  )
  await new Promise((r) => setTimeout(r, RUN_MS))
  chrome.kill('SIGKILL')
  proxy.closeAllConnections()
  await new Promise((r) => proxy.close(r))

  const gaps = pageGets.slice(1).map((g, i) => g.t - pageGets[i].t)
  return {
    honourRevalidation,
    runMs: RUN_MS,
    pageGets: pageGets.length,
    sseConnects,
    medianGapMs: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? null,
    firstGet: pageGets[0],
    reloadGet: pageGets[1] ?? null,
    servedFrom: pageGets.map((g) => g.served).slice(0, 6),
  }
}

const ignored = await run(false)
const honoured = await run(true)
await origin.close()

// Ignored: the first load, the immediate reload, and one more after the 5 s wait.
const failures = []
if (ignored.pageGets < 2 || ignored.pageGets > 3) {
  failures.push(
    `cache ignores revalidation: expected 2 or 3 page loads in ${RUN_MS} ms, got ${ignored.pageGets}`,
  )
}
if (ignored.sseConnects > ignored.pageGets) {
  failures.push(
    `cache ignores revalidation: ${ignored.sseConnects} /__sse connects for ${ignored.pageGets} page loads`,
  )
}
if (honoured.pageGets !== 2) {
  failures.push(`cache honours revalidation: expected 2 page loads, got ${honoured.pageGets}`)
}
console.log(JSON.stringify({ staleCacheControl, ignored, honoured }, null, 2))
for (const failure of failures) console.error(`FAIL ${failure}`)
if (failures.length === 0) console.log('PASS')
process.exit(failures.length === 0 ? 0 : 1)
