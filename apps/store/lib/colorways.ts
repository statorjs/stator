import type { ColorwayKey } from './catalog-data.ts'

/** The harbor palette. Each colorway maps to the three plate regions —
 *  upper, sole, accent — consumed as CSS variables by the plate SVGs, which
 *  is what lets the variant island recolor a plate live. */
export interface PlateColors {
  label: string
  upper: string
  sole: string
  accent: string
  /** The swatch dot shown in pickers/facets. */
  swatch: string
}

export const COLORWAYS: Record<ColorwayKey, PlateColors> = {
  gull: { label: 'Gull', upper: '#e8e4d8', sole: '#f4f1e6', accent: '#d6d0bd', swatch: '#e8e4d8' },
  'squid-ink': {
    label: 'Squid Ink',
    upper: '#2c3038',
    sole: '#c9c4b4',
    accent: '#43474f',
    swatch: '#23262c',
  },
  kelp: { label: 'Kelp', upper: '#5c6b52', sole: '#e6e1d0', accent: '#49543f', swatch: '#5c6b52' },
  'rust-buoy': {
    label: 'Rust Buoy',
    upper: '#b4552d',
    sole: '#e6e1d0',
    accent: '#93372c',
    swatch: '#b4552d',
  },
  'harbor-fog': {
    label: 'Harbor Fog',
    upper: '#8fa3ad',
    sole: '#f4f1e6',
    accent: '#75868f',
    swatch: '#8fa3ad',
  },
  'sand-flat': {
    label: 'Sand Flat',
    upper: '#c9b490',
    sole: '#f4f1e6',
    accent: '#b09a74',
    swatch: '#c9b490',
  },
  storm: {
    label: 'Storm',
    upper: '#4a4e54',
    sole: '#c9c4b4',
    accent: '#3a3e44',
    swatch: '#4a4e54',
  },
  ensign: {
    label: 'Ensign',
    upper: '#93372c',
    sole: '#e6e1d0',
    accent: '#7a2d24',
    swatch: '#93372c',
  },
  'shoal-mix': {
    label: 'Shoal Mix',
    upper: '#c9b490',
    sole: '#8fa3ad',
    accent: '#5c6b52',
    swatch: '#c9b490',
  },
  'night-mix': {
    label: 'Night Mix',
    upper: '#2c3038',
    sole: '#4a4e54',
    accent: '#93372c',
    swatch: '#2c3038',
  },
  natural: {
    label: 'Natural',
    upper: '#d8cdb4',
    sole: '#e6e1d0',
    accent: '#b09a74',
    swatch: '#d8cdb4',
  },
}

/** Inline style carrying the plate variables for a colorway. */
export function plateStyle(key: ColorwayKey): string {
  const c = COLORWAYS[key]
  return `--plate-upper:${c.upper};--plate-sole:${c.sole};--plate-accent:${c.accent}`
}

/** String-keyed lookups for client islands, where keys arrive as DOM
 *  attributes (plain strings) rather than typed unions. */
export function colorwayOf(key: string): PlateColors | undefined {
  return (COLORWAYS as Record<string, PlateColors>)[key]
}

export function plateStyleOf(key: string): string {
  const c = colorwayOf(key)
  return c ? `--plate-upper:${c.upper};--plate-sole:${c.sole};--plate-accent:${c.accent}` : ''
}
