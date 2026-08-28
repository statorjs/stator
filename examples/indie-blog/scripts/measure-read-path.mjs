/**
 * A5 — anonymous read-path baseline (Stage A spec, `indie-blog-stage-a-*`).
 *
 * Measures the production serve path (`stator build` + `stator start`) the way
 * a CDN would see it: cookie-less GETs of the public index. Reports TTFB
 * cold/warm, whether every anonymous response mints a session (Set-Cookie),
 * and process RSS growth under cookie-less load — the "CDN strips cookies"
 * failure mode, where every request creates a session that lives until TTL.
 *
 *   pnpm build && node scripts/measure-read-path.mjs [--requests 500]
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4319
const N = Number(process.argv[process.argv.indexOf('--requests') + 1]) || 500
const base = `http://127.0.0.1:${PORT}`

const server = spawn(join(root, 'node_modules/.bin/stator'), ['start'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    INDIE_BLOG_DB: join(mkdtempSync(join(tmpdir(), 'indie-blog-measure-')), 'measure.db'),
    LOG_LEVEL: 'error',
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
const kill = () => server.kill('SIGTERM')
process.on('exit', kill)

// Wait for listen.
let coldMs = null
for (let i = 0; i < 100; i++) {
  try {
    const t = performance.now()
    const res = await fetch(`${base}/`)
    coldMs = performance.now() - t
    if (!res.ok) throw new Error(`status ${res.status}`)
    console.log(`cold GET /            ${coldMs.toFixed(1)}ms  set-cookie: ${res.headers.has('set-cookie')}`)
    break
  } catch {
    await new Promise((r) => setTimeout(r, 100))
  }
}
if (coldMs === null) {
  console.error('server never came up — did you run `pnpm build` first?')
  process.exit(1)
}

const timed = async (headers = {}) => {
  const t = performance.now()
  const res = await fetch(`${base}/`, { headers })
  await res.arrayBuffer()
  return { ms: performance.now() - t, res }
}
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return `median ${s[Math.floor(s.length / 2)].toFixed(1)}ms  p95 ${s[Math.floor(s.length * 0.95)].toFixed(1)}ms`
}

// Warm, cookie-less (every request mints a session).
const anon = []
for (let i = 0; i < 30; i++) anon.push((await timed()).ms)
console.log(`warm GET / anonymous  ${stats(anon)}`)

// Warm, with a reused session cookie.
const cookie = (await timed()).res.headers.get('set-cookie').split(';')[0]
const sessioned = []
for (let i = 0; i < 30; i++) sessioned.push((await timed({ cookie })).ms)
console.log(`warm GET / sessioned  ${stats(sessioned)}`)

// Churn: N cookie-less requests → count minted sessions, measure RSS delta.
const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)]).toString().trim())
const rssBefore = rss()
let minted = 0
for (let i = 0; i < N; i++) {
  const res = await fetch(`${base}/`)
  await res.arrayBuffer()
  if (res.headers.has('set-cookie')) minted++
}
const rssAfter = rss()
console.log(`churn: ${N} cookie-less GETs → ${minted} Set-Cookie responses (${((minted / N) * 100).toFixed(0)}% mint a session)`)
console.log(`rss: ${(rssBefore / 1024).toFixed(1)}MB → ${(rssAfter / 1024).toFixed(1)}MB  (+${((rssAfter - rssBefore) / N).toFixed(1)}KB per anonymous request)`)

kill()
