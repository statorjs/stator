import { defineMachine } from '@statorjs/stator/server'

export type Category = 'stationery' | 'office' | 'lifestyle'

type Product = {
  id: string
  name: string
  price: number
  description: string
  category: Category
  /** 2-letter visual abbreviation for the placeholder card. */
  initials: string
}

const SEED_PRODUCTS: Product[] = [
  // Stationery
  {
    id: 'p1',
    name: 'Pocket Notebook',
    price: 12.0,
    description: 'A6 dotted, 96 pages, lay-flat binding.',
    category: 'stationery',
    initials: 'PN',
  },
  {
    id: 'p2',
    name: 'Fountain Pen',
    price: 28.0,
    description: 'Stainless medium nib, refillable converter, blue-black ink.',
    category: 'stationery',
    initials: 'FP',
  },
  {
    id: 'p3',
    name: 'Sticky Notes',
    price: 8.5,
    description: 'Six pastel pads, 100 sheets each, residue-free adhesive.',
    category: 'stationery',
    initials: 'SN',
  },
  {
    id: 'p4',
    name: 'Mechanical Pencil',
    price: 15.0,
    description: '0.5 mm, brass barrel, twist-eraser cap.',
    category: 'stationery',
    initials: 'MP',
  },

  // Office
  {
    id: 'p5',
    name: 'Desk Lamp',
    price: 45.0,
    description: 'Adjustable arm, dimmable, warm 2700 K LED.',
    category: 'office',
    initials: 'DL',
  },
  {
    id: 'p6',
    name: 'Monitor Stand',
    price: 52.0,
    description: 'Bamboo two-tier, 24″ wide, integrated cable channel.',
    category: 'office',
    initials: 'MS',
  },
  {
    id: 'p7',
    name: 'Cable Organizer',
    price: 18.0,
    description: 'Magnetic base, six channels, low-profile silicone.',
    category: 'office',
    initials: 'CO',
  },
  {
    id: 'p8',
    name: 'Mouse Pad',
    price: 22.0,
    description: 'Cork over cotton, oversized 18″×12″, washable.',
    category: 'office',
    initials: 'MO',
  },

  // Lifestyle
  {
    id: 'p9',
    name: 'Ceramic Mug',
    price: 14.0,
    description: '12 oz, hand-glazed slate, dishwasher safe.',
    category: 'lifestyle',
    initials: 'CM',
  },
  {
    id: 'p10',
    name: 'Stainless Bottle',
    price: 32.0,
    description: '24 oz, vacuum-insulated, keeps cold 36 h.',
    category: 'lifestyle',
    initials: 'SB',
  },
  {
    id: 'p11',
    name: 'Linen Throw',
    price: 68.0,
    description: 'Belgian linen, stonewashed charcoal, 50″×60″.',
    category: 'lifestyle',
    initials: 'LT',
  },
  {
    id: 'p12',
    name: 'Wool Slippers',
    price: 42.0,
    description: 'Felted wool, suede sole, slate heather.',
    category: 'lifestyle',
    initials: 'WS',
  },
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
    byCategory: (ctx) => (cat: Category) => ctx.products.filter((p) => p.category === cat),
  },
})
