/**
 * The Plimsoll catalog — seed data, straight from the approved content sheet.
 * Static by design: the catalog is an app machine that resets on deploy
 * (persist: false); per-SKU stock lives in InventoryMachine instead.
 */

export type ColorwayKey =
  | 'gull'
  | 'squid-ink'
  | 'kelp'
  | 'rust-buoy'
  | 'harbor-fog'
  | 'sand-flat'
  | 'storm'
  | 'ensign'
  | 'shoal-mix'
  | 'night-mix'
  | 'natural'

export type CategoryKey = 'everyday' | 'deck' | 'weather' | 'supply'

export type MaterialKey =
  | 'sailcloth'
  | 'hemp'
  | 'cork'
  | 'rubber'
  | 'recycled-nylon'
  | 'wool'
  | 'waxed-cotton'

export interface Product {
  slug: string
  name: string
  /** Cents — avoids float money everywhere. */
  price: number
  category: CategoryKey
  materials: MaterialKey[]
  /** The signature stat, display-ready. */
  ledger: string
  blurb: string
  description: string
  silhouette:
    | 'low-top'
    | 'slip-on'
    | 'high-top'
    | 'runner'
    | 'deck'
    | 'sandal'
    | 'boot-tall'
    | 'rain-shoe'
    | 'sock'
    | 'laces'
    | 'kit'
  colorways: ColorwayKey[]
  sizes: string[]
  featured?: boolean
}

export const SHOE_SIZES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46']
export const DECK_SIZES = SHOE_SIZES.slice(2) // 38–46
export const SOCK_SIZES = ['S', 'M', 'L']
export const ONE_SIZE = ['one-size']

export const CATEGORIES: Record<CategoryKey, { title: string; lede: string }> = {
  everyday: { title: 'Everyday', lede: 'Canvas for dry land.' },
  deck: { title: 'Deck', lede: 'Grip first.' },
  weather: { title: 'Weather', lede: 'For the wet days.' },
  supply: { title: 'Supply', lede: 'Small goods.' },
}

export const MATERIALS: Record<MaterialKey, string> = {
  sailcloth: 'Sailcloth canvas',
  hemp: 'Hemp',
  cork: 'Cork',
  rubber: 'Natural rubber',
  'recycled-nylon': 'Net-recycled nylon',
  wool: 'Wool',
  'waxed-cotton': 'Waxed cotton',
}

export const PRODUCTS: Product[] = [
  // ---- Everyday ----
  {
    slug: 'the-longshore',
    name: 'The Longshore',
    price: 7800,
    category: 'everyday',
    materials: ['sailcloth', 'cork', 'rubber'],
    ledger: '62% sailcloth canvas · 18% cork · 20% natural rubber',
    blurb: 'The flagship low-top. Stitched, not glued — resoleable twice.',
    description:
      'Sailcloth canvas upper on a cork midsole and natural rubber outsole. ' +
      'Every seam is stitched rather than glued, which is why a cobbler can ' +
      'resole it twice before the uppers give out. Wears in, not out.',
    silhouette: 'low-top',
    colorways: ['gull', 'squid-ink', 'kelp', 'rust-buoy'],
    sizes: SHOE_SIZES,
    featured: true,
  },
  {
    slug: 'harbor-low',
    name: 'Harbor Low',
    price: 7200,
    category: 'everyday',
    materials: ['hemp', 'cork', 'rubber'],
    ledger: '70% hemp · 14% cork · 16% natural rubber',
    blurb: 'Laceless slip-on in tight-weave hemp. The shoe by the door.',
    description:
      'A laceless slip-on in tight-weave hemp with an elastic gore hidden in ' +
      'the throat. Cork footbed molds to you in about a week. Made for the ' +
      'stretch of day between the door and the tide chart.',
    silhouette: 'slip-on',
    colorways: ['sand-flat', 'harbor-fog', 'squid-ink'],
    sizes: SHOE_SIZES,
  },
  {
    slug: 'the-ferryman',
    name: 'The Ferryman',
    price: 8800,
    category: 'everyday',
    materials: ['sailcloth', 'cork', 'rubber'],
    ledger: '66% sailcloth canvas · 12% cork · 22% natural rubber',
    blurb: 'High-top canvas with a reinforced quarter. For standing shifts and long crossings.',
    description:
      'The Longshore’s taller sibling: a high-top with a reinforced quarter ' +
      'panel and a touch more cushion in the heel. Built for people who are ' +
      'on their feet whether or not the boat shows up.',
    silhouette: 'high-top',
    colorways: ['gull', 'storm', 'ensign'],
    sizes: SHOE_SIZES,
  },
  {
    slug: 'skiff-knit',
    name: 'Skiff Knit',
    price: 9800,
    category: 'everyday',
    materials: ['recycled-nylon', 'cork', 'rubber'],
    ledger: '58% net-recycled nylon · 22% cork · 20% natural rubber',
    blurb: 'A soft runner knit from net-recycled nylon. The one concession to going fast.',
    description:
      'The knit upper starts as retired fishing nets and ends as the softest ' +
      'thing we make. A runner’s profile on our usual cork-and-rubber ' +
      'platform — the one concession to going fast.',
    silhouette: 'runner',
    colorways: ['harbor-fog', 'kelp', 'squid-ink'],
    sizes: SHOE_SIZES,
    featured: true,
  },

  // ---- Deck ----
  {
    slug: 'ketch',
    name: 'Ketch',
    price: 9200,
    category: 'deck',
    materials: ['waxed-cotton', 'cork', 'rubber'],
    ledger: '64% waxed sailcloth · 10% cork · 26% natural rubber',
    blurb: 'A leather-free deck shoe in waxed canvas. Siped sole, salt-rinsed hardware.',
    description:
      'The classic deck shoe rebuilt without leather: waxed sailcloth that ' +
      'sheds spray, a siped natural-rubber sole that holds a wet deck, and ' +
      'hardware that has already met salt water and made peace with it.',
    silhouette: 'deck',
    colorways: ['sand-flat', 'squid-ink'],
    sizes: DECK_SIZES,
    featured: true,
  },
  {
    slug: 'the-bosun',
    name: 'The Bosun',
    price: 9600,
    category: 'deck',
    materials: ['hemp', 'cork', 'rubber'],
    ledger: '60% hemp · 16% cork · 24% natural rubber',
    blurb: 'Two-eye deck classic, hemp upper on a cork-cushioned bed. Runs true to size.',
    description:
      'A two-eye deck shoe in stiff hemp that breaks in like a good line ' +
      'stretches: once, and then it holds. Cork-cushioned bed, siped sole, ' +
      'runs true to size.',
    silhouette: 'deck',
    colorways: ['rust-buoy', 'harbor-fog'],
    sizes: DECK_SIZES,
  },
  {
    slug: 'dockhand',
    name: 'Dockhand',
    price: 6400,
    category: 'deck',
    materials: ['sailcloth', 'cork', 'rubber'],
    ledger: '30% sailcloth canvas · 44% cork · 26% natural rubber',
    blurb: 'Cork-bed sandal with a single sailcloth strap. For the walk back.',
    description:
      'One wide sailcloth strap over a deep cork bed. Not for the boat — for ' +
      'the walk back from it, and most of the summer in between.',
    silhouette: 'sandal',
    colorways: ['sand-flat', 'storm'],
    sizes: SHOE_SIZES,
  },

  // ---- Weather ----
  {
    slug: 'souwester',
    name: "Sou'wester",
    price: 11800,
    category: 'weather',
    materials: ['rubber'],
    ledger: '78% natural rubber · 22% recycled cotton lining',
    blurb: 'A proper harbor boot in natural rubber. Hose it off, hang it up.',
    description:
      'A proper harbor boot: one piece of natural rubber, a recycled cotton ' +
      'lining, and nothing that minds being hosed off at the end of the day. ' +
      'The tread is cut for slick concrete and boat ramps.',
    silhouette: 'boot-tall',
    colorways: ['squid-ink', 'kelp', 'ensign'],
    sizes: SHOE_SIZES,
    featured: true,
  },
  {
    slug: 'the-gale',
    name: 'The Gale',
    price: 14800,
    category: 'weather',
    materials: ['rubber', 'wool', 'cork'],
    ledger: '52% natural rubber · 30% wool felt · 18% cork',
    blurb: 'Wool-felt lined winter boot. It should outlast the reason you bought it.',
    description:
      'The Sou’wester’s last, lined with wool felt and floored with cork. ' +
      'The most expensive thing we make; it should outlast the reason you ' +
      'bought it.',
    silhouette: 'boot-tall',
    colorways: ['storm', 'sand-flat'],
    sizes: SHOE_SIZES,
  },
  {
    slug: 'mudlark',
    name: 'Mudlark',
    price: 8600,
    category: 'weather',
    materials: ['rubber', 'sailcloth', 'cork'],
    ledger: '55% natural rubber · 28% sailcloth canvas · 17% cork',
    blurb: 'Ankle-height rain shoe. Between a sneaker and a boot, like the shore between tides.',
    description:
      'Ankle-height, rubber below the waterline and canvas above it — ' +
      'between a sneaker and a boot the way the shore sits between tides.',
    silhouette: 'rain-shoe',
    colorways: ['kelp', 'harbor-fog', 'gull'],
    sizes: SHOE_SIZES,
  },

  // ---- Supply ----
  {
    slug: 'deck-sock',
    name: 'Deck Sock, 3-pack',
    price: 2400,
    category: 'supply',
    materials: ['wool', 'recycled-nylon'],
    ledger: '68% wool · 28% recycled nylon · 4% elastane',
    blurb: 'Wool-blend crew socks in harbor colors. Sold in mixed sets.',
    description:
      'Wool-blend crews that stay up and dry fast. Sold in mixed sets of ' +
      'three, dyed in the same vats as the shoes.',
    silhouette: 'sock',
    colorways: ['shoal-mix', 'night-mix'],
    sizes: SOCK_SIZES,
  },
  {
    slug: 'waxed-laces',
    name: 'Waxed Laces, 2 pairs',
    price: 1200,
    category: 'supply',
    materials: ['waxed-cotton'],
    ledger: '100% waxed cotton',
    blurb: 'Flat waxed-cotton laces, cut for the Longshore and Ferryman.',
    description:
      'Flat waxed-cotton laces, cut to length for the Longshore and the ' +
      'Ferryman. Two pairs, because the first one always goes at the dock.',
    silhouette: 'laces',
    colorways: ['gull', 'squid-ink', 'rust-buoy'],
    sizes: ONE_SIZE,
  },
  {
    slug: 'care-kit',
    name: 'Care Kit',
    price: 2800,
    category: 'supply',
    materials: ['cork', 'waxed-cotton'],
    ledger: 'cork brush · beeswax blend · cotton cloth',
    blurb: 'Cork brush, canvas wax, and instructions. Repair is the sustainability program.',
    description:
      'A cork-handled brush, a tin of beeswax blend, a cotton cloth, and a ' +
      'card that explains the order to use them in. Repair is the ' +
      'sustainability program.',
    silhouette: 'kit',
    colorways: ['natural'],
    sizes: ONE_SIZE,
  },
]

/** Stable SKU for a product + colorway + size. */
export function skuOf(slug: string, colorway: string, size: string): string {
  return `${slug}--${colorway}--${size}`
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

/** Colorway display order for facets/pickers (labels duplicated here so the
 *  data module stays independent of the plate-color module). */
export const COLORWAYS_ORDER: Array<{ value: ColorwayKey; label: string }> = [
  { value: 'gull', label: 'Gull' },
  { value: 'squid-ink', label: 'Squid Ink' },
  { value: 'kelp', label: 'Kelp' },
  { value: 'rust-buoy', label: 'Rust Buoy' },
  { value: 'harbor-fog', label: 'Harbor Fog' },
  { value: 'sand-flat', label: 'Sand Flat' },
  { value: 'storm', label: 'Storm' },
  { value: 'ensign', label: 'Ensign' },
  { value: 'shoal-mix', label: 'Shoal Mix' },
  { value: 'night-mix', label: 'Night Mix' },
  { value: 'natural', label: 'Natural' },
]
