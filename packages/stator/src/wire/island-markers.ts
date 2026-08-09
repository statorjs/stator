/**
 * Island marker formats — the compiler↔island-runtime contract, in one place
 * so codegen (compiler/lower.ts, compiler/client-emit.ts) and the runtime
 * (client/bind.ts's bindSlot, the generated querySelector calls) can't drift.
 *
 * - ELEMENT markers: `data-b="b<N>"` on an element whose on:/bind:/read()
 *   attribute wiring the island's setup() attaches. Every occurrence of a
 *   marker is wired (a marked element inside a `.map()` repeats per row).
 * - TEXT SLOT markers: an `<!--s<N>-->` comment where a client-machine
 *   `read()` sat in text position; the runtime materializes one text node
 *   after each occurrence. The comment's data IS the marker string.
 */

export const ISLAND_MARKER_ATTR = 'data-b'

export const elementMarker = (i: number): string => `b${i}`

export const slotMarker = (i: number): string => `s${i}`

/** CSS selector for every occurrence of an element marker. */
export const elementMarkerSelector = (marker: string): string =>
  `[${ISLAND_MARKER_ATTR}="${marker}"]`
