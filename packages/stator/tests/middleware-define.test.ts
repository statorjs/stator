import type { MiddlewareHandler } from 'hono'
import { describe, expect, it } from 'vitest'
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
    expect(def.handlers).toEqual([noop])
    expect(def.withDefaults).toBe(true)
    expect(isMiddlewareDefinition(def)).toBe(true)
  })

  it('dangerouslyDefineMiddleware keeps handlers and skips the defaults', () => {
    const def = dangerouslyDefineMiddleware([noop])
    expect(def.handlers).toEqual([noop])
    expect(def.withDefaults).toBe(false)
    expect(isMiddlewareDefinition(def)).toBe(true)
  })

  it('isMiddlewareDefinition rejects arbitrary values (including look-alikes)', () => {
    expect(isMiddlewareDefinition({})).toBe(false)
    expect(isMiddlewareDefinition(null)).toBe(false)
    expect(isMiddlewareDefinition([noop])).toBe(false)
    // A plain object with the right fields but no brand is not a definition.
    expect(isMiddlewareDefinition({ handlers: [], withDefaults: true })).toBe(false)
  })

  it('brands via the global symbol registry (survives a duplicated module)', () => {
    const def = defineMiddleware([])
    const brand = Symbol.for('stator.middleware.definition')
    expect((def as unknown as Record<symbol, unknown>)[brand]).toBe(true)
  })
})
