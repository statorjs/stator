import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MiddlewareHandler } from 'hono'
import {
  dangerouslyDefineMiddleware,
  defineMiddleware,
  isMiddlewareDefinition,
} from '../src/server/middleware.ts'

const noop: MiddlewareHandler = async (_c, next) => {
  await next()
}

describe('defineMiddleware / dangerouslyDefineMiddleware', () => {
  it('defineMiddleware keeps handlers and opts into the defaults', () => {
    const def = defineMiddleware([noop])
    assert.deepStrictEqual(def.handlers, [noop])
    assert.equal(def.withDefaults, true)
    assert.equal(isMiddlewareDefinition(def), true)
  })

  it('dangerouslyDefineMiddleware keeps handlers and skips the defaults', () => {
    const def = dangerouslyDefineMiddleware([noop])
    assert.deepStrictEqual(def.handlers, [noop])
    assert.equal(def.withDefaults, false)
    assert.equal(isMiddlewareDefinition(def), true)
  })

  it('isMiddlewareDefinition rejects arbitrary values (including look-alikes)', () => {
    assert.equal(isMiddlewareDefinition({}), false)
    assert.equal(isMiddlewareDefinition(null), false)
    assert.equal(isMiddlewareDefinition([noop]), false)
    // A plain object with the right fields but no brand is not a definition.
    assert.equal(isMiddlewareDefinition({ handlers: [], withDefaults: true }), false)
  })

  it('brands via the global symbol registry (survives a duplicated module)', () => {
    const def = defineMiddleware([])
    const brand = Symbol.for('stator.middleware.definition')
    assert.equal((def as unknown as Record<symbol, unknown>)[brand], true)
  })
})
