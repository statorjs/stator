import { describe, expect, it } from 'vitest'
import * as server from '../src/server/index.ts'
import * as runtime from '../src/server/runtime.ts'

/** The Stable/Toolchain split of the server is structural: two subpaths. */
describe('/server and /server/runtime', () => {
  it('the plumbing is on /server/runtime', () => {
    for (const name of [
      'SessionRuntime',
      'recompute',
      'renderRoute',
      'buildHonoApp',
      'MachineStore',
      'createRenderState',
      'discoverRoutes',
      'fanOut',
      'isStatorRoute',
    ]) {
      expect(name in runtime, name).toBe(true)
    }
  })

  // Flips to "shares no value export" in the next major, when the
  // deprecated re-export on /server is removed.
  it('every runtime export is still reachable from /server in 2.x', () => {
    expect(Object.keys(runtime).filter((k) => !(k in server))).toEqual([])
  })

  it('the app surface is on /server', () => {
    for (const name of [
      'createApp',
      'defineMachine',
      'defineRoute',
      'defineApiRoute',
      'dispatchToApp',
      'activeConnectionCount',
      'probeImage',
      'sessionStore',
    ]) {
      expect(name in server, name).toBe(true)
    }
  })
})
