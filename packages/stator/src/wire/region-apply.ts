/**
 * Comment-marker region boundaries. A reactive region (`each`/`when`/`match`/
 * `defer`) is delimited on the client by a pair of HTML comments
 * `<!--s:ID-->…<!--/s:ID-->` instead of a wrapper element, so the framework
 * injects no node into the user's authored DOM — comments are valid anywhere
 * (including in `<table>`/`<tbody>` where a `<span>` is foster-parented out) and
 * do not participate in the CSS sibling/child selector graph.
 *
 * A region is the run of nodes strictly between its two markers, sharing the
 * markers' parent. Keyed-list ops (insert/remove/move) address the region's
 * ELEMENT children by index — the same contract as the old wrapper's
 * `element.children[i]`, just counted between markers instead of inside a span.
 */

export const startTag = (id: string): string => `s:${id}`
export const endTag = (id: string): string => `/s:${id}`

/** Parse a trusted HTML fragment through a `<template>`, whose "in template"
 *  insertion mode preserves table-context children (`<tr>`, `<td>`, `<option>`)
 *  that a plain element's `innerHTML` would drop. */
export function parseFragment(html: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

/** Locate a region's marker pair by scanning comment nodes under `root`.
 *  (Prototype: linear scan. Production adds a hydration-time index keyed by id.) */
export function findRegion(root: Node, id: string): { start: Comment; end: Comment } | null {
  const s = startTag(id)
  const e = endTag(id)
  let start: Comment | null = null
  const walk = (node: Node): Comment | null => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 8 /* Comment */) {
        const data = (n as Comment).data
        if (data === s) start = n as Comment
        else if (data === e && start) return n as Comment
      }
      const found = walk(n)
      if (found) return found
    }
    return null
  }
  const end = walk(root)
  return start && end ? { start, end } : null
}

/** The i-th ELEMENT between the markers (mirrors `element.children[i]`); text
 *  and nested-region comment nodes are skipped. Null when out of range. */
export function elementAt(start: Comment, end: Comment, index: number): Element | null {
  let i = 0
  for (let n = start.nextSibling; n && n !== end; n = n.nextSibling) {
    if (n.nodeType === 1 /* Element */) {
      if (i === index) return n as Element
      i++
    }
  }
  return null
}

/** Count element children in the region. */
export function elementCount(start: Comment, end: Comment): number {
  let i = 0
  for (let n = start.nextSibling; n && n !== end; n = n.nextSibling) {
    if (n.nodeType === 1) i++
  }
  return i
}

/** Insert `html` so its (single-root) element becomes element-index `index`
 *  within the region — before the element currently there, or before the end
 *  marker when appending. */
export function insertAt(start: Comment, end: Comment, index: number, html: string): void {
  const ref = elementAt(start, end, index) ?? end
  ref.parentNode?.insertBefore(parseFragment(html), ref)
}

/** Remove the element at `index`. */
export function removeAt(start: Comment, end: Comment, index: number): void {
  elementAt(start, end, index)?.remove()
}

/** Move the element from `from` to `to`. `to` is the index in the list AFTER the
 *  removal — matching the wire contract's sequential-op replay. */
export function moveWithin(start: Comment, end: Comment, from: number, to: number): void {
  const node = elementAt(start, end, from)
  if (!node) return
  node.remove()
  const ref = elementAt(start, end, to) ?? end
  ref.parentNode?.insertBefore(node, ref)
}

/** Replace the whole region body (the `html` op) — remove everything between the
 *  markers, then insert the freshly-parsed content before the end marker. */
export function replaceRegion(start: Comment, end: Comment, html: string): void {
  for (let n = start.nextSibling; n && n !== end; ) {
    const next = n.nextSibling
    n.remove()
    n = next
  }
  end.parentNode?.insertBefore(parseFragment(html), end)
}
