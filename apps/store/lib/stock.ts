/**
 * Stock policy + deterministic seeds. Restocks SET stock to the refill level
 * rather than adding — concurrent restock chains converge instead of
 * compounding, so the supplier simulation needs no locking.
 */
import { PRODUCTS, skuOf } from './catalog-data.ts'

export const LOW_WATER = 3
export const REFILL_LEVEL = 12
export const RESTOCK_ETA_MS = 2500

/** Small deterministic hash → stable, varied-looking seed quantities. */
function seedQty(sku: string): number {
  let h = 0
  for (let i = 0; i < sku.length; i++) h = (h * 31 + sku.charCodeAt(i)) | 0
  return 4 + (Math.abs(h) % 11) // 4..14
}

export function seedStock(): Record<string, number> {
  const stock: Record<string, number> = {}
  for (const p of PRODUCTS) {
    for (const colorway of p.colorways) {
      for (const size of p.sizes) {
        stock[skuOf(p.slug, colorway, size)] = seedQty(skuOf(p.slug, colorway, size))
      }
    }
  }
  // The seeded story: the flagship in Kelp/42 starts one sale from low water.
  stock[skuOf('the-longshore', 'kelp', '42')] = 2
  return stock
}

export function stockLabel(n: number | undefined): string {
  if (n === undefined) return ''
  if (n === 0) return 'Out of stock — restock underway'
  if (n <= LOW_WATER) return `Only ${n} left`
  return `In stock (${n})`
}
