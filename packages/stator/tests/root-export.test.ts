import { defineConfig } from '@statorjs/stator'
import { describe, expect, it } from 'vitest'

describe('root package export', () => {
  it('exposes defineConfig from the bare package name', () => {
    const config = defineConfig({ images: { dir: 'media' } })
    expect(config.images?.dir).toBe('media')
  })
})
