// `--import @statorjs/stator/test-env`: the preload `stator test` gives every
// test file. Node's runner starts each file in its own process, and this runs
// first in it.
//
// - Framework logging is silent unless LOG_LEVEL is exported: tests exercise
//   failure paths on purpose (guarded 403s, snapshot recovery) and should not
//   narrate them over the runner's output.
// - A file that needs a browser-shaped global scope says so with a line
//   `// @env happy-dom`. Only that file gets DOM globals, so a server test can
//   never pass by accident on a `typeof window` branch. happy-dom is resolved
//   from the app, an optional dev dependency there; a file that asks for it
//   without it installed fails with that instruction.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.LOG_LEVEL ??= 'silent'

const file = process.argv[1]
const wantsDom =
  !!file && existsSync(file) && /^\/\/ @env happy-dom\s*$/m.test(readFileSync(file, 'utf8'))

if (wantsDom) {
  let entry: string
  try {
    entry = createRequire(join(process.cwd(), 'package.json')).resolve('happy-dom')
  } catch {
    throw new Error(
      `${file} asks for \`// @env happy-dom\`, but happy-dom is not installed — add it as a dev dependency (pnpm add -D happy-dom).`,
    )
  }
  const { Window } = (await import(pathToFileURL(entry).href)) as typeof import('happy-dom')
  installWindow(new Window({ url: 'http://localhost/' }))
}

/** Copy a Window's properties onto globalThis, the way a DOM test
 *  environment does. Names Node already defines (Event, FormData, …) are
 *  replaced where a DOM test expects the window's own. */
function installWindow(win: object): void {
  const w = win as Record<string, unknown>
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const bind = (key: string, value: unknown) =>
    typeof value === 'function' && /^[a-z]/.test(key)
      ? (value as (...a: unknown[]) => unknown).bind(win)
      : value
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
  for (const key of Object.getOwnPropertyNames(win)) {
    if (skip.has(key) || key in globalThis) continue
    define(key, bind(key, w[key]))
  }
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
    if (w[key] !== undefined) define(key, bind(key, w[key]))
  }
  define('window', win)
  define('self', win)
}
