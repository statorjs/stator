import { defineMachine } from 'stator/server'

type Product = {
  id: string
  name: string
  price: number
  description: string
}

const SEED_PRODUCTS: Product[] = [
  { id: 'p1', name: 'Notebook', price: 12.0, description: 'A6, dotted, 96 pages' },
  { id: 'p2', name: 'Pen', price: 3.5, description: 'Fine tip, black ink' },
  { id: 'p3', name: 'Desk Lamp', price: 45.0, description: 'Adjustable, warm white' },
  { id: 'p4', name: 'Coffee Mug', price: 14.0, description: 'Ceramic, 12 oz' },
]

export default defineMachine({
  name: 'ProductsMachine',
  lifecycle: 'app',
  reads: [],
  emits: [],

  context: { products: SEED_PRODUCTS },
  initial: 'ready',
  states: { ready: {} },

  selectors: {
    all: (ctx) => ctx.products,
    byId: (ctx) => (id: string) => ctx.products.find((p) => p.id === id),
  },
})
