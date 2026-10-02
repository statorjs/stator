import { readFile, writeFile } from 'node:fs/promises'
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
 *  it has scoped styles). Used by both `build.ts` and
 *  `scripts/compile-components.ts`. */
export async function compileComponentFile(
  file: string,
  baseDir: string,
): Promise<CompileComponentResult> {
  const source = await readFile(file, 'utf8')
  const { id: rel, kind } = sourceId(baseDir, file)
  const result = compile(source, {
    id: rel,
    kind,
    resolveRegions: regionResolverFor(file, source),
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
