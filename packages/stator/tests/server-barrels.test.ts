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

  // 3.0 removed the deprecated re-export: the two tiers share no value export.
  it('/server shares no value export with /server/runtime', () => {
    assert.deepStrictEqual(
      Object.keys(runtime).filter((k) => k in server),
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
