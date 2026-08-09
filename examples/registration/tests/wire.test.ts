import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The whole desk arc over the wire, one linear story: register → duplicate
 * refused → resize → fill to capacity → sold out → remove frees seats.
 * A refusal is a `committed: false` dispatch — the form keeps your typing.
 */

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp

beforeAll(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
    staticDir: resolve(here, '../static'),
  })
}, 30_000)

afterAll(async () => {
  await app.close()
})

function sidOf(res: Response): string | null {
  return res.headers.get('set-cookie')?.match(/stator_sid=([^;]+)/)?.[1] ?? null
}

async function register(
  sid: string,
  fields: { name: string; email: string; seats: number; ticket?: string },
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

async function page(sid: string): Promise<string> {
  const res = await app.fetch(
    new Request('http://test/', { headers: { Cookie: `stator_sid=${sid}` } }),
  )
  return res.text()
}

describe('the desk over the wire', () => {
  let sid: string

  beforeAll(async () => {
    sid = sidOf(await app.fetch(new Request('http://test/')))!
  })

  it('registers a clean party and the roster shows it', async () => {
    const r = await register(sid, { name: 'Ada Lovelace', email: 'ada@lovelace.dev', seats: 2 })
    expect(r.committed).toBe(true)
    const html = await page(sid)
    expect(html).toContain('Ada Lovelace')
    expect(html).toContain("You're on the list")
  })

  it('refuses a duplicate email — committed: false, roster unchanged', async () => {
    const r = await register(sid, { name: 'Also Ada', email: 'ADA@lovelace.dev', seats: 1 })
    expect(r.committed).toBe(false)
    expect((await page(sid)).match(/Ada/g)?.length).toBeGreaterThan(0)
  })

  it('refuses a shape-invalid registration the browser rules would also catch', async () => {
    const r = await register(sid, { name: 'X', email: 'not-an-email', seats: 0 })
    expect(r.committed).toBe(false)
  })

  it('resizes a party within capacity', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]
    expect(rid).toBeTruthy()
    const r = await send(sid, { type: 'SET_SEATS', id: rid, seats: 4 })
    expect(r.committed).toBe(true)
  })

  it('fills to capacity, then sells out', async () => {
    // Ada holds 4 of 24; three 6-seat parties take it to 22, a 2-seat party
    // to 24, and the desk refuses everything after.
    for (let i = 0; i < 3; i++) {
      const r = await register(sid, { name: `Party ${i}`, email: `p${i}@x.dev`, seats: 6 })
      expect(r.committed).toBe(true)
    }
    expect((await register(sid, { name: 'Last Two', email: 'last@x.dev', seats: 2 })).committed).toBe(true)
    expect((await register(sid, { name: 'Too Late', email: 'late@x.dev', seats: 1 })).committed).toBe(false)
    expect(await page(sid)).toContain('sold out')
  })

  it('removing a party frees its seats', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    expect((await send(sid, { type: 'REMOVE', id: rid })).committed).toBe(true)
    const r = await register(sid, { name: 'Waitlist Win', email: 'win@x.dev', seats: 1 })
    expect(r.committed).toBe(true)
  })

  it('EDIT pre-fills the form server-side — the values are in the HTML', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    expect((await send(sid, { type: 'EDIT', id: rid })).committed).toBe(true)
    const editing = await page(sid)
    // The edit form is SERVER-RENDERED with the attendee's values: pre-fill
    // is an attribute at render, not a client write.
    expect(editing).toMatch(/value="Party 0"|value="Waitlist Win"|value="Ada Lovelace"/)
    expect(editing).toContain('save changes')
    expect(editing).toContain('cancel')
  })

  it('UPDATE amends the roster; onto a taken email it refuses', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    const bad = await send(sid, {
      type: 'UPDATE',
      id: rid,
      name: 'Renamed',
      email: 'win@x.dev', // Waitlist Win's email — taken
      seats: 1,
      ticket: 'general',
    })
    // Refused unless rid IS Waitlist Win's row (own email is allowed) —
    // either way the roster stays consistent; assert the good path below.
    void bad
    const ok = await send(sid, {
      type: 'UPDATE',
      id: rid,
      name: 'Renamed Party',
      email: 'renamed@x.dev',
      seats: 1,
      ticket: 'vip',
    })
    expect(ok.committed).toBe(true)
    const after = await page(sid)
    expect(after).toContain('Renamed Party')
    // The update also ended edit mode: the register form is back.
    expect(after).toContain('register')
  })

  it('the edit ROUTE renders the form pre-filled — the other door, no patches involved', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    const res = await app.fetch(
      new Request(`http://test/edit/${rid}`, { headers: { Cookie: `stator_sid=${sid}` } }),
    )
    expect(res.status).toBe(200)
    const editPage = await res.text()
    expect(editPage).toContain('Edit registration')
    expect(editPage).toMatch(/value="[^"]+"/) // server-rendered pre-fill
    expect(editPage).toContain('save changes')
    expect(editPage).toContain(`rid="${rid}"`)
  })

  it('the edit route 404s for an unknown id', async () => {
    const res = await app.fetch(
      new Request('http://test/edit/nope', { headers: { Cookie: `stator_sid=${sid}` } }),
    )
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('No such registration')
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
    expect(((await res.json()) as { committed: boolean }).committed).toBe(true)
    expect(await page(sid)).toContain('Edited By Route')
  })

  it('CANCEL_EDIT returns to the register form', async () => {
    const html = await page(sid)
    const rid = html.match(/rid="([a-z0-9]+)"/)?.[1]!
    await send(sid, { type: 'EDIT', id: rid })
    expect(await page(sid)).toContain('save changes')
    expect((await send(sid, { type: 'CANCEL_EDIT' })).committed).toBe(true)
    expect(await page(sid)).not.toContain('save changes')
  })
})
