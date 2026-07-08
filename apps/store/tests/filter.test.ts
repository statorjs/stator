import { describe, expect, it } from 'vitest'
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
    expect(hits.map((p) => p.slug).sort()).toEqual(['skiff-knit', 'the-longshore'])

    const facets = facetOptions(PRODUCTS, 'everyday', q)
    // color counts ignore the color filter itself but respect material.
    const kelp = facets.colors.find((c) => c.value === 'kelp')
    expect(kelp?.count).toBe(2)
  })

  it('pagination clamps out-of-range pages', () => {
    const page = paginate(PRODUCTS, 99, 8)
    expect(page.page).toBe(page.pages)
    expect(page.items.length).toBeGreaterThan(0)
  })

  it('changing a facet resets pagination; toggling off clears the key', () => {
    const q = parseCatalogQuery({ material: 'cork', page: '2' })
    expect(catalogHref('/c/all', q, { color: 'kelp' })).toBe('/c/all?material=cork&color=kelp')
    expect(catalogHref('/c/all', q, { material: null })).toBe('/c/all')
  })
})
