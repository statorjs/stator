import { defineBoot } from '@statorjs/stator/server'
import Tally from './machines/tally.ts'

// Native-dev fixture: boot is a *source* — it feeds BUMPs into the app tally on
// a timer so the subprocess harness can prove server-originated dispatch fans
// out to a live /tally connection. Env-gated: the Vite dev-server tests share
// this fixture and assert exact tally totals, so they must not see it ticking.
export default defineBoot(({ dispatchToApp }) => {
  if (process.env.STATOR_FIXTURE_BOOT_BUMP !== '1') return
  const timer = setInterval(() => {
    void dispatchToApp(Tally, { type: 'BUMP', by: 4 })
  }, 200)
  return () => clearInterval(timer)
})
