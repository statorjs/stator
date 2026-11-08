import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defineConfig } from '@statorjs/stator'

describe('root package export', () => {
  it('exposes defineConfig from the bare package name', () => {
    const config = defineConfig({ caching: { sMaxAge: 60, staleWhileRevalidate: 300 } })
    const caching = config.caching as { sMaxAge?: number; staleWhileRevalidate?: number }
    assert.equal(caching.sMaxAge, 60)
  })
})
