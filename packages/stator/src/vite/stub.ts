import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from 'vite'

/**
 * Identity-import stubbing: in a *browser* module graph, an import of a server
 * machine resolves to a stub carrying only `{ name }` — the one field client
 * dispatch needs (`dispatch(Cart, ev)` posts `machine.name` over the wire).
 * The machine's real module (actions, guards, whatever server-only code it
 * pulls in) never ships to the client.
 *
 * Scoping is environment-based, not syntax-based: SSR resolutions pass
 * through untouched (the server needs the real machine), and only ids that
 * resolve inside `machinesDir` are stubbed. Applied in two places:
 *   - the dev server's Vite instance (browser requests for island imports)
 *   - the production client build in `buildApp`
 *
 * The stub's name is read by importing the machine module in Node at
 * build/serve time (machine defs are side-effect-free by convention — boot
 * discovery already imports them all).
 */

const STUB_PREFIX = '\0stator-machine-stub:'

export function machineStub(opts: { machinesDir: string }): Plugin {
  const machinesDir = resolve(opts.machinesDir)
  const inMachinesDir = (abs: string): boolean =>
    abs === machinesDir || abs.startsWith(machinesDir + sep)

  let root = ''

  return {
    name: 'vite-plugin-stator-machine-stub',
    enforce: 'pre',

    configResolved(config) {
      root = config.root
    },

    resolveId(id, importer, options) {
      if (options.ssr) return null
      if (id.startsWith(STUB_PREFIX)) return id
      if (!id.startsWith('.') && !id.startsWith('/')) return null
      const importerPath = importer?.split('?')[0]
      // A `/`-prefixed id may be a filesystem path (build inputs) or a
      // vite-root-relative browser URL (dev import analysis) — try both.
      const candidates = id.startsWith('.')
        ? importerPath
          ? [resolve(dirname(importerPath), id)]
          : []
        : [resolve(id), ...(root ? [resolve(root, id.slice(1))] : [])]
      const abs = candidates.find(inMachinesDir)
      if (!abs) return null
      return STUB_PREFIX + abs
    },

    async load(id) {
      if (!id.startsWith(STUB_PREFIX)) return null
      const file = id.slice(STUB_PREFIX.length)
      let name: unknown
      try {
        const mod = (await import(pathToFileURL(file).href)) as { default?: { name?: unknown } }
        name = mod.default?.name
      } catch (err) {
        throw new Error(
          `stator: cannot stub server-machine import "${file}" for the client bundle — ` +
            `importing it in Node failed: ${(err as Error).message}`,
        )
      }
      if (typeof name !== 'string') {
        throw new Error(
          `stator: cannot stub "${file}" — it does not default-export a machine with a name. ` +
            `Only machine defs may be imported from the machines directory in client code.`,
        )
      }
      return `export default { name: ${JSON.stringify(name)} }\n`
    },
  }
}
