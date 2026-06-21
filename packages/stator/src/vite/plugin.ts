import type { Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { transform } from 'esbuild'
import {
  compile,
  CompileError,
  splitStator,
  declaredRegions,
  componentImportSpecifier,
  type CompileResult,
} from '../compiler/index.ts'

/** Build a region resolver for a file: maps a component identifier used in
 *  `file` to the named regions its imported `.stator` declares. Reads sibling
 *  files synchronously (resolution happens mid-compile). Returns null when the
 *  identifier isn't a `.stator` default import or the file can't be read. */
function regionResolverFor(file: string, source: string) {
  const { frontmatter } = splitStator(source)
  return (componentName: string): Set<string> | null => {
    const spec = componentImportSpecifier(frontmatter, componentName)
    if (!spec) return null
    const target = spec.startsWith('.') ? resolve(dirname(file), spec) : null
    if (!target) return null
    try {
      return declaredRegions(readFileSync(target, 'utf8'))
    } catch {
      return null
    }
  }
}

/** Map a `CompileError` to a Vite/Rollup-friendly error so the dev overlay and
 *  terminal show file:line:column with a code frame. */
function toViteError(err: unknown): unknown {
  if (!(err instanceof CompileError) || !err.loc) return err
  const { file, line, column, frame } = err.loc
  return Object.assign(new Error(err.message), {
    id: file,
    loc: file ? { file, line, column } : undefined,
    frame,
  })
}

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
    // routes/*.stator are route pages; everything else is a component.
    const kind = /[\\/]routes[\\/].*\.stator$/.test(file) ? 'route' : 'component'
    let result: CompileResult
    try {
      result = compile(source, {
        id: file,
        kind,
        resolveRegions: regionResolverFor(file, source),
      })
    } catch (err) {
      throw toViteError(err)
    }
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
