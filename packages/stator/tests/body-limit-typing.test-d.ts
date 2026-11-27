// Type-level tests: `maxBodyBytes` on defineApiRoute. It is a command-route
// field; a data GET has no body. Checked by `tsc --noEmit`; run via the
// package `typecheck` script.
import { defineApiRoute } from '../src/server/index.ts'

defineApiRoute({ maxBodyBytes: 1024, handler: () => ({}) })
defineApiRoute({ maxBodyBytes: Infinity, handler: () => ({}) })
// @ts-expect-error No overload matches this call
defineApiRoute({ method: 'GET', maxBodyBytes: 1024, handler: () => ({}) })
