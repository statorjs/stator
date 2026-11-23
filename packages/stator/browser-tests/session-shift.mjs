/**
 * A tab whose session changes under it, in real Chromium: sign-in and sign-out
 * in another tab, claims set without rotation, Back after sign-in (bfcache and
 * HTTP cache), and a non-live page that mismatches more than once. Checks that
 * a page whose layout no longer matches reloads once and ends correct, that no
 * value lands on the wrong element before it does, and that a
 * `when(read(machine, …))` page converges by patch with no reload.
 *
 * Not part of `pnpm test`. Needs playwright-core, which is not a repo
 * dependency (`PLAYWRIGHT_CORE`: its directory), and a Chromium binary
 * (`CHROME`, default /usr/bin/chromium).
 * Run: node --import @statorjs/stator/register browser-tests/session-shift.mjs
 * `ONLY=A,D` runs the scenarios whose names start with those prefixes.
 * `STRIP_LAYOUT=1` drops the fingerprint on its way to the server, which is the
 * behaviour before the check existed: the run must then fail.
 */
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server/create-app.ts'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const CHROME = process.env.CHROME ?? '/usr/bin/chromium'
const ONLY = process.env.ONLY?.split(',')
/** Negative control: the server never sees a fingerprint, so the run must fail. */
const STRIP_LAYOUT = process.env.STRIP_LAYOUT === '1'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../tests/fixtures/layout-fingerprint')

/** Longer than the guard's first wait (5 s), so a second reload would show. */
const SETTLE_MS = 6500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, fn, timeoutMs = 15_000) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

/** The origin behind a pass-through proxy that counts what the server is asked for. */
async function boot() {
  const app = await createApp({
    events: { gate: 'off' },
    machinesDir: resolve(root, 'machines'),
    routesDir: resolve(root, 'routes'),
    buildId: 'B1',
    logging: { level: 'silent' },
  })
  const { port: originPort } = await app.listen(0)
  /** `events`: each /__events answer, with the layout the page sent. */
  const counts = { gets: {}, sse: 0, sseLayouts: [], events: [] }
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const received = Date.now()
    if (url.pathname === '/__sse') {
      counts.sse++
      counts.sseLayouts.push(url.searchParams.get('layout'))
    } else if (req.method === 'GET') {
      counts.gets[url.pathname] = (counts.gets[url.pathname] ?? 0) + 1
    }
    const headers = { ...req.headers }
    if (STRIP_LAYOUT) {
      delete headers['x-stator-layout']
      url.searchParams.delete('layout')
    }
    const up = http.request(
      {
        host: '127.0.0.1',
        port: originPort,
        path: STRIP_LAYOUT ? url.pathname + url.search : req.url,
        method: req.method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers)
        upRes.pipe(res)
        if (url.pathname !== '/__events') return
        const chunks = []
        upRes.on('data', (chunk) => chunks.push(chunk))
        upRes.on('end', () =>
          counts.events.push({
            at: received,
            ms: Date.now() - received,
            pageLayout: req.headers['x-stator-layout'] ?? null,
            status: upRes.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString() || 'null'),
          }),
        )
      },
    )
    up.on('error', () => res.destroy())
    res.on('close', () => up.destroy())
    req.pipe(up)
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  return {
    origin: `http://localhost:${proxy.address().port}`,
    counts,
    close: async () => {
      proxy.closeAllConnections()
      await new Promise((r) => proxy.close(r))
      await app.close()
    },
  }
}

/** Runs in every document: reports loads, shows, wire traffic and every DOM
 *  mutation, each with what the visitor sees at that instant. */
function instrument() {
  const doc = Math.random().toString(36).slice(2, 8)
  const text = (id) => document.getElementById(id)?.textContent ?? null
  const attr = (id, name) => document.getElementById(id)?.getAttribute(name) ?? null
  window.__snap = () => ({
    doc,
    anon: text('anon'),
    member: text('member'),
    memberTitle: attr('member', 'title'),
    total: text('total'),
    totalTitle: attr('total', 'title'),
    connection: document.documentElement?.getAttribute('data-stator-connection') ?? null,
    layout: document.querySelector('meta[name="stator-layout"]')?.getAttribute('content') ?? null,
  })
  const rec = (kind, extra) =>
    window.__rec({
      doc,
      kind,
      t: Date.now(),
      path: location.pathname,
      ...extra,
      snap: window.__snap(),
    })
  rec('document', { navType: performance.getEntriesByType('navigation')[0]?.type })
  window.addEventListener('pageshow', (e) => {
    const nav = performance.getEntriesByType('navigation')[0]
    rec('pageshow', {
      persisted: e.persisted,
      transferSize: nav?.transferSize,
      notRestoredReasons: JSON.stringify(nav?.notRestoredReasons ?? null),
    })
  })
  window.addEventListener('click', () => rec('click'), true)
  window.addEventListener('pagehide', (e) => rec('pagehide', { persisted: e.persisted }))
  window.addEventListener('stator:live-message', (e) => {
    const env = e.detail.envelope
    rec('sse-message', { patches: env.patches?.length ?? 0, directives: env.directives ?? [] })
  })
  window.addEventListener('stator:patches-received', (e) =>
    rec('patches', { source: e.detail.source, count: e.detail.patches.length }),
  )
  window.addEventListener('stator:directive-applied', (e) =>
    rec('directive', { directive: e.detail.directive }),
  )
  window.addEventListener('stator:connection-state', (e) =>
    rec('connection', { state: e.detail.state }),
  )
  new MutationObserver(() => rec('mutation')).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  })
}

/** A value on the wrong element: the fixture's totals stay under 42 and its
 *  member counts start there, and each title names its own selector. */
function misplaced(snap) {
  const problems = []
  if (snap.total !== null) {
    const n = /^Total: (\d+)$/.exec(snap.total)?.[1]
    if (n === undefined || Number(n) >= 42) problems.push(`total reads "${snap.total}"`)
    if (snap.totalTitle !== null && snap.totalTitle !== `total:${n}`) {
      problems.push(`total title "${snap.totalTitle}" beside "${snap.total}"`)
    }
  }
  if (snap.member !== null) {
    const n = /Members online: (\d+)$/.exec(snap.member)?.[1]
    if (n === undefined || Number(n) < 42) problems.push(`member reads "${snap.member}"`)
    if (snap.memberTitle !== null && snap.memberTitle !== `members:${n}`) {
      problems.push(`member title "${snap.memberTitle}" beside "${snap.member}"`)
    }
  }
  if (snap.member !== null && snap.anon !== null) problems.push('member and anon both shown')
  return problems
}

/** What the visitor reads, apart from the connection state. */
const contentOf = ({ anon, member, memberTitle, total, totalTitle }) =>
  JSON.stringify([anon, member, memberTitle, total, totalTitle])

async function newContext(browser) {
  const context = await browser.newContext()
  const logs = new WeakMap()
  await context.exposeBinding('__rec', ({ page }, entry) => {
    const log = logs.get(page)
    if (!log) return
    if (entry.snap) {
      const problems = misplaced(entry.snap)
      if (problems.length > 0) log.violations.push({ kind: entry.kind, problems, snap: entry.snap })
    }
    if (entry.kind === 'mutation') {
      log.mutations.push({ doc: entry.doc, t: entry.t, content: contentOf(entry.snap) })
    } else log.entries.push(entry)
  })
  await context.addInitScript(instrument)
  /** A tab whose every document is recorded. */
  const watched = async () => {
    const page = await context.newPage()
    const log = { entries: [], mutations: [], violations: [], warnings: [] }
    logs.set(page, log)
    lastLog = log
    page.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') log.warnings.push(m.text())
    })
    return { page, log }
  }
  return { context, watched }
}

const snapshot = (page) => page.evaluate(() => window.__snap())
const guardRecord = (page) => page.evaluate(() => sessionStorage.getItem('stator:reload'))
const post = (page, path) =>
  page.evaluate((p) => fetch(p, { method: 'POST' }).then((r) => r.status), path)
const docsOf = (log, path) => log.entries.filter((e) => e.kind === 'document' && e.path === path)
const connected = (page) =>
  page.waitForFunction(
    () => document.documentElement.getAttribute('data-stator-connection') === 'connected',
  )

/** Another visitor bumps the board: total +1, members +100. */
async function bump(browser, origin, path) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${origin}/elsewhere`)
  const status = await page.evaluate(
    (route) =>
      fetch('/__events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Stator-Route': `GET ${route}` },
        body: JSON.stringify({ machine: 'PingMachine', event: { type: 'PING' } }),
      }).then((r) => r.status),
    path,
  )
  await context.close()
  return status
}

/** The tab sends an event of its own through the real delegated click handler. */
async function ownClick(page, log) {
  await page.evaluate(() => {
    if (document.getElementById('ping')) return
    const button = document.createElement('button')
    button.id = 'ping'
    button.textContent = 'ping'
    button.setAttribute(
      'data-event-click',
      JSON.stringify({ machine: 'PingMachine', event: { type: 'PING' } }),
    )
    document.body.append(button)
  })
  const clicksBefore = log.entries.filter((e) => e.kind === 'click').length
  await page.click('#ping')
  // The time the page saw the click: Playwright takes a while to deliver one.
  const clicks = await until('the click', () => {
    const seen = log.entries.filter((e) => e.kind === 'click')
    return seen.length > clicksBefore && seen
  })
  return clicks.at(-1).t
}

const failures = []
/** The watched tab's log, kept for the report when a scenario throws. */
let lastLog
function expect(scenario, what, ok, got) {
  if (!ok)
    failures.push(`${scenario}: ${what}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`)
}

function expectContent(scenario, when, snap, { signedIn, total, members }) {
  expect(scenario, `${when}: total reads ${total}`, snap.total === `Total: ${total}`, snap.total)
  if (signedIn) {
    expect(scenario, `${when}: no anonymous line`, snap.anon === null, snap.anon)
    expect(
      scenario,
      `${when}: member line reads ${members}`,
      snap.member?.endsWith(`Members online: ${members}`) === true,
      snap.member,
    )
  } else {
    expect(scenario, `${when}: anonymous line shown`, snap.anon === 'Sign in', snap.anon)
    expect(scenario, `${when}: no member line`, snap.member === null, snap.member)
  }
}

/** What the tab did to the old document between `mark` and leaving it. */
function oldDocActivity(log, held, markT, markIndex) {
  const doc = held.doc
  const content = contentOf(held)
  const after = log.entries.slice(markIndex).filter((e) => e.doc === doc)
  return {
    patchesApplied: after.filter((e) => e.kind === 'patches').reduce((n, e) => n + e.count, 0),
    contentChanges: log.mutations.filter(
      (m) => m.doc === doc && m.t >= markT && m.content !== content,
    ).length,
    atReloadDirective: after.find((e) => e.kind === 'directive')?.snap ?? null,
    reloadDirectives: after.filter((e) => e.kind === 'directive').map((e) => e.directive),
  }
}

/** A fresh tab on the same session must show what the watched tab shows. */
async function sameAsFreshLoad(scenario, context, origin, path, page, live = true) {
  const fresh = await context.newPage()
  await fresh.goto(`${origin}${path}`)
  if (live) await connected(fresh)
  const strip = ({ doc, ...rest }) => rest
  const [a, b] = [strip(await snapshot(page)), strip(await snapshot(fresh))]
  await fresh.close()
  expect(scenario, 'matches a fresh load', JSON.stringify(a) === JSON.stringify(b), {
    tab: a,
    fresh: b,
  })
  return b
}

/**
 * A, C, E: tab 1 holds `path`; tab 2 POSTs `change`; watch tab 1.
 * `reloads`: whether the layout differs after the change.
 */
async function otherTab(browser, name, path, { before, change, signedInAfter, reloads }) {
  const { origin, counts, close } = await boot()
  const { context, watched } = await newContext(browser)
  const { page: tab1, log } = await watched()
  const tab2 = await context.newPage()
  await tab2.goto(`${origin}/elsewhere`)
  if (before) await post(tab2, before)

  await tab1.goto(`${origin}${path}`)
  await connected(tab1)
  const held = await snapshot(tab1)
  const sseBefore = counts.sse

  const markIndex = log.entries.length
  const changedAt = Date.now()
  await post(tab2, change)
  // EventSource's own retry (about 3 s in Chromium) brings tab 1 back.
  await until('tab 1 to reconnect', () => counts.sse > sseBefore)
  const reconnectMs = Date.now() - changedAt
  let reloadMs = null
  if (reloads) {
    await until('tab 1 to reload', () => docsOf(log, path).length > 1)
    reloadMs = docsOf(log, path)[1].t - changedAt
  } else {
    await sleep(1000)
  }
  await connected(tab1)
  const afterChange = await snapshot(tab1)
  const guardAfter = await guardRecord(tab1)
  const bumpStatus = await bump(browser, origin, path)
  await sleep(500)
  const afterBump = await snapshot(tab1)
  await sleep(SETTLE_MS)
  const settled = await snapshot(tab1)
  const loads = docsOf(log, path).length
  const result = {
    path,
    change,
    loads,
    pageGets: counts.gets[path],
    sseConnects: counts.sse,
    sseLayouts: [...counts.sseLayouts],
    reconnectMs,
    reloadMs,
    held,
    oldDocument: oldDocActivity(log, held, changedAt, markIndex),
    afterChange,
    guardAfter,
    bumpStatus,
    afterBump,
    settled,
    violations: log.violations,
    warnings: log.warnings,
  }

  expect(name, `${reloads ? 2 : 1} page loads`, loads === (reloads ? 2 : 1), loads)
  expect(name, 'server saw as many page GETs', counts.gets[path] === loads, counts.gets[path])
  expect(name, 'no misplaced value at any time', log.violations.length === 0, log.violations)
  if (reloads) {
    expect(
      name,
      'old document took no patch',
      result.oldDocument.patchesApplied === 0,
      result.oldDocument,
    )
    expect(
      name,
      'old document did not change',
      result.oldDocument.contentChanges === 0,
      result.oldDocument,
    )
    expect(
      name,
      'one layout reload directive',
      result.oldDocument.reloadDirectives.length === 1 &&
        result.oldDocument.reloadDirectives[0].reason === 'layout',
      result.oldDocument.reloadDirectives,
    )
    expect(name, 'reloaded into a new document', afterChange.doc !== held.doc)
    expect(name, 'guard record cleared by the healthy connection', guardAfter === null, guardAfter)
  } else {
    expect(name, 'same document throughout', settled.doc === held.doc)
  }
  expectContent(name, 'after the change', afterChange, {
    signedIn: signedInAfter,
    total: 7,
    members: 42,
  })
  expectContent(name, 'after a bump', afterBump, {
    signedIn: signedInAfter,
    total: 8,
    members: 142,
  })
  expect(name, 'connected', settled.connection === 'connected', settled.connection)
  result.fresh = await sameAsFreshLoad(name, context, origin, path, tab1)
  await context.close()
  await close()
  return result
}

/** B: claims change with no rotation, so the stream stays up; then tab 1
 *  sends an event of its own. */
async function noRotation(browser, name, path) {
  const { origin, counts, close } = await boot()
  const { context, watched } = await newContext(browser)
  const { page: tab1, log } = await watched()
  const tab2 = await context.newPage()
  await tab2.goto(`${origin}/elsewhere`)

  await tab1.goto(`${origin}${path}`)
  await connected(tab1)
  const held = await snapshot(tab1)
  const sseBefore = counts.sse

  await post(tab2, '/login-norotate')
  await sleep(4000)
  const reconnected = counts.sse > sseBefore
  await bump(browser, origin, path)
  await sleep(500)
  const afterBump = await snapshot(tab1)

  const markIndex = log.entries.length
  const clickedAt = await ownClick(tab1, log)
  await until('tab 1 to reload', () => docsOf(log, path).length > 1)
  const reloadMs = docsOf(log, path)[1].t - clickedAt
  await connected(tab1)
  const afterClick = await snapshot(tab1)
  const guardAfter = await guardRecord(tab1)
  await sleep(SETTLE_MS)
  const settled = await snapshot(tab1)
  const loads = docsOf(log, path).length
  const ownEvents = counts.events.filter((e) => e.pageLayout)
  const result = {
    path,
    loads,
    pageGets: counts.gets[path],
    sseConnects: counts.sse,
    reconnected,
    held,
    afterBump,
    eventResponses: ownEvents.map(({ at, ...rest }) => ({ receivedMs: at - clickedAt, ...rest })),
    timeline: log.entries
      .slice(markIndex)
      .filter((e) => e.path === path)
      .map(({ kind, doc, t }) => `${t - clickedAt} ms ${doc} ${kind}`),
    oldDocument: oldDocActivity(log, held, clickedAt, markIndex),
    reloadMs,
    afterClick,
    guardAfter,
    settled,
    violations: log.violations,
    warnings: log.warnings,
  }

  expect(name, 'stream stayed up through the claims change', !reconnected)
  expect(name, 'fan-out kept the old document right', afterBump.doc === held.doc)
  expectContent(name, 'after a bump', afterBump, { signedIn: false, total: 8 })
  const body = ownEvents[0]?.body
  expect(
    name,
    'event committed and answered with one layout reload and no patches',
    ownEvents.length === 1 &&
      ownEvents[0].status === 200 &&
      body.committed === true &&
      body.patches.length === 0 &&
      body.directives.length === 1 &&
      body.directives[0].reason === 'layout',
    ownEvents,
  )
  expect(
    name,
    'old document took no patch from the event',
    result.oldDocument.patchesApplied === 0,
    result.oldDocument,
  )
  expect(name, '2 page loads', loads === 2, loads)
  expect(name, 'server saw 2 page GETs', counts.gets[path] === 2, counts.gets[path])
  expect(name, 'no misplaced value at any time', log.violations.length === 0, log.violations)
  // 7, the other visitor's bump, and the tab's own event.
  expectContent(name, 'after the reload', afterClick, { signedIn: true, total: 9, members: 242 })
  expect(name, 'guard record cleared by the healthy connection', guardAfter === null, guardAfter)
  expect(name, 'connected', settled.connection === 'connected', settled.connection)
  result.fresh = await sameAsFreshLoad(name, context, origin, path, tab1)
  await context.close()
  await close()
  return result
}

/** D: anonymous page, away, sign in, Back. */
async function back(browser, name, path, { bfcache, reloads }) {
  const { origin, counts, close } = await boot()
  const { context, watched } = await newContext(browser)
  const { page, log } = await watched()
  const first = await page.goto(`${origin}${path}`)
  await connected(page)
  const held = await snapshot(page)
  const cacheControl = first.headers()['cache-control'] ?? null

  await page.goto(`${origin}/elsewhere`)
  await post(page, '/login')
  const markIndex = log.entries.length
  const getsBefore = counts.gets[path]
  const sseBefore = counts.sse
  const backAt = Date.now()
  await page.goBack({ waitUntil: 'commit' })
  // Stable: connected, and no new document for a while.
  let last = -1
  await until(
    'the page to settle after Back',
    async () => {
      const n = docsOf(log, path).length
      const snap = await snapshot(page).catch(() => null)
      if (n !== last || snap?.connection !== 'connected') {
        last = n
        await sleep(1500)
        return false
      }
      return true
    },
    30_000,
  )
  const afterBack = await snapshot(page)
  const guardAfter = await guardRecord(page)
  const sinceBack = log.entries.slice(markIndex).filter((e) => e.path === path)
  const shows = sinceBack
    .filter((e) => e.kind === 'pageshow')
    .map(({ doc, persisted, transferSize, notRestoredReasons, t }) => ({
      doc,
      persisted,
      transferSize,
      notRestoredReasons,
      ms: t - backAt,
    }))
  const documentsSinceBack = sinceBack
    .filter((e) => e.kind === 'document')
    .map(({ doc, navType, t }) => ({ doc, navType, ms: t - backAt }))
  await bump(browser, origin, path)
  await sleep(500)
  const afterBump = await snapshot(page)
  await sleep(SETTLE_MS)
  const settled = await snapshot(page)
  const restored = shows[0]?.persisted === true && shows[0].doc === held.doc
  // The document Back showed: the restored one, or the one it loaded.
  const shownDoc = restored ? held.doc : documentsSinceBack[0]?.doc
  const result = {
    path,
    bfcache,
    cacheControl,
    held,
    restoredFromBfcache: restored,
    shows,
    documentsSinceBack,
    documentsAfterSettle: docsOf(log, path).length,
    pageGetsSinceBack: counts.gets[path] - getsBefore,
    sseConnectsSinceBack: counts.sse - sseBefore,
    shownDocument: oldDocActivity(
      log,
      { ...held, doc: shownDoc },
      restored ? backAt : (sinceBack.find((e) => e.kind === 'pageshow')?.t ?? backAt),
      markIndex,
    ),
    afterBack,
    guardAfter,
    afterBump,
    settled,
    violations: log.violations,
    warnings: log.warnings,
  }

  if (bfcache) expect(name, 'Back restored the page from bfcache', restored, shows)
  const expectedDocs = (restored ? 0 : 1) + (reloads ? 1 : 0)
  expect(
    name,
    `${expectedDocs} new document(s) after Back`,
    documentsSinceBack.length === expectedDocs,
    documentsSinceBack,
  )
  expect(
    name,
    'no further document while settling',
    result.documentsAfterSettle === 1 + documentsSinceBack.length,
    result.documentsAfterSettle,
  )
  if (reloads) {
    expect(
      name,
      'shown document took no patch',
      result.shownDocument.patchesApplied === 0,
      result.shownDocument,
    )
    expect(
      name,
      'shown document did not change',
      result.shownDocument.contentChanges === 0,
      result.shownDocument,
    )
    expect(
      name,
      'one layout reload directive',
      result.shownDocument.reloadDirectives.length === 1 &&
        result.shownDocument.reloadDirectives[0].reason === 'layout',
      result.shownDocument.reloadDirectives,
    )
    expect(name, 'guard record cleared by the healthy connection', guardAfter === null, guardAfter)
  }
  expect(name, 'no misplaced value at any time', log.violations.length === 0, log.violations)
  expectContent(name, 'after Back', afterBack, { signedIn: true, total: 7, members: 42 })
  expectContent(name, 'after a bump', afterBump, { signedIn: true, total: 8, members: 142 })
  expect(name, 'connected', settled.connection === 'connected', settled.connection)
  result.fresh = await sameAsFreshLoad(name, context, origin, path, page)
  await context.close()
  await close()
  return result
}

/**
 * G: a non-live page mismatches more than once. Nothing clears the guard
 * record there (only a healthy live connection does), so this measures how
 * long each reload takes. Reports; the only checks are on what is shown.
 */
async function nonLiveRepeat(browser, name) {
  const path = '/shift-static'
  const { origin, counts, close } = await boot()
  const { context, watched } = await newContext(browser)
  const { page: tab1, log } = await watched()
  const tab2 = await context.newPage()
  await tab2.goto(`${origin}/elsewhere`)
  await tab1.goto(`${origin}${path}`)
  const steps = []
  let total = 7

  /** `change` in tab 2, then tab 1's own event; time the reload it is owed. */
  const mismatch = async (label, change, signedIn, { manualReloadFirst } = {}) => {
    if (manualReloadFirst) {
      await post(tab2, manualReloadFirst)
      await tab1.reload()
    }
    await post(tab2, change)
    const docsBefore = docsOf(log, path).length
    const recordBefore = await guardRecord(tab1)
    const before = await snapshot(tab1)
    const markIndex = log.entries.length
    const responsesBefore = counts.events.length
    const clickedAt = await ownClick(tab1, log)
    total += 1
    await until('the event response', () => counts.events.length > responsesBefore)
    await sleep(300)
    const stillOld = docsOf(log, path).length === docsBefore
    const whileWaiting = stillOld ? await snapshot(tab1).catch(() => null) : null
    await until('the reload', () => docsOf(log, path).length > docsBefore, 70_000)
    const reloadMs = docsOf(log, path)[docsBefore].t - clickedAt
    await tab1.waitForLoadState('load')
    const after = await snapshot(tab1)
    const step = {
      label,
      change,
      recordBefore,
      eventResponse: counts.events.at(-1),
      reloadMs,
      whileWaiting,
      oldDocument: oldDocActivity(log, before, clickedAt, markIndex),
      after,
      recordAfter: await guardRecord(tab1),
    }
    steps.push(step)
    expectContent(name, `${label}: after the reload`, after, {
      signedIn,
      total,
      members: 42 + (total - 7) * 100,
    })
    expect(
      name,
      `${label}: old document took no patch`,
      step.oldDocument.patchesApplied === 0,
      step.oldDocument,
    )
  }

  await mismatch('1 first mismatch (server expects member layout)', '/login-norotate', true)
  await mismatch(
    '2 next mismatch, other layout (server expects anonymous)',
    '/logout-norotate',
    false,
  )
  await mismatch('3 next mismatch, member layout again', '/login-norotate', true)
  // The page is reloaded by hand into the anonymous layout, so the next
  // mismatch expects the same layout as the last one did.
  await mismatch('4 same expected layout as the last reload', '/login-norotate', true, {
    manualReloadFirst: '/logout-norotate',
  })
  await mismatch('5 same expected layout a third time', '/login-norotate', true, {
    manualReloadFirst: '/logout-norotate',
  })
  await sleep(SETTLE_MS)
  const result = {
    path,
    steps,
    loads: docsOf(log, path).length,
    pageGets: counts.gets[path],
    sseConnects: counts.sse,
    settled: await snapshot(tab1),
    violations: log.violations,
    warnings: log.warnings,
  }
  // The first load, five owed reloads, two by hand.
  expect(name, '8 page loads', result.loads === 8, result.loads)
  expect(name, 'no misplaced value at any time', log.violations.length === 0, log.violations)
  await sameAsFreshLoad(name, context, origin, path, tab1, false)
  await context.close()
  await close()
  return result
}

async function main() {
  const report = {}
  const run = async (name, fn) => {
    if (ONLY && !ONLY.some((prefix) => name.startsWith(prefix))) return
    const start = Date.now()
    try {
      report[name] = await fn(name)
    } catch (err) {
      report[name] = { error: String(err?.stack ?? err), log: lastLog }
      failures.push(`${name}: ${err.message}`)
    }
    console.error(`${name}: ${Date.now() - start} ms`)
  }
  // Playwright switches the back/forward cache off; the first launch puts it back.
  for (const bfcache of [true, false]) {
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      ignoreDefaultArgs: bfcache ? ['--disable-back-forward-cache'] : [],
    })
    report[bfcache ? 'bfcacheOn' : 'bfcacheOff'] = browser.version()
    if (bfcache) {
      await run('A_signInOtherTab', (n) =>
        otherTab(browser, n, '/shift', { change: '/login', signedInAfter: true, reloads: true }),
      )
      await run('A_signInOtherTab_machinePlain', (n) =>
        otherTab(browser, n, '/machine-plain', {
          change: '/login',
          signedInAfter: true,
          reloads: true,
        }),
      )
      await run('B_claimsNoRotation', (n) => noRotation(browser, n, '/shift'))
      await run('C_signOutOtherTab', (n) =>
        otherTab(browser, n, '/shift', {
          before: '/login',
          change: '/logout',
          signedInAfter: false,
          reloads: true,
        }),
      )
      await run('E_whenRead_signIn', (n) =>
        otherTab(browser, n, '/machine-when', {
          change: '/login',
          signedInAfter: true,
          reloads: false,
        }),
      )
      await run('E_whenRead_signOut', (n) =>
        otherTab(browser, n, '/machine-when', {
          before: '/login',
          change: '/logout',
          signedInAfter: false,
          reloads: false,
        }),
      )
      await run('G_nonLiveRepeat', (n) => nonLiveRepeat(browser, n))
    }
    const suffix = bfcache ? 'bfcache' : 'httpCache'
    await run(`D_back_${suffix}`, (n) => back(browser, n, '/shift', { bfcache, reloads: true }))
    await run(`D_back_${suffix}_machinePlain`, (n) =>
      back(browser, n, '/machine-plain', { bfcache, reloads: true }),
    )
    await run(`D_back_${suffix}_whenRead`, (n) =>
      back(browser, n, '/machine-when', { bfcache, reloads: false }),
    )
    await browser.close()
  }
  console.log(JSON.stringify(report, null, 2))
  for (const failure of failures) console.error(`FAIL ${failure}`)
  if (failures.length === 0) console.log('PASS')
  return failures.length === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
