import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyNodeEnv } from '../src/cli/node-env.ts'

describe('the CLI sets NODE_ENV per command', () => {
  for (const [command, expected] of [
    ['dev', 'development'],
    ['test', 'test'],
    ['build', 'production'],
    ['build:lib', 'production'],
    ['start', 'production'],
    ['check', undefined],
  ] as const) {
    it(`${command} → ${expected ?? 'unset'}`, () => {
      const env: NodeJS.ProcessEnv = {}
      applyNodeEnv(command, env)
      assert.equal(env.NODE_ENV, expected)
    })
  }

  it('keeps a value the environment already set', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'staging' }
    applyNodeEnv('start', env)
    assert.equal(env.NODE_ENV, 'staging')
  })
})
