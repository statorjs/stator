import { defineMachine } from '@statorjs/stator/server'
import { COLORWAYS_ORDER, type ColorwayKey, type Product } from '../lib/catalog-data.ts'
import { productForSku } from '../lib/sku.ts'

type Events =
  | { type: 'ADD'; sku: string }
  | { type: 'INCREMENT'; sku: string }
  | { type: 'DECREMENT'; sku: string }
  | { type: 'REMOVE'; sku: string }
  | { type: 'CLEAR' }

interface CartLine {
  sku: string
  qty: number
}

/** A line as the cart page renders it — product facts derived from the SKU
 *  at selector time, so context stays a lean `{sku, qty}[]`. */
export interface CartDisplayLine {
  sku: string
  qty: number
  slug: string
  name: string
  silhouette: Product['silhouette']
  colorway: ColorwayKey
  colorwayLabel: string
  size: string
  unit: number
  lineTotal: number
}

export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { lines: [] as CartLine[] },
  initial: 'open',
  states: {
    open: {
      on: {
        ADD: {
          // Client-supplied SKUs are hostile input; the guard is the gate.
          when: (_ctx, ev) => productForSku(ev.sku) !== null,
          do: (ctx, ev) => {
            const line = ctx.lines.find((l) => l.sku === ev.sku)
            if (line) line.qty += 1
            else ctx.lines.push({ sku: ev.sku, qty: 1 })
          },
        },
        INCREMENT: {
          when: (ctx, ev) => ctx.lines.some((l) => l.sku === ev.sku),
          do: (ctx, ev) => {
            const line = ctx.lines.find((l) => l.sku === ev.sku)
            if (line) line.qty += 1
          },
        },
        DECREMENT: {
          when: (ctx, ev) => ctx.lines.some((l) => l.sku === ev.sku),
          do: (ctx, ev) => {
            const i = ctx.lines.findIndex((l) => l.sku === ev.sku)
            const line = ctx.lines[i]
            if (!line) return
            if (line.qty > 1) line.qty -= 1
            else ctx.lines.splice(i, 1)
          },
        },
        REMOVE: {
          do: (ctx, ev) => {
            const i = ctx.lines.findIndex((l) => l.sku === ev.sku)
            if (i !== -1) ctx.lines.splice(i, 1)
          },
        },
        CLEAR: {
          do: (ctx) => {
            ctx.lines.length = 0
          },
        },
      },
    },
  },
  selectors: {
    count: (ctx) => ctx.lines.reduce((n, l) => n + l.qty, 0),
    subtotal: (ctx) =>
      ctx.lines.reduce((sum, l) => sum + l.qty * (productForSku(l.sku)?.product.price ?? 0), 0),
    display: (ctx): CartDisplayLine[] =>
      ctx.lines.flatMap((l) => {
        const hit = productForSku(l.sku)
        if (!hit) return []
        const { product, parts } = hit
        return [
          {
            sku: l.sku,
            qty: l.qty,
            slug: product.slug,
            name: product.name,
            silhouette: product.silhouette,
            colorway: parts.colorway as ColorwayKey,
            colorwayLabel:
              COLORWAYS_ORDER.find((c) => c.value === parts.colorway)?.label ?? parts.colorway,
            size: parts.size,
            unit: product.price,
            lineTotal: l.qty * product.price,
          },
        ]
      }),
  },
})
