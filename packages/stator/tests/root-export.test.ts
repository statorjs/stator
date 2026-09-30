import { defineConfig } from '@statorjs/stator'
import { describe, expect, it } from 'vitest'

describe('root package export', () => {
  it('exposes defineConfig from the bare package name', () => {
    const config = defineConfig({ caching: { sMaxAge: 60, staleWhileRevalidate: 300 } })
    const caching = config.caching as { sMaxAge?: number; staleWhileRevalidate?: number }
    expect(caching.sMaxAge).toBe(60)
  })
})
