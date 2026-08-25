import { defineApiRoute } from '@statorjs/stator/server'

// Native-dev fixture: reports whether Node applies sourcemaps to stack traces.
// The CLI bin opts the process in (the runtime equivalent of
// `--enable-source-maps`) so the inline maps every loader transform emits
// actually reach error stacks, in dev and `stator start` alike.
export const GET = defineApiRoute({
  method: 'GET',
  handler: () => ({ enabled: process.sourceMapsEnabled === true }),
})
