import { defineMachine } from '@statorjs/stator/server'
import { COLORWAYS_ORDER, type ColorwayKey, type Product } from '../lib/catalog-data.ts'
import { chargeCard } from '../lib/payments.ts'
import { productForSku } from '../lib/sku.ts'
import InventoryMachine from './inventory.ts'

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
  | {
      type: 'CHARGE_APPROVED'
      receiptId: string
      amountCents: number
      summary: string
      items: Array<{ sku: string; qty: number }>
    }
  | { type: 'CHARGE_DECLINED'; reason: string }
  | { type: 'BACK' }

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

/** The context, hoisted so the shared line-op handlers below can be typed
 *  with EXACTLY the machine's context — a looser structural type would
 *  become a conflicting inference candidate and collapse defineMachine's
 *  state-union inference. */
const CONTEXT = {
  lines: [] as CartLine[],
  name: '',
  email: '',
  address: '',
  port: '',
  error: '',
  lastOrder: null as LastOrder | null,
}
type CartContext = typeof CONTEXT

/**
 * Line operations shared by every pre-payment state — a shopper edits the
 * manifest from a product page or the cart at any point before SUBMIT.
 */
// Client-supplied SKUs are hostile input; this guard is the gate.
const validSku = (_ctx: CartContext, ev: { sku: string }) => productForSku(ev.sku) !== null
/** Ceiling check: current line qty + 1 must fit today's shared stock. Best-
 *  effort by design — stock is app state and can move between add and
 *  settle; SUBMIT re-checks, and the inventory clamp is the final floor. */
const canTakeOneMore = (ctx: CartContext, sku: string, stock: Record<string, number>) =>
  (ctx.lines.find((l) => l.sku === sku)?.qty ?? 0) + 1 <= (stock[sku] ?? 0)
/** Lines whose quantity exceeds current stock, display-named for the error. */
const shortages = (ctx: CartContext, stock: Record<string, number>) =>
  ctx.lines
    .filter((l) => l.qty > (stock[l.sku] ?? 0))
    .map((l) => productForSku(l.sku)?.product.name ?? l.sku)
const addLine = (ctx: CartContext, ev: { sku: string }) => {
  const line = ctx.lines.find((l) => l.sku === ev.sku)
  if (line) line.qty += 1
  else ctx.lines.push({ sku: ev.sku, qty: 1 })
}
const incLine = (ctx: CartContext, ev: { sku: string }) => {
  const line = ctx.lines.find((l) => l.sku === ev.sku)
  if (line) line.qty += 1
}
const decLine = (ctx: CartContext, ev: { sku: string }) => {
  const i = ctx.lines.findIndex((l) => l.sku === ev.sku)
  const line = ctx.lines[i]
  if (!line) return
  if (line.qty > 1) line.qty -= 1
  else ctx.lines.splice(i, 1)
}
const removeLine = (ctx: CartContext, ev: { sku: string }) => {
  const i = ctx.lines.findIndex((l) => l.sku === ev.sku)
  if (i !== -1) ctx.lines.splice(i, 1)
}
const clearLines = (ctx: CartContext) => {
  ctx.lines.length = 0
}

const CartMachineDef = defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as Events,
  reads: [InventoryMachine],
  emits: {
    orderPlaced: {
      payload: (
        _ctx,
        ev: {
          receiptId: string
          amountCents: number
          summary: string
          items: Array<{ sku: string; qty: number }>
        },
      ) => ({
        receiptId: ev.receiptId,
        amountCents: ev.amountCents,
        summary: ev.summary,
        items: ev.items,
      }),
    },
  },
  context: CONTEXT,
  initial: 'open',
  states: {
    open: {
      on: {
        ADD: {
          when: (ctx, ev, { reads }) =>
            validSku(ctx, ev) && canTakeOneMore(ctx, ev.sku, reads.InventoryMachine.stock),
          do: (ctx, ev) => addLine(ctx, ev),
        },
        INCREMENT: {
          when: (ctx, ev, { reads }) => canTakeOneMore(ctx, ev.sku, reads.InventoryMachine.stock),
          do: (ctx, ev) => incLine(ctx, ev),
        },
        DECREMENT: { do: (ctx, ev) => decLine(ctx, ev) },
        REMOVE: { do: (ctx, ev) => removeLine(ctx, ev) },
        CLEAR: { do: (ctx) => clearLines(ctx) },
        BEGIN_CHECKOUT: {
          when: (ctx) => ctx.lines.length > 0,
          to: 'contact',
        },
      },
    },
    contact: {
      on: {
        ADD: {
          when: (ctx, ev, { reads }) =>
            validSku(ctx, ev) && canTakeOneMore(ctx, ev.sku, reads.InventoryMachine.stock),
          do: (ctx, ev) => addLine(ctx, ev),
        },
        INCREMENT: {
          when: (ctx, ev, { reads }) => canTakeOneMore(ctx, ev.sku, reads.InventoryMachine.stock),
          do: (ctx, ev) => incLine(ctx, ev),
        },
        DECREMENT: { do: (ctx, ev) => decLine(ctx, ev) },
        REMOVE: { do: (ctx, ev) => removeLine(ctx, ev) },
        CLEAR: { do: (ctx) => clearLines(ctx) },
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
        ADD: {
          when: (ctx, ev, { reads }) =>
            validSku(ctx, ev) && canTakeOneMore(ctx, ev.sku, reads.InventoryMachine.stock),
          do: (ctx, ev) => addLine(ctx, ev),
        },
        INCREMENT: {
          when: (ctx, ev, { reads }) => canTakeOneMore(ctx, ev.sku, reads.InventoryMachine.stock),
          do: (ctx, ev) => incLine(ctx, ev),
        },
        DECREMENT: { do: (ctx, ev) => decLine(ctx, ev) },
        REMOVE: { do: (ctx, ev) => removeLine(ctx, ev) },
        CLEAR: { do: (ctx) => clearLines(ctx) },
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
        ADD: {
          when: (ctx, ev, { reads }) =>
            validSku(ctx, ev) && canTakeOneMore(ctx, ev.sku, reads.InventoryMachine.stock),
          do: (ctx, ev) => addLine(ctx, ev),
        },
        INCREMENT: {
          when: (ctx, ev, { reads }) => canTakeOneMore(ctx, ev.sku, reads.InventoryMachine.stock),
          do: (ctx, ev) => incLine(ctx, ev),
        },
        DECREMENT: { do: (ctx, ev) => decLine(ctx, ev) },
        REMOVE: { do: (ctx, ev) => removeLine(ctx, ev) },
        CLEAR: { do: (ctx) => clearLines(ctx) },
        SUBMIT: [
          {
            when: (ctx, _ev, { reads }) =>
              shortages(ctx, reads.InventoryMachine.stock).length === 0,
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
              const items = ctx.lines.map((l) => ({ sku: l.sku, qty: l.qty }))
              const result = await chargeCard({
                token: ev.token,
                amountCents,
                idempotencyKey: meta.effectId,
              })
              return result.ok
                ? {
                    type: 'CHARGE_APPROVED',
                    receiptId: result.receiptId,
                    amountCents,
                    summary,
                    items,
                  }
                : { type: 'CHARGE_DECLINED', reason: result.reason }
            },
          },
          {
            // Stock moved under the manifest since it was assembled — say so
            // and stay in review.
            do: (ctx, _ev, { reads }) => {
              ctx.error = `Short on stock: ${shortages(ctx, reads.InventoryMachine.stock).join(', ')}. Adjust quantities and try again.`
            },
          },
        ],
        BACK: { to: 'shipping' },
      },
    },
    submitting: {
      on: {
        CHARGE_APPROVED: {
          to: 'confirmed',
          emit: 'orderPlaced',
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
        // A shopper who keeps shopping starts the next manifest — nobody
        // returns to the receipt to press reset first.
        ADD: {
          when: (ctx, ev, { reads }) =>
            validSku(ctx, ev) && canTakeOneMore(ctx, ev.sku, reads.InventoryMachine.stock),
          to: 'open',
          do: (ctx, ev) => {
            ctx.error = ''
            ctx.lastOrder = null
            addLine(ctx, ev)
          },
        },
      },
    },
  },
  selectors: {
    count: (ctx) => ctx.lines.reduce((n, l) => n + l.qty, 0),
    /** The ADD/INCREMENT guard's verdict, projected for the UI: is this SKU
     *  maxed out against current shared stock? Reads-aware — re-diffs when
     *  inventory moves, not just when the cart does. */
    atCeiling:
      (ctx, { reads }) =>
      (sku: string) => {
        const line = ctx.lines.find((l) => l.sku === sku)
        return line !== undefined && line.qty >= (reads.InventoryMachine.stock[sku] ?? 0)
      },
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

/**
 * The other half of the cart↔inventory relationship. Inventory subscribes to
 * the cart's `orderPlaced`, but declaring that in inventory.ts would import
 * cart.ts while cart.ts imports inventory.ts for `reads:` — a module cycle
 * the loader silently resolves to `undefined`. The importing end owns the
 * wiring instead; the store still validates the emit name at construction.
 */
InventoryMachine.subscribes.push({
  from: CartMachineDef,
  event: 'orderPlaced',
  dispatch: 'ORDER_PLACED',
})

export default CartMachineDef
