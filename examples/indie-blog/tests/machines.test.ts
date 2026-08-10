import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from '@statorjs/stator/machine'
import { beforeAll, describe, expect, it } from 'vitest'

process.env.INDIE_BLOG_DB = join(mkdtempSync(join(tmpdir(), 'indie-machines-')), 'test.db')

/** Machines tested the flat way: events in, state out. Verification and
 *  send effects fire against unroutable addresses here — completions are
 *  driven directly instead, which is exactly what makes the workflow
 *  auditable without a network. */

const { default: MentionsMachine } = await import('../machines/mentions.ts')
const { default: OutboxMachine } = await import('../machines/outbox.ts')
const { default: OwnerMachine } = await import('../machines/owner.ts')

const receive = (id: string, n: number) => ({
  type: 'RECEIVE' as const,
  id,
  source: `http://127.0.0.1:1/src-${n}`,
  target: `http://127.0.0.1:1/posts/hello`,
  postSlug: 'hello',
})

describe('MentionsMachine', () => {
  it('tracks a verification workflow through to a pending mention', () => {
    const actor = createActor(MentionsMachine).start()
    actor.send(receive('m1', 1))
    expect(Object.keys(actor.getSnapshot().context.verifying)).toEqual(['m1'])
    actor.send({
      type: 'VERIFIED',
      id: 'm1',
      kind: 'reply',
      authorName: 'Marisol',
      authorUrl: null,
      excerpt: 'good post',
    })
    const ctx = actor.getSnapshot().context
    expect(ctx.verifying).toEqual({})
    expect(ctx.mentions[0]).toMatchObject({ id: 'm1', kind: 'reply', status: 'pending' })
  })

  it('dedupes a re-sent source+target pair', () => {
    const actor = createActor(MentionsMachine).start()
    actor.send(receive('m1', 1))
    actor.send({ ...receive('m2', 1) }) // same source+target, new id
    expect(Object.keys(actor.getSnapshot().context.verifying)).toEqual(['m1'])
  })

  it('moderation flips status, failed verifications vanish', () => {
    const actor = createActor(MentionsMachine).start()
    actor.send(receive('m1', 1))
    actor.send(receive('m2', 2))
    actor.send({ type: 'VERIFY_FAILED', id: 'm2' })
    actor.send({
      type: 'VERIFIED',
      id: 'm1',
      kind: 'like',
      authorName: 'K',
      authorUrl: null,
      excerpt: null,
    })
    actor.send({ type: 'APPROVE', id: 'm1' })
    const ctx = actor.getSnapshot().context
    expect(ctx.mentions[0]!.status).toBe('approved')
    expect(ctx.mentions).toHaveLength(1)
  })
})

describe('OutboxMachine', () => {
  it('records a per-target workflow and its completion', () => {
    const actor = createActor(OutboxMachine).start()
    actor.send({
      type: 'QUEUE',
      postSlug: 'hello',
      sourceUrl: 'http://127.0.0.1:1/posts/hello',
      target: 'http://127.0.0.1:1/elsewhere',
    })
    const key = 'hello → http://127.0.0.1:1/elsewhere'
    expect(actor.getSnapshot().context.entries[key]).toMatchObject({
      status: 'sending',
      attempts: 1,
    })
    actor.send({ type: 'SEND_FAILED', key })
    expect(actor.getSnapshot().context.entries[key]!.status).toBe('failed')
    // RETRY only fires on failed entries.
    actor.send({ type: 'RETRY', key })
    expect(actor.getSnapshot().context.entries[key]).toMatchObject({
      status: 'sending',
      attempts: 2,
    })
    actor.send({ type: 'SENT', key })
    expect(actor.getSnapshot().context.entries[key]!.status).toBe('sent')
    actor.send({ type: 'RETRY', key }) // guard drop: not failed
    expect(actor.getSnapshot().context.entries[key]!.attempts).toBe(2)
  })
})

describe('OwnerMachine', () => {
  it('LOGIN guards on the password, privileged events guard on authed', () => {
    const actor = createActor(OwnerMachine).start()
    actor.send({ type: 'APPROVE_MENTION', id: 'x' }) // unauthenticated: guard drop
    expect(actor.getSnapshot().context.authed).toBe(false)
    actor.send({ type: 'LOGIN', password: 'wrong' })
    expect(actor.getSnapshot().context.authed).toBe(false)
    actor.send({ type: 'LOGIN', password: 'owls-at-dusk' })
    expect(actor.getSnapshot().context.authed).toBe(true)
    actor.send({ type: 'LOGOUT' })
    expect(actor.getSnapshot().context.authed).toBe(false)
  })
})
