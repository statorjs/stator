import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
      assert.equal(name in runtime, true, name)
    }
  })

  // Flips to "shares no value export" in the next major, when the
  // deprecated re-export on /server is removed.
  it('every runtime export is still reachable from /server in 2.x', () => {
    assert.deepStrictEqual(
      Object.keys(runtime).filter((k) => !(k in server)),
      [],
    )
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
      assert.equal(name in server, true, name)
    }
  })
})
