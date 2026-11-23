// @env happy-dom
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server/create-app.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { createDevApp } from '../src/server/dev.ts'
import { buildHonoApp } from '../src/server/http.ts'
import { layoutFingerprint } from '../src/server/layout-fingerprint.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import type { DiscoveredRoute } from '../src/server/route-discovery.ts'
import { sortRoutes } from '../src/server/route-discovery.ts'
import { defineRoute } from '../src/server/routing.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { activeConnectionCount } from '../src/server/sse.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { classList, defer, each, html, match, read, when } from '../src/template/index.ts'
import type { HtmlFragment } from '../src/template/types.ts'
import { applyPatches } from '../src/wire/apply.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/layout-fingerprint')

type App = { fetch: (request: Request) => Response | Promise<Response>; close: () => Promise<void> }
type Envelope = { patches?: any[]; directives?: any[]; committed?: boolean; ping?: boolean }

const STATOR_ROUTES = new Set(['/component', '/jsx-and'])

/** A fresh app per scenario (the board is app state). `.stator` routes need the
 *  dev app, whose loader compiles them. */
const boot = (path = '/shift'): Promise<App> =>
  STATOR_ROUTES.has(path)
    ? createDevApp({
        root,
        events: { gate: 'off' },
        machinesDir: resolve(root, 'machines'),
        routesDir: resolve(root, 'stator-app/routes'),
        dev: { inspector: false },
      })
    : createApp({
        events: { gate: 'off' },
        machinesDir: resolve(root, 'machines'),
        routesDir: resolve(root, 'routes'),
        buildId: 'B1',
      })

const layoutOf = (html: string): string | undefined =>
  /<meta name="stator-layout" content="([^"]+)">/.exec(html)?.[1]

const bodyOf = (html: string) =>
  /<body>([\s\S]*)<\/body>/
    .exec(html)![1]!
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/\s*\n\s*/g, '')
    .trim()

/** The HTML a tab holds, with what its runtime echoes to the server. */
interface Page {
  path: string
  html: string
  build: string | undefined
  layout: string | undefined
}

/** One browser profile: a cookie jar every tab shares. */
class Browser {
  cookie: string | undefined
  constructor(readonly app: App) {}

  private absorb(res: Response): void {
    const sid = res.headers
      .getSetCookie()
      .map((c) => /stator_sid=([^;]+)/.exec(c)?.[1])
      .filter(Boolean)
      .at(-1)
    if (sid) this.cookie = `stator_sid=${sid}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.cookie ? { Cookie: this.cookie } : {}), ...extra }
  }

  async load(path: string): Promise<Page> {
    const res = await this.app.fetch(
      new Request(`http://localhost${path}`, { headers: this.headers() }),
    )
    this.absorb(res)
    const html = await res.text()
    return {
      path,
      html,
      build: /stator-build" content="([^"]+)"/.exec(html)?.[1],
      layout: layoutOf(html),
    }
  }

  async post(path: string): Promise<void> {
    const res = await this.app.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: this.headers({
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'http://localhost',
        }),
        body: new URLSearchParams(),
      }),
    )
    this.absorb(res)
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`)
  }

  /** A PING from `page`, as its runtime posts it; bumps the board (total +1,
   *  members +100). `layout: false` is a client that predates the header. */
  async event(
    page: Page,
    client: string,
    opts: { layout?: boolean; eventId?: string } = {},
  ): Promise<Envelope> {
    const res = await this.app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: this.headers({
          'Content-Type': 'application/json',
          'X-Stator-Route': `GET ${page.path}`,
          'X-Stator-Client': client,
          ...(page.layout && opts.layout !== false ? { 'X-Stator-Layout': page.layout } : {}),
          Origin: 'http://localhost',
        }),
        body: JSON.stringify({
          machine: 'PingMachine',
          event: { type: 'PING' },
          eventId: opts.eventId,
        }),
      }),
    )
    this.absorb(res)
    assert.equal(res.status, 200, await res.clone().text())
    return (await res.json()) as Envelope
  }

  /** Open `page`'s live channel with the jar's current cookie. */
  async sse(page: Page, client: string, opts: { layout?: boolean } = {}): Promise<Channel> {
    const params = new URLSearchParams({ route: `GET ${page.path}`, client })
    if (page.build) params.set('build', page.build)
    if (page.layout && opts.layout !== false) params.set('layout', page.layout)
    const res = await this.app.fetch(
      new Request(`http://localhost/__sse?${params}`, { headers: this.headers() }),
    )
    this.absorb(res)
    return new Channel(res)
  }
}

/** A live connection as the tab sees it: every envelope, and whether the
 *  server hung up. */
class Channel {
  envelopes: Envelope[] = []
  ended = false
  private buffer = ''
  private pump: Promise<void>
  private reader: ReadableStreamDefaultReader<Uint8Array>

  constructor(res: Response) {
    const reader = res.body!.getReader()
    this.reader = reader
    const decoder = new TextDecoder()
    this.pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          this.buffer += decoder.decode(value, { stream: true })
          let cut = this.buffer.indexOf('\n\n')
          while (cut !== -1) {
            const block = this.buffer.slice(0, cut)
            this.buffer = this.buffer.slice(cut + 2)
            const m = /^data: (.*)$/m.exec(block)
            if (m) this.envelopes.push(JSON.parse(m[1]!))
            cut = this.buffer.indexOf('\n\n')
          }
        }
      } catch {
        // cancelled
      }
      this.ended = true
    })()
  }

  get patchFrames(): any[][] {
    return this.envelopes.filter((e) => e.patches).map((e) => e.patches!)
  }

  get reloads(): any[] {
    return this.envelopes.flatMap((e) => e.directives ?? []).filter((d) => d.type === 'reload')
  }

  async until(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 2000
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  /** The patch frame at `index`, or null if none comes. */
  async frame(index: number, waitMs = 2000): Promise<any[] | null> {
    const deadline = Date.now() + waitMs
    while (this.patchFrames.length <= index) {
      if (Date.now() > deadline || this.ended) return this.patchFrames[index] ?? null
      await new Promise((r) => setTimeout(r, 10))
    }
    return this.patchFrames[index]!
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {})
    await this.pump
  }
}

/** The tab's document: load held HTML, then apply frames with the real applier. */
class Dom {
  warnings: string[] = []
  load(html: string): void {
    document.body.innerHTML = bodyOf(html)
  }
  apply(patches: any[]): void {
    const realWarn = console.warn
    console.warn = (...a: unknown[]) => this.warnings.push(a.join(' '))
    try {
      applyPatches(patches)
    } finally {
      console.warn = realWarn
    }
  }
  get html(): string {
    return document.body.innerHTML.replace(/\s*\n\s*/g, '').trim()
  }
  text(id: string): string | null {
    return document.getElementById(id)?.textContent ?? null
  }
}

/** Another visitor bumps the board: total +1, members +100. */
async function bumpFromElsewhere(app: App, path: string): Promise<void> {
  const other = new Browser(app)
  other.cookie = `stator_sid=${crypto.randomUUID()}`
  await other.event({ path, html: '', build: undefined, layout: undefined }, 'other')
}

/**
 * The session changes under a tab holding `path`. With `connected`, the tab
 * has its channel open when `change` is POSTed from another tab (same jar) and
 * the server hangs it up; without, the page is one the browser kept and shows
 * again (Back). Either way the held page then connects under the new session.
 */
async function reconnectAfter(
  path: string,
  opts: { before?: string; change: string; connected?: boolean },
) {
  const app = await boot(path)
  const browser = new Browser(app)
  if (opts.before) await browser.post(opts.before)
  const held = await browser.load(path)
  const dom = new Dom()
  dom.load(held.html)

  if (opts.connected !== false) {
    const first = await browser.sse(held, 'tab1')
    dom.apply((await first.frame(0))!)
    await browser.post(opts.change)
    await first.until(() => first.ended, 'the old connection to be hung up')
  } else {
    await browser.post(opts.change)
  }
  const beforeReconnect = dom.html

  const second = await browser.sse(held, 'tab1')
  await second.until(() => second.ended || second.patchFrames.length > 0, 'an answer')
  for (const patches of second.patchFrames) dom.apply(patches)
  const registered = activeConnectionCount()

  await bumpFromElsewhere(app, path)
  const fanned = second.ended ? null : await second.frame(1, 500)
  if (fanned) dom.apply(fanned)

  const fresh = await browser.load(path)
  // What the reloaded page gets when it connects.
  const afterReload = await browser.sse(fresh, 'tab1')
  await afterReload.until(() => afterReload.ended || afterReload.envelopes.length > 0, 'a sync')
  const out = {
    held,
    fresh,
    beforeReconnect,
    reconnect: { envelopes: [...second.envelopes], ended: second.ended, registered },
    dom: dom.html,
    warnings: dom.warnings,
    shows: { anon: dom.text('anon'), member: dom.text('member'), total: dom.text('total') },
    freshBody: bodyOf(fresh.html),
    afterReloadReloads: afterReload.reloads.length,
  }
  await second.close()
  await afterReload.close()
  await app.close()
  return out
}

/** The reconnect was answered with one layout reload and nothing else. */
function assertReloaded(r: Awaited<ReturnType<typeof reconnectAfter>>): void {
  assert.deepEqual(r.reconnect.envelopes, [
    { directives: [{ type: 'reload', reason: 'layout', layout: r.fresh.layout }] },
  ])
  assert.notEqual(r.held.layout, r.fresh.layout)
  // The stream ended, the connection was never registered, and the held DOM
  // took no patch.
  assert.equal(r.reconnect.ended, true)
  assert.equal(r.reconnect.registered, 0)
  assert.equal(r.dom, r.beforeReconnect)
  assert.deepEqual(r.warnings, [])
  // The page the reload fetches matches what the server expects.
  assert.equal(r.afterReloadReloads, 0)
}

/**
 * Claims change with no rotation: tab 1's channel (if it has one) stays up.
 * Another visitor's bump fans out to it, then tab 1 sends its own event.
 */
async function ownEventAfter(
  path: string,
  opts: { before?: string; change: string; live: boolean },
) {
  const app = await boot(path)
  const browser = new Browser(app)
  if (opts.before) await browser.post(opts.before)
  // A non-live page has no channel to establish the session; give the jar one.
  if (!browser.cookie) browser.cookie = `stator_sid=${crypto.randomUUID()}`
  const held = await browser.load(path)
  const dom = new Dom()
  dom.load(held.html)

  let channel: Channel | null = null
  if (opts.live) {
    channel = await browser.sse(held, 'tab1')
    dom.apply((await channel.frame(0))!)
  }
  const cookieBefore = browser.cookie

  await browser.post(opts.change)
  // The change itself may fan out to this tab (a session machine it reads moved).
  const onChange = channel ? await channel.frame(1, 200) : null
  if (onChange) dom.apply(onChange)
  const seen = onChange ? 2 : 1

  let fanned: any[] | null = null
  if (channel) {
    await bumpFromElsewhere(app, path)
    fanned = await channel.frame(seen, 500)
    if (fanned) dom.apply(fanned)
  }
  const beforeOwnEvent = dom.html

  const own = await browser.event(held, 'tab1', { eventId: 'own-1' })
  dom.apply(own.patches ?? [])
  const replayed = await browser.event(held, 'tab1', { eventId: 'own-1' })

  const fresh = await browser.load(path)
  const out = {
    held,
    fresh,
    connectionStayedUp: channel ? !channel.ended : null,
    channelReloads: channel?.reloads.length ?? 0,
    cookieChanged: browser.cookie !== cookieBefore,
    fanOut: fanned,
    beforeOwnEvent,
    own,
    replayed,
    dom: dom.html,
    warnings: dom.warnings,
    shows: { anon: dom.text('anon'), member: dom.text('member'), total: dom.text('total') },
    freshBody: bodyOf(fresh.html),
  }
  await channel?.close()
  await app.close()
  return out
}

describe('sign-in in another tab, with rotateSession()', () => {
  for (const [path, what] of [
    ['/shift', 'plain conditional on claims'],
    ['/jsx-and', '.stator `{claims && <p/>}`'],
    ['/component', '.stator component chosen by claims'],
    ['/machine-plain', 'session machine snapshot in a plain conditional'],
  ] as const) {
    it(`${what}: the reconnect is told to reload and takes no patch`, async () => {
      const r = await reconnectAfter(path, { change: '/login' })
      assertReloaded(r)
      assert.equal(r.shows.total, 'Total: 7')
      assert.match(r.freshBody, /id="member"/)
      assert.match(r.freshBody, /Total: <span data-slot="s3">8<\/span>/)
    })
  }

  it('when(claims, …): no reload, the total is patched, the member arm never appears', async () => {
    const r = await reconnectAfter('/when-branch', { change: '/login' })
    assert.equal(r.held.layout, r.fresh.layout)
    assert.deepEqual(
      r.reconnect.envelopes.flatMap((e) => e.directives ?? []),
      [],
    )
    assert.equal(r.shows.total, 'Total: 8')
    assert.equal(r.shows.member, null)
  })

  it('when(read(auth, …)): no reload, converges by patch to the signed-in page', async () => {
    const r = await reconnectAfter('/machine-when', { change: '/login' })
    assert.equal(r.held.layout, r.fresh.layout)
    assert.deepEqual(
      r.reconnect.envelopes.flatMap((e) => e.directives ?? []),
      [],
    )
    assert.equal(r.shows.total, 'Total: 8')
    assert.equal(r.shows.member, 'Signed in as Ada. Members online: 142')
    assert.equal(r.shows.anon, null)
    assert.equal(r.dom, r.freshBody)
  })

  it('claims feed only text and attribute values: no reload', async () => {
    const r = await reconnectAfter('/text-only', { change: '/login' })
    assert.equal(r.held.layout, r.fresh.layout)
    assert.deepEqual(
      r.reconnect.envelopes.flatMap((e) => e.directives ?? []),
      [],
    )
    assert.equal(r.shows.total, 'Total: 8')
  })
})

describe('sign-in in another tab, claims only (no rotation)', () => {
  it("plain conditional on claims (live): fan-out is right, the tab's own event reloads it", async () => {
    const r = await ownEventAfter('/shift', { change: '/login-norotate', live: true })
    assert.equal(r.connectionStayedUp, true)
    assert.equal(r.cookieChanged, false)
    // Fan-out diffs against the connect-time (anonymous) layout the page holds.
    assert.deepEqual(r.fanOut, [
      { target: { kind: 'element', id: 'e0' }, op: 'attr', name: 'title', value: 'total:8' },
      { target: { kind: 'slot', id: 's1' }, op: 'text', value: '8' },
    ])
    // The event commits, and its response is the reload alone.
    assert.deepEqual(r.own, {
      patches: [],
      directives: [{ type: 'reload', reason: 'layout', layout: r.fresh.layout }],
      committed: true,
    })
    assert.equal(r.channelReloads, 0)
    assert.equal(r.dom, r.beforeOwnEvent)
    assert.deepEqual(r.warnings, [])
    // A retry replays the same answer without committing twice.
    assert.deepEqual(r.replayed, r.own)
    assert.match(r.freshBody, /Total: <span data-slot="s3">9<\/span>/)
  })

  it('plain conditional on claims (not live): the event commits and the response is the reload', async () => {
    const r = await ownEventAfter('/shift-static', { change: '/login-norotate', live: false })
    assert.deepEqual(r.own, {
      patches: [],
      directives: [{ type: 'reload', reason: 'layout', layout: r.fresh.layout }],
      committed: true,
    })
    assert.equal(r.shows.total, 'Total: 7')
    assert.deepEqual(r.replayed, r.own)
    assert.match(r.freshBody, /Total: <span data-slot="s3">8<\/span>/)
  })

  it('when(read(auth, …)) (live): fan-out flips the arm, the event is patched with no reload', async () => {
    const r = await ownEventAfter('/machine-when', { change: '/login-norotate', live: true })
    assert.deepEqual(r.own.directives, [])
    assert.equal(r.shows.total, 'Total: 9')
    assert.equal(r.shows.member, 'Signed in as Ada. Members online: 242')
    assert.deepEqual(r.warnings, [])
  })

  it('when(claims, …) (live): no reload', async () => {
    const r = await ownEventAfter('/when-branch', { change: '/login-norotate', live: true })
    assert.deepEqual(r.own.directives, [])
    assert.equal(r.shows.total, 'Total: 9')
  })
})

describe('sign-out in another tab', () => {
  it('clearSession() (plain conditional): the reconnect is told to reload', async () => {
    const r = await reconnectAfter('/shift', { before: '/login', change: '/logout' })
    assertReloaded(r)
    assert.equal(r.shows.member, 'Signed in as u1. Members online: 42')
    assert.equal(r.shows.total, 'Total: 7')
    assert.match(r.freshBody, /id="anon"/)
  })

  it("clearClaims() without rotation (plain conditional): the tab's own event reloads it", async () => {
    const r = await ownEventAfter('/shift', {
      before: '/login',
      change: '/logout-norotate',
      live: true,
    })
    assert.equal(r.connectionStayedUp, true)
    assert.deepEqual(r.own, {
      patches: [],
      directives: [{ type: 'reload', reason: 'layout', layout: r.fresh.layout }],
      committed: true,
    })
    assert.equal(r.dom, r.beforeOwnEvent)
  })

  it('clearSession() (when(read(auth, …))): no reload, converges to the anonymous page', async () => {
    const r = await reconnectAfter('/machine-when', { before: '/login', change: '/logout' })
    assert.deepEqual(
      r.reconnect.envelopes.flatMap((e) => e.directives ?? []),
      [],
    )
    assert.equal(r.shows.member, null)
    assert.equal(r.shows.anon, 'Sign in')
    assert.equal(r.shows.total, 'Total: 8')
    assert.equal(r.dom, r.freshBody)
  })

  it('clearSession() (when(claims, …)): no reload', async () => {
    const r = await reconnectAfter('/when-branch', { before: '/login', change: '/logout' })
    assert.equal(r.held.layout, r.fresh.layout)
    assert.deepEqual(
      r.reconnect.envelopes.flatMap((e) => e.directives ?? []),
      [],
    )
    assert.equal(r.shows.total, 'Total: 8')
  })
})

describe('Back to a page kept from before sign-in', () => {
  it('live page: the kept page reconnects under the new session and is told to reload', async () => {
    const r = await reconnectAfter('/shift', { change: '/login', connected: false })
    assertReloaded(r)
    assert.equal(r.shows.anon, 'Sign in')
    assert.equal(r.shows.total, 'Total: 7')
  })

  it('page that is not live: its next event is answered with the reload', async () => {
    const app = await boot()
    const browser = new Browser(app)
    browser.cookie = `stator_sid=${crypto.randomUUID()}`
    const held = await browser.load('/shift-static')
    await browser.post('/login')
    const own = await browser.event(held, 'tab1')
    const fresh = await browser.load('/shift-static')
    await app.close()
    assert.deepEqual(own, {
      patches: [],
      directives: [{ type: 'reload', reason: 'layout', layout: fresh.layout }],
      committed: true,
    })
    assert.notEqual(held.layout, fresh.layout)
  })

  it('when(read(auth, …)): no reload', async () => {
    const r = await reconnectAfter('/machine-when', { change: '/login', connected: false })
    assert.deepEqual(
      r.reconnect.envelopes.flatMap((e) => e.directives ?? []),
      [],
    )
    assert.equal(r.dom, r.freshBody)
  })
})

describe('pages that are never checked', () => {
  it('a client that sends no fingerprint is patched as before, on /__sse and /__events', async () => {
    const app = await boot()
    const browser = new Browser(app)
    browser.cookie = `stator_sid=${crypto.randomUUID()}`
    const held = await browser.load('/shift')
    await browser.post('/login-norotate')

    const channel = await browser.sse(held, 'tab1', { layout: false })
    const sync = await channel.frame(0)
    const own = await browser.event(held, 'tab1', { layout: false })
    await channel.close()
    await app.close()

    assert.ok(sync && sync.length > 0)
    assert.deepEqual(channel.reloads, [])
    assert.deepEqual(own.directives, [])
    assert.ok(own.patches!.length > 0)
  })

  it('a page with no root-scope bindings carries no fingerprint', async () => {
    const app = await boot()
    const browser = new Browser(app)
    const page = await browser.load('/elsewhere')
    await app.close()
    assert.equal(page.layout, undefined)
    assert.ok(!page.html.includes('stator-layout'))
  })

  it('a matching page sees no reload and no extra frame', async () => {
    const app = await boot()
    const browser = new Browser(app)
    browser.cookie = `stator_sid=${crypto.randomUUID()}`
    const page = await browser.load('/shift')
    assert.match(page.layout!, /^[0-9a-f]{8}$/)
    const channel = await browser.sse(page, 'tab1')
    await channel.frame(0)
    const own = await browser.event(page, 'tab1')
    await channel.close()
    await app.close()
    assert.equal(channel.envelopes.length, 1)
    assert.deepEqual(own.directives, [])
    assert.deepEqual(
      own.patches!.map((p) => p.target.id),
      ['e0', 's1'],
    )
  })
})

describe('cascading routes', () => {
  const Counter = defineMachine({
    name: 'CounterMachine',
    lifecycle: 'session',
    events: {} as { type: 'BUMP' },
    context: { a: 1, b: 2 },
    initial: 'ready',
    states: {
      ready: {
        on: {
          BUMP: (ctx) => {
            ctx.a += 1
          },
        },
      },
    },
    selectors: { a: (ctx) => ctx.a, b: (ctx) => ctx.b },
  })
  const page = (
    urlPath: string,
    paramNames: string[],
    GET: DiscoveredRoute['GET'],
    extra: Partial<DiscoveredRoute> = {},
  ) => ({ urlPath, paramNames, filePath: `<test>${urlPath}`, GET, ...extra }) as DiscoveredRoute
  const doc = (body: HtmlFragment) =>
    html`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`
  const patternOf = (html: string): string | undefined =>
    /<meta name="stator-pattern" content="([^"]+)">/.exec(html)?.[1]

  // `a` is at s0 in the specific route and at s1 in the catch-alls.
  const specific = page(
    '/posts/:slug',
    ['slug'],
    defineRoute({
      reads: [Counter],
      live: true,
      render: ({ CounterMachine: c, response }: any, request) => {
        if (request.params.slug !== 'known') response.status = 404
        return doc(html`<p>${read(c, (m: any) => m.a)}</p>`)
      },
    }),
  )
  const catchAllRoute = defineRoute({
    reads: [Counter],
    live: true,
    render: ({ CounterMachine: c }: any) =>
      doc(html`<p>${read(c, (m: any) => m.b)}</p><p>${read(c, (m: any) => m.a)}</p>`),
  })
  const catchAll = page('/posts/*rest', ['rest'], catchAllRoute)
  const notFound = page('/*__stator_notfound__', ['__stator_notfound__'], catchAllRoute, {
    isNotFoundFallback: true,
  })

  const boot = (routes: DiscoveredRoute[]) =>
    buildHonoApp({
      routes: sortRoutes(routes),
      store: new MachineStore([Counter], new InMemoryStore()),
    })
  type Hono = Awaited<ReturnType<typeof boot>>

  const cookie = () => `stator_sid=${crypto.randomUUID()}`
  const load = async (app: Hono, path: string, sid: string) =>
    (await app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: sid } }))).text()
  const bump = async (
    app: Hono,
    path: string,
    sid: string,
    echo: { layout?: string; pattern?: string },
  ) => {
    const res = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          Cookie: sid,
          'Content-Type': 'application/json',
          'X-Stator-Route': `GET ${path}`,
          ...(echo.layout ? { 'X-Stator-Layout': echo.layout } : {}),
          ...(echo.pattern ? { 'X-Stator-Pattern': echo.pattern } : {}),
          Origin: 'http://localhost',
        },
        body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'BUMP' } }),
      }),
    )
    assert.equal(res.status, 200, await res.clone().text())
    return (await res.json()) as Envelope
  }
  const connect = async (
    app: Hono,
    path: string,
    sid: string,
    echo: { layout?: string; pattern?: string },
  ) => {
    const params = new URLSearchParams({ route: `GET ${path}`, client: 'c1' })
    if (echo.layout) params.set('layout', echo.layout)
    if (echo.pattern) params.set('pattern', echo.pattern)
    const res = await app.fetch(
      new Request(`http://localhost/__sse?${params}`, { headers: { Cookie: sid } }),
    )
    assert.equal(res.status, 200)
    return new Channel(res)
  }
  const echoOf = (html: string) => ({ layout: layoutOf(html), pattern: patternOf(html) })
  const staleReload = [{ type: 'reload', reason: 'layout', layout: 'pattern' }]

  it('the meta is the fingerprint of the candidate that is served', async () => {
    const app = await boot([specific, catchAll])
    const won = await load(app, '/posts/known', cookie())
    const fellThrough = await load(app, '/posts/other', cookie())

    assert.equal(won.match(/stator-layout/g)?.length, 1)
    assert.equal(fellThrough.match(/stator-layout/g)?.length, 1)
    assert.match(fellThrough, /<span data-slot="s1">1<\/span>/)
    assert.notEqual(layoutOf(won), layoutOf(fellThrough))
  })

  it('only a page served by a later candidate names its route', async () => {
    const app = await boot([specific, catchAll])
    assert.equal(patternOf(await load(app, '/posts/known', cookie())), undefined)
    assert.equal(patternOf(await load(app, '/posts/other', cookie())), '/posts/*rest')
  })

  it('an event from a fall-through page is patched from the route that rendered it', async () => {
    const app = await boot([specific, catchAll])
    const sid = cookie()
    const html = await load(app, '/posts/other', sid)

    const res = await bump(app, '/posts/other', sid, echoOf(html))
    assert.deepEqual(res.directives, [])
    assert.deepEqual(
      res.patches!.map((p) => [p.target.id, p.value]),
      [['s1', '2']],
    )
  })

  it('a page that names no route is resolved to the first match', async () => {
    const app = await boot([specific, catchAll])
    const sid = cookie()
    const html = await load(app, '/posts/known', sid)

    const res = await bump(app, '/posts/known', sid, echoOf(html))
    assert.deepEqual(res.directives, [])
    assert.deepEqual(
      res.patches!.map((p) => p.target.id),
      ['s0'],
    )
  })

  it('a fall-through page that sends no pattern is reloaded, not patched from the first match', async () => {
    const app = await boot([specific, catchAll])
    const sid = cookie()
    const html = await load(app, '/posts/other', sid)

    const res = await bump(app, '/posts/other', sid, { layout: layoutOf(html) })
    assert.deepEqual(res.patches, [])
    assert.equal(res.directives![0].reason, 'layout')
  })

  it('a pattern that is no candidate for the path reloads and dispatches nothing', async () => {
    const app = await boot([specific, catchAll, page('/docs/*rest', ['rest'], catchAllRoute)])
    const sid = cookie()
    const html = await load(app, '/posts/other', sid)
    const echo = echoOf(html)

    for (const pattern of ['/gone/*rest', '/docs/*rest']) {
      const res = await bump(app, '/posts/other', sid, { ...echo, pattern })
      assert.deepEqual(res, { patches: [], directives: staleReload, committed: false })

      const channel = await connect(app, '/posts/other', sid, { ...echo, pattern })
      await channel.until(() => channel.ended, 'the stream to end')
      assert.deepEqual(channel.envelopes, [{ directives: staleReload }])
    }

    const res = await bump(app, '/posts/other', sid, echo)
    assert.deepEqual(
      res.patches!.map((p) => p.value),
      ['2'],
    )
  })

  it('a live fall-through page connects without a reload', async () => {
    for (const [routes, pattern] of [
      [[specific, catchAll], '/posts/*rest'],
      [[specific, notFound], '/*__stator_notfound__'],
    ] as const) {
      const app = await boot([...routes])
      const sid = cookie()
      const html = await load(app, '/posts/other', sid)
      assert.equal(patternOf(html), pattern)

      const channel = await connect(app, '/posts/other', sid, echoOf(html))
      const res = await bump(app, '/posts/other', sid, echoOf(html))
      assert.deepEqual(res.directives, [])
      await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(channel.reloads, [])
      assert.equal(channel.ended, false)
      await channel.close()
    }
  })
})

describe('layoutFingerprint', () => {
  type Events = { type: 'OPEN' } | { type: 'ADD' }
  const Cart = defineMachine({
    name: 'CartMachine',
    lifecycle: 'session',
    events: {} as Events,
    context: { open: false, items: [] as { id: string }[] },
    initial: 'idle',
    states: {
      idle: {
        on: {
          OPEN: (ctx) => {
            ctx.open = true
          },
          ADD: (ctx) => {
            ctx.items.push({ id: `p${ctx.items.length}` })
          },
        },
      },
    },
    selectors: {
      open: (ctx) => ctx.open,
      items: (ctx) => ctx.items,
      count: (ctx) => ctx.items.length,
    },
  })

  async function cartProxy() {
    const store = new MachineStore([Cart], new InMemoryStore())
    const runtime = new SessionRuntime('s1', store)
    await runtime.loadGraph([Cart])
    return runtime.proxyFor('CartMachine') as any
  }

  function fingerprint(render: () => HtmlFragment, resolveDeferred = true): string | undefined {
    const state = createRenderState('s1', 'GET /')
    state.resolveDeferred = resolveDeferred
    runInRender(state, render)
    return layoutFingerprint(state)
  }

  it('is eight hex characters, and equal for two renders of the same state', async () => {
    const cart = await cartProxy()
    const page = () =>
      html`<p title="${read(cart, (c: any) => c.count)}">${read(cart, (c: any) => c.count)}</p>`
    const fp = fingerprint(page)
    assert.match(fp!, /^[0-9a-f]{8}$/)
    assert.equal(fingerprint(page), fp)
  })

  it('differs across a plain-conditional flip ahead of a binding', async () => {
    const cart = await cartProxy()
    const page = (member: boolean) => () =>
      html`${member ? html`<i>${read(cart, (c: any) => c.count)}</i>` : ''}<p>${read(cart, (c: any) => c.open)}</p>`
    assert.notEqual(fingerprint(page(true)), fingerprint(page(false)))
  })

  it('is equal across a when/match arm flip and across list rows changing', async () => {
    const cart = await cartProxy()
    const page = () =>
      html`${when(
        read(cart, (c: any) => c.open),
        () =>
          html`<i ${classList({ on: read(cart, (c: any) => c.open) })}>${read(cart, (c: any) => c.count)}</i>`,
      )}${match(
        read(cart, (c: any) => (c.open ? 'yes' : 'no')),
        { yes: () => html`<b>${read(cart, (c: any) => c.count)}</b>`, no: () => html`<u></u>` },
      )}<ul>${each(
        read(cart, (c: any) => c.items),
        (item: any) => html`<li>${item.id}: ${read(cart, (c: any) => c.count)}</li>`,
        { key: (item: any) => item.id },
      )}</ul><p>${read(cart, (c: any) => c.count)}</p>`
    const closed = fingerprint(page)
    cart.send({ type: 'OPEN' })
    cart.send({ type: 'ADD' })
    cart.send({ type: 'ADD' })
    assert.equal(fingerprint(page), closed)
  })

  it('differs for same-shape arms with different selectors', async () => {
    const cart = await cartProxy()
    const page = (member: boolean) => () =>
      html`<p>${member ? read(cart, (c: any) => c.count) : read(cart, (c: any) => c.open)}</p>`
    assert.notEqual(fingerprint(page(true)), fingerprint(page(false)))
  })

  it('differs when an attribute binding moves to another element or attribute', async () => {
    const cart = await cartProxy()
    const title = () => html`<p title="${read(cart, (c: any) => c.count)}"></p>`
    const lang = () => html`<p lang="${read(cart, (c: any) => c.count)}"></p>`
    // The static class:list takes element id e0, so the bound element is e1.
    const later = () =>
      html`<a ${classList({ x: true })}></a><p title="${read(cart, (c: any) => c.count)}"></p>`
    assert.notEqual(fingerprint(title), fingerprint(lang))
    assert.notEqual(fingerprint(title), fingerprint(later))
  })

  it('is the same whether or not defer slots are resolved', async () => {
    const cart = await cartProxy()
    const page = () =>
      html`${defer(() => 'x', { ready: (v) => html`<i>${v}</i>` })}<p>${read(cart, (c: any) => c.count)}</p>`
    assert.equal(fingerprint(page, false), fingerprint(page, true))
  })

  it('is absent with no root-scope bindings', async () => {
    const cart = await cartProxy()
    assert.equal(
      fingerprint(() => html`<p>static</p>`),
      undefined,
    )
    // Unbound when/each allocate slots but register nothing.
    assert.equal(
      fingerprint(() => html`${when(true, () => html`<p>${read(cart, (c: any) => c.count)}</p>`)}`),
      undefined,
    )
  })
})
