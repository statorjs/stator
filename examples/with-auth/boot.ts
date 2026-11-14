import { defineBoot } from '@statorjs/stator/server'
import { seedHarbormaster } from './lib/seed.ts'

/** Runs once when the server starts serving: makes sure the harbormaster
 *  account the README signs in with exists. */
export default defineBoot(() => {
  seedHarbormaster()
})
