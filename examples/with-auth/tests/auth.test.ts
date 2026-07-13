import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from '@statorjs/stator/machine'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The auth rules, tested without a server: LOGIN is a guarded transition
 * against the real database + real scrypt (a temp DB per run), and the
 * identity-stamping emits are asserted directly.
 */

process.env.WITH_AUTH_DB = join(mkdtempSync(join(tmpdir(), 'quay-')), 'test.db')

let AuthMachine: typeof import('../machines/auth.ts').default
let createUser: typeof import('../lib/db.ts').createUser
let hashPassword: typeof import('../lib/passwords.ts').hashPassword

beforeAll(async () => {
  ;({ createUser } = await import('../lib/db.ts'))
  ;({ hashPassword } = await import('../lib/passwords.ts'))
  AuthMachine = (await import('../machines/auth.ts')).default
  const { salt, hash } = hashPassword('correct horse')
  createUser({ id: 'u-1', email: 'sailor@quay.test', name: 'Sailor', pass_salt: salt, pass_hash: hash })
})

describe('login as a guarded transition', () => {
  it('wrong password is a guard drop — still anonymous', () => {
    const actor = createActor(AuthMachine).start()
    actor.send({ type: 'LOGIN', email: 'sailor@quay.test', password: 'wrong' })
    expect(actor.getSnapshot().value).toEqual(['anonymous'])
    expect(actor.getSnapshot().context.userId).toBe('')
  })

  it('unknown email is a guard drop', () => {
    const actor = createActor(AuthMachine).start()
    actor.send({ type: 'LOGIN', email: 'ghost@quay.test', password: 'correct horse' })
    expect(actor.getSnapshot().value).toEqual(['anonymous'])
  })

  it('correct credentials authenticate; identity comes from the DB row', () => {
    const actor = createActor(AuthMachine).start()
    actor.send({ type: 'LOGIN', email: 'sailor@quay.test', password: 'correct horse' })
    expect(actor.getSnapshot().value).toEqual(['authenticated'])
    expect(actor.getSnapshot().context).toMatchObject({ userId: 'u-1', name: 'Sailor', role: 'member' })
    // the password is not in context — only identity facts persist
    expect(JSON.stringify(actor.getSnapshot().context)).not.toContain('correct horse')
  })

  it('there is NO event that grants identity without credentials', () => {
    const actor = createActor(AuthMachine).start()
    // Anything a devtools user could forge must land anonymous:
    actor.send({ type: 'SET_NAME', name: 'Imposter' } as never)
    actor.send({ type: 'POST_NOTICE', title: 'spam', body: '' } as never)
    expect(actor.getSnapshot().value).toEqual(['anonymous'])
    expect(actor.getSnapshot().context.userId).toBe('')
  })
})

describe('identity-stamped emits', () => {
  function authedActor() {
    const actor = createActor(AuthMachine).start()
    actor.send({ type: 'LOGIN', email: 'sailor@quay.test', password: 'correct horse' })
    return actor
  }

  it('noticePosted carries identity from CONTEXT, not the event', () => {
    const actor = authedActor()
    const emitted: Array<Record<string, unknown>> = []
    actor.on('noticePosted', (e) => emitted.push(e))
    // even if a hostile client stuffs authorId into the event, the payload
    // selector ignores the event's identity fields entirely:
    actor.send({ type: 'POST_NOTICE', title: 'Tide tables', body: 'New moon', authorId: 'u-999' } as never)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ authorId: 'u-1', authorName: 'Sailor', title: 'Tide tables' })
  })

  it('MODERATE is role-guarded: members are dropped', () => {
    const actor = authedActor()
    const emitted: unknown[] = []
    actor.on('moderationRequested', (e) => emitted.push(e))
    actor.send({ type: 'MODERATE', noticeId: 'n1', action: 'remove' })
    expect(emitted).toHaveLength(0)
  })
})
