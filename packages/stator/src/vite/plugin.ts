import type { Plugin } from 'vite'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
import { compile, type CompileResult } from '../compiler/index.ts'

/**
 * The `.stator` Vite plugin — a thin adapter over the pure compiler
 * (`@statorjs/stator/compiler`). It routes one `.stator` file to its outputs via
 * the virtual-query pattern Astro/Svelte/Vue use:
 *
 *   - `Foo.stator`                          → the server render module
 *   - `Foo.stator?stator&type=style&lang.css` → scoped CSS (Vite's CSS pipeline
 *     claims it via the `lang.css` suffix; the server module imports it so the
 *     CSS lands in the module graph for SSR head collection)
 *   - `Foo.stator?stator&type=client`        → the client `<script>` entry (3b)
 *
 * The plugin does no CSS or JSX parsing itself — that's all in the compiler.
 */

const STYLE_QUERY = 'stator&type=style&lang.css'
const CLIENT_QUERY = 'stator&type=client'

export function stator(): Plugin {
  const cache = new Map<string, CompileResult>()

  async function compileFile(file: string): Promise<CompileResult> {
    const cached = cache.get(file)
    if (cached) return cached
    const source = await readFile(file, 'utf8')
    const result = compile(source, { id: file })
    cache.set(file, result)
    return result
  }

  return {
    name: 'vite-plugin-stator',

    resolveId(id, importer) {
      if (!id.includes('.stator')) return null
      const qIdx = id.indexOf('?')
      const path = qIdx === -1 ? id : id.slice(0, qIdx)
      const query = qIdx === -1 ? '' : id.slice(qIdx)
      if (path.startsWith('.') && importer) {
        const dir = importer.replace(/\/[^/]*$/, '')
        return `${dir}/${path}${query}`
      }
      return null
    },

    async load(id) {
      if (!id.includes('.stator')) return null
      const qIdx = id.indexOf('?')
      const file = qIdx === -1 ? id : id.slice(0, qIdx)
      const query = qIdx === -1 ? '' : id.slice(qIdx + 1)
      const result = await compileFile(file)

      if (query.includes('type=style')) {
        return result.css
      }
      if (query.includes('type=client')) {
        return result.scripts.join('\n')
      }

      // Default: the server render module. Import the style virtual (if any) so
      // the scoped CSS participates in the module graph — the dev server walks
      // the graph after render to inject component CSS into <head>.
      const moduleSource = result.css
        ? `import ${JSON.stringify(file + '?' + STYLE_QUERY)}\n${result.serverCode}`
        : result.serverCode

      // The emitted module is TypeScript (type-only imports, prop annotations);
      // Vite won't run its TS transform on a `.stator` id, so strip types here.
      const transformed = await transform(moduleSource, {
        loader: 'ts',
        format: 'esm',
        sourcefile: file,
        sourcemap: true,
      })
      return { code: transformed.code, map: transformed.map }
    },

    handleHotUpdate(ctx) {
      if (!ctx.file.endsWith('.stator')) return
      cache.delete(ctx.file)
      const affected = ['', '?' + STYLE_QUERY, '?' + CLIENT_QUERY]
        .map((q) => ctx.server.moduleGraph.getModuleById(ctx.file + q))
        .filter((m): m is NonNullable<typeof m> => Boolean(m))
      return affected.length > 0 ? affected : undefined
    },
  }
}
