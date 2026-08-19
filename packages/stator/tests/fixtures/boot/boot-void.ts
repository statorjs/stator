import { defineBoot } from '../../../src/server/boot.ts'

// Returns nothing — runBoot should yield undefined (no teardown).
export default defineBoot(() => {
  /* no long-lived work, no teardown */
})
