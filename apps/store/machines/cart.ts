import { defineMachine } from '@statorjs/stator/server'
import { COLORWAYS_ORDER, type ColorwayKey, type Product } from '../lib/catalog-data.ts'
import { chargeCard } from '../lib/payments.ts'
import { productForSku } from '../lib/sku.ts'

/**
 * The cart IS the order draft, and checkout states are phases of its
 * lifecycle — one machine, so the charge effect computes its amount from its
 * own context (server-authoritative; the client never supplies a price).
 */

type Events =
  | { type: 'ADD'; sku: string }
  | { type: 'INCREMENT'; sku: string }
  | { type: 'DECREMENT'; sku: string }
  | { type: 'REMOVE'; sku: string }
  | { type: 'CLEAR' }
  | { type: 'BEGIN_CHECKOUT' }
  | { type: 'SET_CONTACT'; name: string; email: string }
  | { type: 'SET_SHIPPING'; address: string; port: string }
  | { type: 'SUBMIT'; token: string }
  | { type: 'CHARGE_APPROVED'; receiptId: string; amountCents: number; summary: string }
  | { type: 'CHARGE_DECLINED'; reason: string }
  | { type: 'BACK' }
  | { type: 'NEW_ORDER' }

interface CartLine {
  sku: string
  qty: number
}

interface LastOrder {
  receiptId: string
  amountCents: number
  summary: string
}

/** A line as pages render it — product facts derived from the SKU at
 *  selector time, so context stays a lean `{sku, qty}[]`. */
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

const subtotalOf = (lines: CartLine[]): number =>
  lines.reduce((sum, l) => sum + l.qty * (productForSku(l.sku)?.product.price ?? 0), 0)

export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: {
    lines: [] as CartLine[],
    name: '',
    email: '',
    address: '',
    port: '',
    error: '',
    lastOrder: null as LastOrder | null,
  },
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
          do: (ctx, ev) => {
            const line = ctx.lines.find((l) => l.sku === ev.sku)
            if (line) line.qty += 1
          },
        },
        DECREMENT: {
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
        BEGIN_CHECKOUT: {
          when: (ctx) => ctx.lines.length > 0,
          to: 'contact',
        },
      },
    },
    contact: {
      on: {
        SET_CONTACT: {
          when: (_ctx, ev) => ev.name.trim().length > 0 && /^\S+@\S+\.\S+$/.test(ev.email),
          do: (ctx, ev) => {
            ctx.name = ev.name.trim()
            ctx.email = ev.email.trim()
          },
          to: 'shipping',
        },
        BACK: { to: 'open' },
      },
    },
    shipping: {
      on: {
        SET_SHIPPING: {
          when: (_ctx, ev) => ev.address.trim().length > 0 && ev.port.trim().length > 0,
          do: (ctx, ev) => {
            ctx.address = ev.address.trim()
            ctx.port = ev.port.trim()
          },
          to: 'review',
        },
        BACK: { to: 'contact' },
      },
    },
    review: {
      on: {
        SUBMIT: {
          to: 'submitting',
          do: (ctx) => {
            ctx.error = ''
          },
          // The completion event carries everything the settle transitions
          // need — receipt, amount, summary — so approve can also clear the
          // manifest without losing the order record.
          effect: async (ctx, ev, meta): Promise<Events | null> => {
            const amountCents = subtotalOf(ctx.lines)
            const summary = ctx.lines
              .map((l) => `${l.qty}× ${productForSku(l.sku)?.product.name ?? l.sku}`)
              .join(', ')
            const result = await chargeCard({
              token: ev.token,
              amountCents,
              idempotencyKey: meta.effectId,
            })
            return result.ok
              ? { type: 'CHARGE_APPROVED', receiptId: result.receiptId, amountCents, summary }
              : { type: 'CHARGE_DECLINED', reason: result.reason }
          },
        },
        BACK: { to: 'shipping' },
      },
    },
    submitting: {
      on: {
        CHARGE_APPROVED: {
          to: 'confirmed',
          do: (ctx, ev) => {
            ctx.lastOrder = {
              receiptId: ev.receiptId,
              amountCents: ev.amountCents,
              summary: ev.summary,
            }
            ctx.lines.length = 0
          },
        },
        CHARGE_DECLINED: {
          to: 'review',
          do: (ctx, ev) => {
            ctx.error = ev.reason
          },
        },
      },
    },
    confirmed: {
      on: {
        NEW_ORDER: {
          to: 'open',
          do: (ctx) => {
            ctx.error = ''
            ctx.lastOrder = null
          },
        },
      },
    },
  },
  selectors: {
    count: (ctx) => ctx.lines.reduce((n, l) => n + l.qty, 0),
    subtotal: (ctx) => subtotalOf(ctx.lines),
    contact: (ctx) => ({ name: ctx.name, email: ctx.email }),
    shipping: (ctx) => ({ address: ctx.address, port: ctx.port }),
    error: (ctx) => ctx.error,
    lastOrder: (ctx) => ctx.lastOrder,
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
