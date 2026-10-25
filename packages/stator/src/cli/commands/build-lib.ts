import { relative, resolve } from 'node:path'
import { compileLibrary } from '../../build/index.ts'
import type { CliContext } from '../run.ts'

/** Compile a component library for publishing — see `compileLibrary`. The
 *  directory is the first positional (default `src`); its `index.ts` is the
 *  barrel when present, and the stylesheet lands beside it. */
export async function run(ctx: CliContext): Promise<void> {
  const dir = resolve(ctx.root, ctx.rest[0] ?? 'src')
  const r = await compileLibrary({ root: ctx.root, dir })
  const rel = (p: string) => relative(ctx.root, p).replace(/\\/g, '/')
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  process.stdout.write(
    `stator build:lib: ${plural(r.compiled, 'component')} under ${rel(dir)}/ → ${rel(r.cssOut)}: ` +
      (r.entry
        ? `${r.cssBytes} bytes reached from ${rel(r.entry)}\n`
        : `${r.cssBytes} bytes, every component (no index.ts barrel)\n`),
  )
  if (r.islands > 0) {
    process.stdout.write(
      `  note: ${plural(r.islands, 'island')} compiled, but a consuming app can't discover islands from a package yet — they stay in the app\n`,
    )
  }
}
