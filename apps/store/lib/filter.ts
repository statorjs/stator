/**
 * Catalog filtering, faceting, and pagination — pure functions of
 * (products, url query). Facet state lives in the URL (server-canonical:
 * a filter is a link, not client state), so these run inside route renders
 * and inside tests with nothing to mock.
 */
import {
  type CategoryKey,
  COLORWAYS_ORDER,
  MATERIALS,
  type MaterialKey,
  type Product,
} from './catalog-data.ts'

export const PAGE_SIZE = 8

export interface CatalogQuery {
  material?: MaterialKey
  color?: string
  size?: string
  page: number
}

export function parseCatalogQuery(query: Record<string, string | undefined>): CatalogQuery {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1)
  return {
    material: query.material as MaterialKey | undefined,
    color: query.color,
    size: query.size,
    page,
  }
}

export function filterProducts(
  products: readonly Product[],
  category: CategoryKey | undefined,
  q: CatalogQuery,
): Product[] {
  return products.filter((p) => {
    if (category && p.category !== category) return false
    if (q.material && !p.materials.includes(q.material)) return false
    if (q.color && !(p.colorways as readonly string[]).includes(q.color)) return false
    if (q.size && !p.sizes.includes(q.size)) return false
    return true
  })
}

export interface Page<T> {
  items: T[]
  page: number
  pages: number
  total: number
}

export function paginate<T>(items: readonly T[], page: number, perPage = PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / perPage))
  const current = Math.min(page, pages)
  return {
    items: items.slice((current - 1) * perPage, current * perPage),
    page: current,
    pages,
    total: items.length,
  }
}

export interface FacetOption {
  value: string
  label: string
  count: number
}

/** Facet options with counts, computed against the OTHER active facets so
 *  each group shows what selecting it would leave. */
export function facetOptions(
  products: readonly Product[],
  category: CategoryKey | undefined,
  q: CatalogQuery,
): { materials: FacetOption[]; colors: FacetOption[]; sizes: FacetOption[] } {
  const count = (omit: keyof CatalogQuery, pred: (p: Product) => boolean): number =>
    filterProducts(products, category, { ...q, [omit]: undefined }).filter(pred).length

  const materials = (Object.keys(MATERIALS) as MaterialKey[])
    .map((m) => ({
      value: m,
      label: MATERIALS[m],
      count: count('material', (p) => p.materials.includes(m)),
    }))
    .filter((o) => o.count > 0)

  const colors = COLORWAYS_ORDER.map((c) => ({
    value: c.value,
    label: c.label,
    count: count('color', (p) => (p.colorways as readonly string[]).includes(c.value)),
  })).filter((o) => o.count > 0)

  const sizeSet = new Map<string, number>()
  for (const p of filterProducts(products, category, { ...q, size: undefined })) {
    for (const s of p.sizes) sizeSet.set(s, (sizeSet.get(s) ?? 0) + 1)
  }
  const sizes = [...sizeSet.entries()].map(([value, count]) => ({ value, label: value, count }))

  return { materials, colors, sizes }
}

/** Link builder: current query with overrides; null clears a key. */
export function catalogHref(
  base: string,
  q: CatalogQuery,
  overrides: Partial<Record<'material' | 'color' | 'size' | 'page', string | number | null>>,
): string {
  const merged: Record<string, string | number | undefined | null> = {
    material: q.material,
    color: q.color,
    size: q.size,
    page: q.page > 1 ? q.page : undefined,
    ...overrides,
  }
  // Changing any facet resets pagination unless page was explicitly set.
  if (!('page' in overrides)) merged.page = undefined
  const params = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return params.length > 0 ? `${base}?${params.join('&')}` : base
}
