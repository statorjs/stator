import { defineMachine } from '@statorjs/stator/server'
import { PRODUCTS } from '../lib/catalog-data.ts'

/**
 * The catalog: one shared instance, seeded from static data, deliberately
 * NOT persisted — a deploy is the catalog's edit mechanism. Per-SKU stock
 * lives in InventoryMachine (that one persists).
 */
export default defineMachine({
  name: 'CatalogMachine',
  lifecycle: 'app',
  context: { products: PRODUCTS },
  initial: 'ready',
  states: { ready: {} },
  selectors: {
    all: (ctx) => ctx.products,
    featured: (ctx) => ctx.products.filter((p) => p.featured),
    bySlug: (ctx) => (slug: string) => ctx.products.find((p) => p.slug === slug),
  },
})
