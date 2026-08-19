import { defineBoot } from '../../../src/server/boot.ts'
import BootCounter from './machines/counter.ts'

// Dispatches BUMP three times at boot, then returns a teardown.
export default defineBoot(async ({ dispatchToApp }) => {
  for (let i = 0; i < 3; i++) await dispatchToApp(BootCounter, { type: 'BUMP' })
  return () => {
    /* teardown — no-op for the test */
  }
})
