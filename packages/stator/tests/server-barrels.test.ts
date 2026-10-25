import { describe, expect, it } from 'vitest'
import * as server from '../src/server/index.ts'
import * as runtime from '../src/server/runtime.ts'

/** The Stable/Toolchain split of the server is structural: two subpaths. */
describe('/server and /server/runtime', () => {
  it('the plumbing is on /server/runtime and not on /server', () => {
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
      expect(name in server, name).toBe(false)
    }
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

  it('the two barrels share no value export', () => {
    expect(Object.keys(server).filter((k) => k in runtime)).toEqual([])
  })
})
