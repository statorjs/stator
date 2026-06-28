---
title: 2. Your first machine
description: "Define the Products and Cart machines: context, events, transitions, and selectors."
sidebar:
  order: 2
---

Desksmith has two pieces of state: the **catalog** (the same for everyone, set once) and the **cart** (one per visitor). Each is a machine.

## defineMachine, the unit of state

A machine is defined with `defineMachine` and lives in its own file under `machines/`. Start with the catalog — `machines/products.ts`:

```ts
import { defineMachine } from '@statorjs/stator/server'

export type Category = 'stationery' | 'office' | 'lifestyle'

export type Product = {
  id: string
  name: string
  price: number
  category: Category
}

const SEED_PRODUCTS: Product[] = [
  { id: 'p1', name: 'Pocket Notebook', price: 12.0, category: 'stationery' },
  { id: 'p2', name: 'Fountain Pen', price: 28.0, category: 'stationery' },
  { id: 'p5', name: 'Desk Lamp', price: 45.0, category: 'office' },
  { id: 'p9', name: 'Ceramic Mug', price: 14.0, category: 'lifestyle' },
]

export default defineMachine({
  name: 'ProductsMachine',
  lifecycle: 'app',

  context: { products: SEED_PRODUCTS },
  initial: 'ready',
  states: { ready: {} },

  selectors: {
    all: (ctx) => ctx.products,
    byId: (ctx) => (id: string) => ctx.products.find((p) => p.id === id),
    byCategory: (ctx) => (cat: Category) =>
      ctx.products.filter((p) => p.category === cat),
  },
})
```

### app vs session lifetime

`lifecycle: 'app'` means **one shared instance for the whole server** — perfect for a catalog that's the same for every visitor and never changes per session. The cart, by contrast, is `lifecycle: 'session'`: each visitor gets their own.

## Context & initial state

`context` is the machine's data. `initial` names the starting state, and `states` declares the state graph. The catalog never changes, so it has a single `ready` state with no transitions — it just holds data and exposes selectors.

## Events & transitions

The cart is where things happen. Create `machines/cart.ts`:

```ts
import { defineMachine } from '@statorjs/stator/server'
import ProductsMachine from './products.ts'

type CartItem = { productId: string; quantity: number; unitPrice: number }
type CartContext = { items: CartItem[] }

type CartEvents =
  | { type: 'ADD_ITEM'; productId: string }
  | { type: 'INCREMENT'; productId: string }
  | { type: 'DECREMENT'; productId: string }
  | { type: 'REMOVE_ITEM'; productId: string }
  | { type: 'CLEAR' }

export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as CartEvents,
  reads: [ProductsMachine],

  context: { items: [] } as CartContext,
  initial: 'idle',
  states: {
    idle: {
      on: {
        ADD_ITEM: [
          {
            when: (ctx, ev) => !ctx.items.some((i) => i.productId === ev.productId),
            do: (ctx, ev, { reads }) => {
              const product = reads.ProductsMachine.byId(ev.productId)
              if (product) {
                ctx.items.push({ productId: ev.productId, quantity: 1, unitPrice: product.price })
              }
            },
          },
          {
            do: (ctx, ev) => {
              const existing = ctx.items.find((i) => i.productId === ev.productId)
              if (existing) existing.quantity += 1
            },
          },
        ],
        INCREMENT: {
          do: (ctx, ev) => {
            const it = ctx.items.find((i) => i.productId === ev.productId)
            if (it) it.quantity += 1
          },
        },
        DECREMENT: {
          do: (ctx, ev) => {
            const it = ctx.items.find((i) => i.productId === ev.productId)
            if (it && it.quantity > 1) it.quantity -= 1
          },
        },
        REMOVE_ITEM: {
          do: (ctx, ev) => { ctx.items = ctx.items.filter((i) => i.productId !== ev.productId) },
        },
        CLEAR: { do: (ctx) => { ctx.items = [] } },
      },
    },
  },

  selectors: {
    items: (ctx) => ctx.items,
    itemCount: (ctx) => ctx.items.reduce((s, i) => s + i.quantity, 0),
    total: (ctx) => ctx.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
    contains: (ctx) => (productId: string) =>
      ctx.items.some((i) => i.productId === productId),
    isEmpty: (ctx) => ctx.items.length === 0,
  },
})
```

A few things are doing real work here:

- **`events: {} as CartEvents`** declares the typed event union. Every `send` and every transition is checked against it.
- **`do(ctx, ev)`** mutates a draft of the context. You write plain mutations; the engine clones and commits.
- **Guarded branches.** `ADD_ITEM` is an array of candidates; the first whose `when` passes wins. A first-time add pushes a new line; a repeat add bumps the quantity.
- **`reads: [ProductsMachine]`** lets the cart pull the catalog. Inside `do`, `reads.ProductsMachine.byId(...)` resolves the product so the cart can capture its price.

## Selectors

`selectors` are pure derived views over `context` — they're the surface templates will read. `itemCount` and `total` aggregate; `contains` and `isEmpty` answer questions. A selector that takes an argument (like `contains`) returns a function.

## Discovery

Both files live in `machines/`, so they're registered automatically when the server boots. You never add them to a central registry — the only place you import a machine is where you actually use it (a route's frontmatter, or another machine's `reads`).

## What you built · next

Two machines: a shared catalog and a per-session cart. They hold state but nothing renders yet. In [step 3](/tutorial/03-rendering-with-read/) we put them on screen with `read()`.
