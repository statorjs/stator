import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, sep } from 'node:path'
import { compile, regionResolverFor } from '../compiler/index.ts'
import { sourceId } from './source-id.ts'

export interface CompileComponentResult {
  /** Path (relative to `baseDir`, `/`-separated) the compiled module carries
   *  as its identity — seeds its scope hash, labels its diagnostics. */
  rel: string
  isClient: boolean
  /** The written client-entry sibling (`${file}.client.ts`), when `isClient`. */
  clientFile?: string
}

/** Compile one `.stator` file to its sibling `.ts` (+ a sibling `.css` when
 *  it has scoped styles). Used by both `build.ts` and `compileLibrary`. */
export interface CompileComponentOptions {
  /** Prefix for the compiled id (scope hash, diagnostics) — a library passes
   *  its package name, so two packages with the same file layout never share
   *  a `data-s-<hash>`. The returned `rel` stays the plain relative path. */
  idPrefix?: string
  /** The file the compiled module's source map points at, when `file` is a
   *  copy (the app build compiles copies in `dist/`, so the map points back at
   *  the app's own source). Defaults to `file`. */
  sourcePath?: string
}

export async function compileComponentFile(
  file: string,
  baseDir: string,
  opts: CompileComponentOptions = {},
): Promise<CompileComponentResult> {
  const source = await readFile(file, 'utf8')
  const { id: rel, kind } = sourceId(baseDir, file)
  const result = compile(source, {
    id: opts.idPrefix ? `${opts.idPrefix}/${rel}` : rel,
    kind,
    resolveRegions: regionResolverFor(file, source),
    // Relative to the emitted sibling, which is where a consumer resolves it.
    sourceMap: {
      source: relative(dirname(file), opts.sourcePath ?? file)
        .split(sep)
        .join('/'),
    },
  })
  await writeFile(`${file}.ts`, result.serverCode)
  let clientFile: string | undefined
  if (result.isClient) {
    clientFile = `${file}.client.ts`
    await writeFile(clientFile, result.clientCode)
  }
  if (result.css) await writeFile(`${file}.css`, result.css)
  return { rel, isClient: result.isClient, clientFile }
}
