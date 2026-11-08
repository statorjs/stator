import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PRODUCTS } from '../lib/catalog-data.ts'
import {
  catalogHref,
  facetOptions,
  filterProducts,
  paginate,
  parseCatalogQuery,
} from '../lib/filter.ts'

describe('catalog filtering', () => {
  it('facets intersect; counts are computed against the OTHER active facets', () => {
    const q = parseCatalogQuery({ material: 'cork', color: 'kelp' })
    const hits = filterProducts(PRODUCTS, 'everyday', q)
    assert.deepStrictEqual(hits.map((p) => p.slug).sort(), ['skiff-knit', 'the-longshore'])

    const facets = facetOptions(PRODUCTS, 'everyday', q)
    // color counts ignore the color filter itself but respect material.
    const kelp = facets.colors.find((c) => c.value === 'kelp')
    assert.equal(kelp?.count, 2)
  })

  it('pagination clamps out-of-range pages', () => {
    const page = paginate(PRODUCTS, 99, 8)
    assert.equal(page.page, page.pages)
    assert.ok(page.items.length > 0)
  })

  it('changing a facet resets pagination; toggling off clears the key', () => {
    const q = parseCatalogQuery({ material: 'cork', page: '2' })
    assert.equal(catalogHref('/c/all', q, { color: 'kelp' }), '/c/all?material=cork&color=kelp')
    assert.equal(catalogHref('/c/all', q, { material: null }), '/c/all')
  })
})
