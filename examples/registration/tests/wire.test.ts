import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'


/**
 * The whole desk arc over the wire, one linear story: register → duplicate
 * refused → resize → fill to capacity → sold out → remove frees seats.
 * A refusal is a `committed: false` dispatch — the form keeps your typing.
 */

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp

before(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
    staticDir: resolve(here, '../static'),
  })
}, { timeout: 30_000 })

after(async () => {
  await app.close()
})

function sidOf(res: Response): string | null {
  return res.headers.get('set-cookie')?.match(/stator_sid=([^;]+)/)?.[1] ?? null
}

async function register(
  sid: string,
  fields: { name: string; email: string; seats: number; ticket?: string; updates?: boolean },
): Promise<{ committed: boolean }> {
  const res = await app.fetch(
    new Request('http://test/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': 'GET /',
        Cookie: `stator_sid=${sid}`,
      },
      body: JSON.stringify({
        machine: 'DeskMachine',
        event: { type: 'REGISTER', ticket: 'general', ...fields },
      }),
    }),
  )
  return (await res.json()) as { committed: boolean }
}

async function send(sid: string, event: object): Promise<{ committed: boolean }> {
  const res = await app.fetch(
    new Request('http://test/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': 'GET /',
        Cookie: `stator_sid=${sid}`,
      },
      body: JSON.stringify({ machine: 'DeskMachine', event }),
    }),
  )
  return (await res.json()) as { committed: boolean }
}

async function sendForPatches(sid: string, event: object): Promise<{ committed: boolean; patches: unknown[] }> {
  const res = await app.fetch(
    new Request('http://test/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': 'GET /',
        Cookie: `stator_sid=${sid}`,
      },
      body: JSON.stringify({ machine: 'DeskMachine', event }),
    }),
  )
  assert.equal(res.status, 200)
  return (await res.json()) as { committed: boolean; patches: unknown[] }
}

async function page(sid: string): Promise<string> {
  const res = await app.fetch(
    new Request('http://test/', { headers: { Cookie: `stator_sid=${sid}` } }),
  )
  return res.text()
}

describe('the desk over the wire', () => {
  let sid: string

  before(async () => {
    sid = sidOf(await app.fetch(new Request('http://test/')))!
  })

  it('registers a clean party and the roster shows it', async () => {
    const r = await register(sid, {
      name: 'Ada Lovelace',
      email: 'ada@lovelace.dev',
      seats: 2,
      updates: true,
    })
    assert.equal(r.committed, true)
    const html = await page(sid)
    assert.ok(html.includes('Ada Lovelace'))
    // No server-side confirmation line: the acknowledgement is client-local
    // (an island flash that correctly dies with the page).
  })

  it("renders the ticket catalog from the form's own fence, not a prop", async () => {
    // <RegForm /> takes no tickets prop: the options come from the island's
    // server fence importing TICKETS itself.
    const html = await page(sid)
    for (const t of ['general', 'student', 'vip']) {
      assert.ok(html.includes(`value="${t}"`))
      assert.ok(html.includes(`>${t}</option>`))
    }
  })

  it('refuses a duplicate email — committed: false, roster unchanged', async () => {
    const r = await register(sid, { name: 'Also Ada', email: 'ADA@lovelace.dev', seats: 1 })
    assert.equal(r.committed, false)
    assert.match(await page(sid), /Ada/)
  })

  it('refuses a shape-invalid registration the browser rules would also catch', async () => {
    const r = await register(sid, { name: 'X', email: 'not-an-email', seats: 0 })
    assert.equal(r.committed, false)
  })

  it('resizes a party within capacity', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]
    assert.ok(rid)
    const r = await send(sid, { type: 'SET_SEATS', id: rid, seats: 4 })
    assert.equal(r.committed, true)
  })

  it('fills to capacity, then sells out', async () => {
    // Ada holds 4 of 24; three 6-seat parties take it to 22, a 2-seat party
    // to 24, and the desk refuses everything after.
    for (let i = 0; i < 3; i++) {
      const r = await register(sid, { name: `Party ${i}`, email: `p${i}@x.dev`, seats: 6 })
      assert.equal(r.committed, true)
    }
    assert.equal((await register(sid, { name: 'Last Two', email: 'last@x.dev', seats: 2 })).committed, true)
    assert.equal((await register(sid, { name: 'Too Late', email: 'late@x.dev', seats: 1 })).committed, false)
    assert.ok((await page(sid)).includes('sold out'))
  })

  it('removing a party frees its seats', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    assert.equal((await send(sid, { type: 'REMOVE', id: rid })).committed, true)
    const r = await register(sid, { name: 'Waitlist Win', email: 'win@x.dev', seats: 1 })
    assert.equal(r.committed, true)
  })

  it('UPDATE amends the roster; onto a taken email it refuses', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    const ok = await send(sid, {
      type: 'UPDATE',
      id: rid,
      name: 'Renamed Party',
      email: 'renamed@x.dev',
      seats: 1,
      ticket: 'vip',
      updates: true,
    })
    assert.equal(ok.committed, true)
    const after = await page(sid)
    assert.ok(after.includes('Renamed Party'))
    // Checkbox pre-fill is a server-rendered `checked` attribute like any
    // other — the opt-in from the update shows on the edit page.
    const editPage = await (
      await app.fetch(
        new Request(`http://test/edit/${rid}`, { headers: { Cookie: `stator_sid=${sid}` } }),
      )
    ).text()
    assert.match(editPage, /name="updates"[^>]*checked/)
    // And the opt-OUT round trip: saving updates:false renders the box
    // UNCHECKED (boolean-absent attr semantics — the checked attribute must
    // be able to disappear).
    await send(sid, {
      type: 'UPDATE',
      id: rid,
      name: 'Renamed Party',
      email: 'renamed@x.dev',
      seats: 1,
      ticket: 'vip',
      updates: false,
    })
    const optedOut = await (
      await app.fetch(
        new Request(`http://test/edit/${rid}`, { headers: { Cookie: `stator_sid=${sid}` } }),
      )
    ).text()
    assert.doesNotMatch(optedOut, /name="updates"[^>]*checked/)
    // Amending onto ANOTHER attendee's email refuses.
    const bad = await send(sid, {
      type: 'UPDATE',
      id: rid,
      name: 'Renamed Party',
      email: 'win@x.dev', // Waitlist Win's email — taken
      seats: 1,
      ticket: 'vip',
    })
    assert.equal(bad.committed, false)
  })

  it('the edit route renders the form pre-filled by a full server render', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    const res = await app.fetch(
      new Request(`http://test/edit/${rid}`, { headers: { Cookie: `stator_sid=${sid}` } }),
    )
    assert.equal(res.status, 200)
    const editPage = await res.text()
    assert.ok(editPage.includes('Edit registration'))
    assert.match(editPage, /value="[^"]+"/) // server-rendered pre-fill
    assert.ok(editPage.includes('save changes'))
    assert.ok(editPage.includes(`rid="${rid}"`))
  })

  it('the edit route 404s for an unknown id', async () => {
    const res = await app.fetch(
      new Request('http://test/edit/nope', { headers: { Cookie: `stator_sid=${sid}` } }),
    )
    assert.equal(res.status, 404)
    assert.ok((await res.text()).includes('No such registration'))
  })

  it('UPDATE dispatched from the edit route commits', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    const res = await app.fetch(
      new Request('http://test/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': `GET /edit/${rid}`,
          Cookie: `stator_sid=${sid}`,
        },
        body: JSON.stringify({
          machine: 'DeskMachine',
          event: {
            type: 'UPDATE',
            id: rid,
            name: 'Edited By Route',
            email: 'edited-by-route@x.dev',
            seats: 1,
            ticket: 'student',
          },
        }),
      }),
    )
    assert.equal(((await res.json()) as { committed: boolean }).committed, true)
    assert.ok((await page(sid)).includes('Edited By Route'))
  })

  it('an UPDATE patches the row itself: name, ticket and seats', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    const r = await sendForPatches(sid, {
      type: 'UPDATE',
      id: rid,
      name: 'Live Row',
      email: 'live-row@x.dev',
      seats: 2,
      ticket: 'vip',
    })
    assert.equal(r.committed, true)
    const wire = JSON.stringify(r.patches)
    assert.ok(wire.includes('Live Row'), wire)
    assert.ok(wire.includes('Edit Live Row'), wire)
    assert.ok(wire.includes('live-row@x.dev'), wire)
    assert.ok(wire.includes('vip'), wire)
    assert.match(wire, /"seats"[^}]*"2"|"2"[^}]*"seats"/, wire)
  })

  it('refuses fields of the wrong type without an error', async () => {
    for (const event of [
      { type: 'REGISTER', name: 1, email: 'typed@x.dev', seats: 1, ticket: 'general' },
      { type: 'REGISTER', name: 'Typed', email: {}, seats: 1, ticket: 'general' },
      { type: 'REGISTER', name: 'Typed', email: 'typed@x.dev', seats: '1', ticket: 'general' },
      { type: 'SET_SEATS', id: {}, seats: 2 },
    ]) {
      assert.equal((await sendForPatches(sid, event)).committed, false, JSON.stringify(event))
    }
  })

  it('the roster row shows the id — the visible mapping to the edit URL', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    assert.ok(html.includes(`<code`))
    assert.ok(html.includes(`>${rid}</code>`))
    assert.ok(html.includes(`href="/edit/${rid}"`))
  })
})
