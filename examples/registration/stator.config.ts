import { defineConfig } from '@statorjs/stator/config'
import { appStore, sessionStore } from '@statorjs/stator/server'

export default defineConfig({
  // Redis when REDIS_URL is set, in-memory otherwise, so dev and CI need no
  // Redis. Without it, the roster is lost when the server restarts.
  persistence: {
    // The roster: RosterMachine is an app machine with `persist: true`.
    app: appStore({ redisUrl: process.env.REDIS_URL }),
    session: sessionStore({ redisUrl: process.env.REDIS_URL }),
  },
})
