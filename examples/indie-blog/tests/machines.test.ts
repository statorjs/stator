import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
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
    assert.deepStrictEqual(Object.keys(actor.getSnapshot().context.verifying), ['m1'])
    actor.send({
      type: 'VERIFIED',
      id: 'm1',
      kind: 'reply',
      authorName: 'Marisol',
      authorUrl: null,
      excerpt: 'good post',
    })
    const ctx = actor.getSnapshot().context
    assert.deepStrictEqual(ctx.verifying, {})
    assert.partialDeepStrictEqual(ctx.mentions[0], { id: 'm1', kind: 'reply', status: 'pending' })
  })

  it('dedupes a re-sent source+target pair', () => {
    const actor = createActor(MentionsMachine).start()
    actor.send(receive('m1', 1))
    actor.send({ ...receive('m2', 1) }) // same source+target, new id
    assert.deepStrictEqual(Object.keys(actor.getSnapshot().context.verifying), ['m1'])
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
    assert.equal(ctx.mentions[0]!.status, 'approved')
    assert.equal(ctx.mentions.length, 1)
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
    assert.partialDeepStrictEqual(actor.getSnapshot().context.entries[key], {
      status: 'sending',
      attempts: 1,
    })
    actor.send({ type: 'SEND_FAILED', key })
    assert.equal(actor.getSnapshot().context.entries[key]!.status, 'failed')
    // RETRY only fires on failed entries.
    actor.send({ type: 'RETRY', key })
    assert.partialDeepStrictEqual(actor.getSnapshot().context.entries[key], {
      status: 'sending',
      attempts: 2,
    })
    actor.send({ type: 'SENT', key })
    assert.equal(actor.getSnapshot().context.entries[key]!.status, 'sent')
    actor.send({ type: 'RETRY', key }) // guard drop: not failed
    assert.equal(actor.getSnapshot().context.entries[key]!.attempts, 2)
  })
})

describe('OwnerMachine', () => {
  it('LOGIN guards on the password, privileged events guard on authed', () => {
    const actor = createActor(OwnerMachine).start()
    actor.send({ type: 'APPROVE_MENTION', id: 'x' }) // unauthenticated: guard drop
    assert.equal(actor.getSnapshot().context.authed, false)
    actor.send({ type: 'LOGIN', password: 'wrong' })
    assert.equal(actor.getSnapshot().context.authed, false)
    actor.send({ type: 'LOGIN', password: 'owls-at-dusk' })
    assert.equal(actor.getSnapshot().context.authed, true)
    actor.send({ type: 'LOGOUT' })
    assert.equal(actor.getSnapshot().context.authed, false)
  })
})
