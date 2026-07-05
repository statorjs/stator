/**
 * SKU = `slug--colorway--size`. Parsing and validation live here because the
 * cart machine must treat client-supplied SKUs as hostile: /__events accepts
 * whatever the browser sends, so the guard — not the UI — is the gate.
 */
import { PRODUCTS, type Product } from './catalog-data.ts'

export interface SkuParts {
  slug: string
  colorway: string
  size: string
}

export function parseSku(sku: string): SkuParts | null {
  const parts = sku.split('--')
  if (parts.length !== 3) return null
  const [slug, colorway, size] = parts as [string, string, string]
  return slug && colorway && size ? { slug, colorway, size } : null
}

/** The product this SKU refers to, or null if any part doesn't exist. */
export function productForSku(sku: string): { product: Product; parts: SkuParts } | null {
  const parts = parseSku(sku)
  if (!parts) return null
  const product = PRODUCTS.find((p) => p.slug === parts.slug)
  if (!product) return null
  if (!(product.colorways as readonly string[]).includes(parts.colorway)) return null
  if (!product.sizes.includes(parts.size)) return null
  return { product, parts }
}
