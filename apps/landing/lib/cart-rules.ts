// The demo cart's rules as plain functions, shared by the server-shaped
// machine in demo-cart.ts and the hero island's client machine.

export const CATALOG = [
  { id: 'p1', name: 'Pocket Notebook', price: 12 },
  { id: 'p2', name: 'Fountain Pen', price: 28 },
  { id: 'p3', name: 'Sticky Notes', price: 8.5 },
] as const

export type ProductId = (typeof CATALOG)[number]['id']
export type CartItem = { productId: ProductId; quantity: number }

export type CartEvents =
  | { type: 'ADD'; productId: ProductId }
  | { type: 'CHECKOUT' }
  | { type: 'BACK' }

export function addItem(items: CartItem[], productId: ProductId) {
  const line = items.find((i) => i.productId === productId)
  if (line) line.quantity += 1
  else items.push({ productId, quantity: 1 })
}

export const canCheckout = (items: CartItem[]) => items.length > 0

export const countOf = (items: CartItem[]) => items.reduce((sum, i) => sum + i.quantity, 0)

export function labelFor(items: CartItem[], productId: ProductId) {
  const n = items.find((i) => i.productId === productId)?.quantity ?? 0
  return n > 0 ? `In cart · ${n}` : 'Add to cart'
}

export function itemsText(items: CartItem[]) {
  if (items.length === 0) return '[]'
  const lines = items.map((i) => `  { productId: "${i.productId}", quantity: ${i.quantity} }`)
  return `[\n${lines.join(',\n')}\n]`
}
