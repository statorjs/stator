import { describe, expect, it } from 'vitest'
import { JsonLd, ldToString } from '../src/components/json-ld.ts'
import { raw } from '../src/template/html.ts'
import { isHtmlFragment } from '../src/template/types.ts'

describe('raw()', () => {
  it('wraps a trusted string as a verbatim HtmlFragment', () => {
    const f = raw('<b>hi & bye</b>')
    expect(isHtmlFragment(f)).toBe(true)
    // No escaping — the string is emitted as-is.
    expect(f.html).toBe('<b>hi & bye</b>')
  })
})

describe('ldToString', () => {
  it('adds @context to a single entity', () => {
    const s = ldToString({ '@type': 'Product', name: 'Pocket Notebook' })
    expect(JSON.parse(s)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Pocket Notebook',
    })
  })

  it('wraps an array as an @graph', () => {
    const s = ldToString([
      { '@type': 'Product', name: 'A' },
      { '@type': 'Product', name: 'B' },
    ])
    const parsed = JSON.parse(s)
    expect(parsed['@context']).toBe('https://schema.org')
    expect(parsed['@graph']).toHaveLength(2)
  })

  it('escapes HTML sequences so no </script> can break out', () => {
    const s = ldToString({ '@type': 'Thing', name: 'a</script><script>alert(1)' })
    expect(s).not.toContain('</script>')
    expect(s).toContain('&lt;/script&gt;')
  })

  it('omits null values', () => {
    const s = ldToString({ '@type': 'Thing', name: null as unknown as string })
    expect(JSON.parse(s)).toEqual({ '@context': 'https://schema.org', '@type': 'Thing' })
  })

  it('honors the space argument', () => {
    expect(ldToString({ '@type': 'Thing' }, 2)).toContain('\n')
  })
})

describe('JsonLd', () => {
  it('emits a script[type=application/ld+json] as a raw fragment', () => {
    const f = JsonLd({ json: { '@type': 'Product', name: 'Pocket Notebook' } })
    expect(isHtmlFragment(f)).toBe(true)
    expect(f.html).toMatch(/^<script type="application\/ld\+json">/)
    expect(f.html).toMatch(/<\/script>$/)
    expect(f.html).toContain('"@context":"https://schema.org"')
    expect(f.html).toContain('"name":"Pocket Notebook"')
  })

  it('keeps a hostile payload from breaking out of the script element', () => {
    const f = JsonLd({ json: { '@type': 'Thing', name: '</script><img src=x onerror=alert(1)>' } })
    // Exactly one closing tag — the real one — survives.
    expect(f.html.match(/<\/script>/g)).toHaveLength(1)
  })
})
