// @env happy-dom
// SPIKE (tables/region-markers): validate the comment-marker range-apply LOGIC —
// insert/remove/move/replace between markers, including a nested region. This is
// pure DOM node manipulation, which happy-dom handles faithfully; the separate
// concern of whether markers survive TABLE PARSING needs a real browser (the
// acceptance test), because happy-dom does not implement table insertion modes.
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  elementCount,
  findRegion,
  insertAt,
  moveWithin,
  removeAt,
  replaceRegion,
} from '../src/wire/region-apply.ts'

const row = (id: string) => `<tr data-id="${id}"><td>${id}</td></tr>`

/** Render a keyed list region inside a real <tbody>, delimited by comment markers
 *  (what the server will emit instead of a wrapper span). */
function setup(ids: string[]): { start: Comment; end: Comment } {
  document.body.innerHTML = `<table><tbody><!--s:list-->${ids.map(row).join('')}<!--/s:list--></tbody></table>`
  const region = findRegion(document.body, 'list')
  if (!region) throw new Error('markers not found')
  return region
}

const order = () =>
  Array.from(document.querySelectorAll('tr')).map((tr) => tr.getAttribute('data-id'))

describe('region-apply: comment-marker range ops (in a table)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('finds the marker pair and counts element children (skipping comments)', () => {
    const { start, end } = setup(['a', 'b', 'c'])
    assert.equal(elementCount(start, end), 3)
    assert.deepStrictEqual(order(), ['a', 'b', 'c'])
  })

  it('insert at an index puts the row in the right place — between markers, in <tbody>', () => {
    const { start, end } = setup(['a', 'b'])
    insertAt(start, end, 1, row('x'))
    assert.deepStrictEqual(order(), ['a', 'x', 'b'])
    insertAt(start, end, 3, row('z')) // append (index >= count)
    assert.deepStrictEqual(order(), ['a', 'x', 'b', 'z'])
    // Every row is still a child of the same <tbody> (not foster-parented out).
    const tbody = document.querySelector('tbody')!
    assert.equal(
      Array.from(tbody.querySelectorAll('tr')).every((tr) => tr.parentElement === tbody),
      true,
    )
  })

  it('remove at an index deletes exactly that row', () => {
    const { start, end } = setup(['a', 'b', 'c'])
    removeAt(start, end, 1)
    assert.deepStrictEqual(order(), ['a', 'c'])
  })

  it('move matches the wire contract (to = index after removal)', () => {
    const { start, end } = setup(['a', 'b', 'c'])
    moveWithin(start, end, 0, 2) // pull 'a' out, insert before index 2 of [b,c] → end
    assert.deepStrictEqual(order(), ['b', 'c', 'a'])
  })

  it('a filter-driven sequence of remove ops keeps the survivors in order', () => {
    const { start, end } = setup(['a', 'b', 'c', 'd', 'e'])
    // Filter to [a, c, e]: remove indices right-to-left (the server's order).
    removeAt(start, end, 3) // d
    removeAt(start, end, 1) // b
    assert.deepStrictEqual(order(), ['a', 'c', 'e'])
  })

  it('replace swaps the whole region body', () => {
    const { start, end } = setup(['a', 'b'])
    replaceRegion(start, end, row('p') + row('q') + row('r'))
    assert.deepStrictEqual(order(), ['p', 'q', 'r'])
  })

  it('nested region: outer ops address only outer rows; the inner range resolves independently', () => {
    // An each row that itself contains a when-region (markers inside the <tr>).
    document.body.innerHTML =
      `<table><tbody><!--s:outer-->` +
      `<tr data-id="a"><td><!--s:inner--><span>hi</span><!--/s:inner--></td></tr>` +
      `<tr data-id="b"><td>b</td></tr>` +
      `<!--/s:outer--></tbody></table>`
    const outer = findRegion(document.body, 'outer')!
    const inner = findRegion(document.body, 'inner')!

    // Outer counts 2 rows — the inner comment markers are not element children.
    assert.equal(elementCount(outer.start, outer.end), 2)
    // Inner range is intact and addressable.
    assert.equal(elementCount(inner.start, inner.end), 1)

    // Insert a new outer row; the inner region inside 'a' is undisturbed.
    insertAt(outer.start, outer.end, 1, row('mid'))
    assert.deepStrictEqual(order(), ['a', 'mid', 'b'])
    assert.equal(document.querySelector('[data-id="a"] span')?.textContent, 'hi')

    // Replace the inner region independently.
    replaceRegion(inner.start, inner.end, '<span>bye</span>')
    assert.equal(document.querySelector('[data-id="a"] span')?.textContent, 'bye')
  })
})
