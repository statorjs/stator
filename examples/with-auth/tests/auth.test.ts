import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
/**
 * The auth rules, tested without a server: LOGIN is a guarded transition
 * against the real database + real scrypt (a temp DB per run), and the
 * identity-stamping emits are asserted directly.
 */

process.env.WITH_AUTH_DB = join(mkdtempSync(join(tmpdir(), 'quay-')), 'test.db')

let AuthMachine: typeof import('../machines/auth.ts').default
let createUser: typeof import('../lib/db.ts').createUser
let hashPassword: typeof import('../lib/passwords.ts').hashPassword

before(async () => {
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
    assert.deepStrictEqual(actor.getSnapshot().value, ['anonymous'])
    assert.equal(actor.getSnapshot().context.userId, '')
  })

  it('unknown email is a guard drop', () => {
    const actor = createActor(AuthMachine).start()
    actor.send({ type: 'LOGIN', email: 'ghost@quay.test', password: 'correct horse' })
    assert.deepStrictEqual(actor.getSnapshot().value, ['anonymous'])
  })

  it('correct credentials authenticate; identity comes from the DB row', () => {
    const actor = createActor(AuthMachine).start()
    actor.send({ type: 'LOGIN', email: 'sailor@quay.test', password: 'correct horse' })
    assert.deepStrictEqual(actor.getSnapshot().value, ['authenticated'])
    assert.partialDeepStrictEqual(actor.getSnapshot().context, { userId: 'u-1', name: 'Sailor', role: 'member' })
    // the password is not in context — only identity facts persist
    assert.ok(!(JSON.stringify(actor.getSnapshot().context)).includes('correct horse'))
  })

  it('there is NO event that grants identity without credentials', () => {
    const actor = createActor(AuthMachine).start()
    // Anything a devtools user could forge must land anonymous:
    actor.send({ type: 'SET_NAME', name: 'Imposter' } as never)
    actor.send({ type: 'POST_NOTICE', title: 'spam', body: '' } as never)
    assert.deepStrictEqual(actor.getSnapshot().value, ['anonymous'])
    assert.equal(actor.getSnapshot().context.userId, '')
  })
})

describe('seed from the session claims', () => {
  const session = (claims?: unknown) => ({ id: 's1', claims: <T>() => claims as T | undefined })

  it('claims naming a real user start the session authenticated, identity from the DB row', () => {
    const seed = AuthMachine.seed!(session({ userId: 'u-1', role: 'member' }))
    assert.deepStrictEqual(seed, {
      state: 'authenticated',
      context: { userId: 'u-1', name: 'Sailor', role: 'member' },
    })
    const actor = createActor(AuthMachine)
    actor.seed(seed!.context!, seed!.state)
    actor.start()
    assert.deepStrictEqual(actor.getSnapshot().value, ['authenticated'])
    assert.equal(actor.getSnapshot().context.name, 'Sailor')
  })

  it('no claims, or claims for a user that no longer exists, start anonymous', () => {
    assert.equal(AuthMachine.seed!(session()), undefined)
    assert.equal(AuthMachine.seed!(session({ userId: 'u-gone', role: 'member' })), undefined)
  })

  it('the seed cannot be forged from a claim: role and name come from the row, not the claims', () => {
    const seed = AuthMachine.seed!(session({ userId: 'u-1', role: 'harbormaster', name: 'Admiral' }))
    assert.partialDeepStrictEqual(seed?.context, { role: 'member', name: 'Sailor' })
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
    assert.equal(emitted.length, 1)
    assert.partialDeepStrictEqual(emitted[0], { authorId: 'u-1', authorName: 'Sailor', title: 'Tide tables' })
  })

  it('MODERATE is role-guarded: members are dropped', () => {
    const actor = authedActor()
    const emitted: unknown[] = []
    actor.on('moderationRequested', (e) => emitted.push(e))
    actor.send({ type: 'MODERATE', noticeId: 'n1', action: 'remove' })
    assert.equal(emitted.length, 0)
  })
})
