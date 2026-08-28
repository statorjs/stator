import { describe, expect, it } from 'vitest'
import {
  contentError,
  discoverKind,
  outboundLinks,
  renderContent,
  slugify,
} from '../lib/content.ts'

describe('post-type discovery', () => {
  it('named content is an article, unnamed is a note', () => {
    expect(discoverKind('A Title', 'body')).toBe('article')
    expect(discoverKind('   ', 'just a note')).toBe('note')
  })

  it('a photo wins over both — titled or not', () => {
    expect(discoverKind('A Title', 'caption', true)).toBe('photo')
    expect(discoverKind('', 'caption', true)).toBe('photo')
  })
})

describe('slugify', () => {
  it('lowercases, strips, and hyphenates', () => {
    expect(slugify('Hello, World! This is Fine')).toBe('hello-world-this-is-fine')
  })
  it('never returns empty', () => {
    expect(slugify('!!!')).toMatch(/^post-/)
  })
})

describe('renderContent', () => {
  it('splits paragraphs and escapes html', () => {
    const html = renderContent('one <b>bold</b>\n\ntwo')
    expect(html).toBe('<p>one &lt;b&gt;bold&lt;/b&gt;</p>\n<p>two</p>')
  })
  it('autolinks bare urls', () => {
    const html = renderContent('see https://example.com/a?x=1 ok')
    expect(html).toContain('<a href="https://example.com/a?x=1">https://example.com/a?x=1</a>')
  })
})

describe('outboundLinks', () => {
  it('finds unique http(s) urls', () => {
    const links = outboundLinks('a https://x.dev/p b https://x.dev/p c http://y.dev')
    expect(links).toEqual(['https://x.dev/p', 'http://y.dev'])
  })
})

describe('contentError', () => {
  it('requires content, caps length', () => {
    expect(contentError('  ')).toBeTruthy()
    expect(contentError('x'.repeat(20_001))).toBeTruthy()
    expect(contentError('fine')).toBeNull()
  })
})
