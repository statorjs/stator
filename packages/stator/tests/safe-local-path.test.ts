import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { safeLocalPath } from '../src/wire/safe-url.ts'

/**
 * `safeLocalPath` is the check for "send them back where they came from".
 * The hand-rolled `target.startsWith('/')` lets through other origins.
 */
describe('safeLocalPath', () => {
  it('keeps a path on this site, query and fragment included', () => {
    for (const ok of ['/', '/profile', '/a/b?x=1&y=2#top', '/search?q=a%20b', '/@handle']) {
      assert.equal(safeLocalPath(ok), ok)
    }
  })

  it('refuses what a browser resolves to another origin', () => {
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '\\\\evil.example',
      'https://evil.example/',
      'javascript:alert(1)',
      '/a\\b',
      '/\tfoo',
      '/ foo',
      ' /foo',
      'profile',
      '',
    ]) {
      assert.equal(safeLocalPath(bad), '/', JSON.stringify(bad))
    }
  })

  it('takes the fallback for a missing value, and a fallback of your own', () => {
    assert.equal(safeLocalPath(undefined), '/')
    assert.equal(safeLocalPath(null), '/')
    assert.equal(safeLocalPath('//evil.example', '/home'), '/home')
  })
})
