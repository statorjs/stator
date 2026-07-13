import { createUser, findUserByEmail } from './db.ts'
import { hashPassword } from './passwords.ts'

/** Seed the harbormaster so the role demo works out of the box. */
export function seedHarbormaster(): void {
  if (findUserByEmail('harbormaster@quay.test')) return
  const { salt, hash } = hashPassword('let-me-in')
  createUser({
    id: 'u-harbormaster',
    email: 'harbormaster@quay.test',
    name: 'The Harbormaster',
    pass_salt: salt,
    pass_hash: hash,
    role: 'harbormaster',
  })
}
