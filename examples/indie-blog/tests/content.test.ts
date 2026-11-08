import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  contentError,
  discoverKind,
  outboundLinks,
  renderContent,
  slugify,
} from '../lib/content.ts'

describe('post-type discovery', () => {
  it('named content is an article, unnamed is a note', () => {
    assert.equal(discoverKind('A Title', 'body'), 'article')
    assert.equal(discoverKind('   ', 'just a note'), 'note')
  })

  it('a photo wins over both — titled or not', () => {
    assert.equal(discoverKind('A Title', 'caption', true), 'photo')
    assert.equal(discoverKind('', 'caption', true), 'photo')
  })
})

describe('slugify', () => {
  it('lowercases, strips, and hyphenates', () => {
    assert.equal(slugify('Hello, World! This is Fine'), 'hello-world-this-is-fine')
  })
  it('never returns empty', () => {
    assert.match(slugify('!!!'), /^post-/)
  })
})

describe('renderContent', () => {
  it('splits paragraphs and escapes html', () => {
    const html = renderContent('one <b>bold</b>\n\ntwo')
    assert.equal(html, '<p>one &lt;b&gt;bold&lt;/b&gt;</p>\n<p>two</p>')
  })
  it('autolinks bare urls', () => {
    const html = renderContent('see https://example.com/a?x=1 ok')
    assert.ok(html.includes('<a href="https://example.com/a?x=1">https://example.com/a?x=1</a>'))
  })
})

describe('outboundLinks', () => {
  it('finds unique http(s) urls', () => {
    const links = outboundLinks('a https://x.dev/p b https://x.dev/p c http://y.dev')
    assert.deepStrictEqual(links, ['https://x.dev/p', 'http://y.dev'])
  })
})

describe('contentError', () => {
  it('requires content, caps length', () => {
    assert.ok(contentError('  '))
    assert.ok(contentError('x'.repeat(20_001)))
    assert.equal(contentError('fine'), null)
  })
})
