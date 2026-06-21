import { describe, it, expect, afterAll } from 'vitest'
import ts from 'typescript'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { generateDts } from '../src/compiler/dts.ts'

/**
 * Proves the generated `.stator.d.ts` actually makes `tsc` type a component's
 * props: a caller passing a wrong prop type must error, a correct one must not.
 * We generate the `.d.ts`, then run the TS type-checker over a tiny caller
 * program in-memory.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cardStator = resolve(here, 'fixtures/typegen/card.stator')
const cardDts = cardStator + '.d.ts'

afterAll(async () => {
  await rm(cardDts, { force: true })
})

function typecheck(callerSource: string, extraFiles: Record<string, string>): string[] {
  const files: Record<string, string> = {
    '/caller.ts': callerSource,
    ...extraFiles,
  }
  const host: ts.CompilerHost = {
    fileExists: (f) => f in files || ts.sys.fileExists(f),
    readFile: (f) => files[f] ?? ts.sys.readFile(f),
    getSourceFile: (f, lang) => {
      const text = files[f] ?? ts.sys.readFile(f)
      return text !== undefined ? ts.createSourceFile(f, text, lang) : undefined
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  const program = ts.createProgram(['/caller.ts'], {
    noEmit: true,
    strict: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
  }, host)
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('typegen: generated .d.ts drives tsc prop checking', () => {
  it('accepts correct props and rejects a wrong prop type', async () => {
    const dts = generateDts(await readFile(cardStator, 'utf8'))!
    await writeFile(cardDts, dts)

    // The ambient HtmlFragment type the .d.ts imports.
    const ambient = `declare module '@statorjs/stator/template' {
      export interface HtmlFragment { readonly __isHtmlFragment: true }
    }`

    // Resolve the .d.ts content under the import specifier the caller uses.
    const extra = {
      '/card.stator.d.ts': dts,
      '/ambient.d.ts': ambient,
    }

    const good = typecheck(
      `/// <reference path="/ambient.d.ts" />
       import Card from '/card.stator'
       const x = Card({ title: 'Hi', count: 3 })`,
      extra,
    )
    expect(good).toEqual([])

    const bad = typecheck(
      `/// <reference path="/ambient.d.ts" />
       import Card from '/card.stator'
       const x = Card({ title: 'Hi', count: 'three' })`,
      extra,
    )
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.join('\n')).toMatch(/count|string|number/)
  })
})
