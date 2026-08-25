import { defineApiRoute } from '@statorjs/stator/server'

// Native-dev fixture: reports where this module actually runs from. The dev
// server must execute app code from the SOURCE tree, so `import.meta.url`-
// relative paths (a SQLite file, a data dir) mean the same thing as in prod.
export const GET = defineApiRoute({
  method: 'GET',
  handler: () => ({ url: import.meta.url }),
})
