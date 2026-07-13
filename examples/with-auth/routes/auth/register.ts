import { randomUUID } from 'node:crypto'
import { defineApiRoute } from '@statorjs/stator/server'
import { createUser, findUserByEmail } from '../../lib/db.ts'
import { hashPassword } from '../../lib/passwords.ts'
import AuthMachine from '../../machines/auth.ts'

/**
 * Registration: HASH AT THE EDGE. The plaintext password exists only in
 * this handler's scope — it is hashed before anything else touches it, and
 * what enters the database (and later the LOGIN guard) is scrypt output.
 * After creating the account we log the new user in through the same
 * guarded LOGIN as everyone else, then ROTATE the session id — the
 * fixation defense: whatever id this browser had while anonymous is now
 * worthless.
 */
export const POST = defineApiRoute({
  reads: [AuthMachine],
  handler: async (request, { dispatch, rotateSession }) => {
    const form = await request.formData()
    const email = String(form.get('email') ?? '').trim().toLowerCase()
    const name = String(form.get('name') ?? '').trim()
    const password = String(form.get('password') ?? '')

    if (!/^\S+@\S+\.\S+$/.test(email) || name === '' || password.length < 8) {
      return { directives: [{ type: 'navigate', to: '/login?error=invalid' }] }
    }
    if (findUserByEmail(email)) {
      return { directives: [{ type: 'navigate', to: '/login?error=exists' }] }
    }

    const { salt, hash } = hashPassword(password)
    createUser({ id: `u-${randomUUID()}`, email, name, pass_salt: salt, pass_hash: hash })

    await dispatch(AuthMachine, { type: 'LOGIN', email, password })
    rotateSession()
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
