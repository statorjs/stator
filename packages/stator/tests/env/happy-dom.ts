// A browser-shaped global scope, the way vitest's happy-dom environment
// provided one: a Window whose properties become globals.
import { Window } from 'happy-dom'

const win = new Window({ url: 'http://localhost/' })
const w = win as unknown as Record<string, unknown>
const skip = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
  'window',
  'self',
  'top',
  'parent',
  'global',
])
const define = (key: string, value: unknown) =>
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })

for (const key of Object.getOwnPropertyNames(win)) {
  if (skip.has(key) || key in globalThis) continue
  const value = w[key]
  define(
    key,
    typeof value === 'function' && /^[a-z]/.test(key)
      ? (value as (...a: unknown[]) => unknown).bind(win)
      : value,
  )
}
// Names Node already defines that a DOM test expects to be the window's.
for (const key of [
  'document',
  'navigator',
  'location',
  'customElements',
  'CustomEvent',
  'Event',
  'EventTarget',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'FormData',
  'DOMParser',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  const value = w[key]
  if (value !== undefined)
    define(
      key,
      typeof value === 'function' && /^[a-z]/.test(key)
        ? (value as (...a: unknown[]) => unknown).bind(win)
        : value,
    )
}
define('window', win)
define('self', win)
