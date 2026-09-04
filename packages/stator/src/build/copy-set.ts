import { type Dirent, realpathSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'
import { compile, regionResolverFor } from '../compiler/index.ts'

/**
 * What `stator build` copies into `dist/` — derived from the app's own module
 * graph, not from a list of directory names.
 *
 * The build used to copy every top-level directory that wasn't on a denylist,
 * which meant runtime data (an uploads dir, a JSON cache a deploy script
 * maintains) landed in the artifact, while a root-level file a module actually
 * reads — `new URL('../app.db', import.meta.url)` — did not. Both failures come
 * from the same place: guessing at the app's shape instead of asking the code.
 *
 * So one esbuild pass walks the graph from the entry points the FRAMEWORK
 * itself loads — the route and machine files, plus the root single-file hooks —
 * and everything else is copied because it was reached. `templates/`, `lib/`,
 * `components/` are not names this module knows; they are consequences. The
 * pass parses nothing itself: resolution is esbuild's, so tsconfig `paths`,
 * extensionless specifiers, index files and `exports` maps behave exactly as
 * they do at runtime, and `.stator` files are compiled on load so frontmatter
 * imports are in the graph like any other import.
 *
 * Copying is DIRECTORY-granular on purpose. A module's data files — a template
 * read with `readFile`, a fixture JSON — are invisible to any import graph, so
 * a reached module brings its whole top-level directory along. The cost is
 * copying a few unreferenced siblings; the alternative is a dist that is
 * missing files nothing declared.
 *
 * Nothing from `node_modules` is traced or copied. A bare specifier is recorded
 * as a direct dependency and left external, so the walk stops there and never
 * descends into a dependency's own imports — `dist/` holds no `node_modules`,
 * and the recorded list is the app's own dependency set, which is exactly what
 * a manifest should declare.
 */

/** Directories whose files are entry points, by framework convention. */
const ENTRY_DIRS = ['routes', 'machines']
/** Root-level single-file entry points. Each is optional. */
const ENTRY_FILES = [
  'middleware.ts',
  'boot.ts',
  'stator.config.ts',
  'stator.config.mts',
  'stator.config.js',
  'stator.config.mjs',
]
/** Directories the framework serves by path rather than importing. */
const SERVED_DIRS = ['static']
/** Never app source, so never worth reporting as an uncopied candidate. */
const NEVER_SOURCE = new Set(['node_modules', 'dist', 'tests', 'test', '__tests__'])

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|stator)$/
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
/** A `node_modules` path segment, either separator. Anything under one is a
 *  dependency, never app source — and a real app's `node_modules` sits INSIDE
 *  its root, so root containment alone cannot tell them apart. */
const NODE_MODULES = /[\\/]node_modules[\\/]/
const norm = (p: string): string => p.replace(/\\/g, '/')

export interface UntracedImport {
  /** App-relative file. */
  file: string
  line: number
  /** The call as written, truncated. */
  source: string
}

export interface CopySetOptions {
  /** App source root. */
  root: string
  /** Extra app-relative paths (directories or files) to copy verbatim — the
   *  escape hatch for what no import graph can see, e.g. a directory read
   *  through a runtime-built path. */
  include?: string[]
}

export interface CopySet {
  /** Top-level directories to copy whole. */
  dirs: string[]
  /** Root-level files to copy. */
  files: string[]
  /** Top-level directories present in the root that nothing reached. */
  unused: string[]
  /** Direct dependencies: the package name behind every bare specifier the
   *  app's own code reached. NOT transitive — a dependency is external, so it
   *  is never loaded and its own imports are never resolved. That is the right
   *  granularity for a generated manifest (a package manager resolves
   *  transitives from each dependency's own package.json) and for checking
   *  runtime imports against `dependencies` rather than `devDependencies`:
   *  a type-only import is elided before resolution, so it never lands here. */
  packages: string[]
  /** Reached files outside the app root — impossible to place in `dist/`. */
  external: string[]
  /** Specifiers esbuild could not resolve. Not fatal here: `stator check`
   *  typechecks the same graph and is the gate for a genuinely broken import. */
  unresolved: string[]
  /** `import()` calls no static analysis can follow. */
  untraced: UntracedImport[]
  /** App-local files the graph reached, app-relative. */
  reached: string[]
  ms: number
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  )

async function walk(dir: string, match: (f: string) => boolean): Promise<string[]> {
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full, match)))
    else if (match(full)) out.push(full)
  }
  return out
}

/**
 * Walk the app's server graph and report what `dist/` needs. Writes nothing and
 * runs no app code — `.stator` is compiled, everything else is only parsed.
 */
export async function resolveCopySet(opts: CopySetOptions): Promise<CopySet> {
  const root = resolve(opts.root)
  // esbuild reports REAL paths (on macOS /var is a symlink to /private/var), so
  // classify against the real root or every reached file looks external and
  // nothing gets copied. Same lesson as `hashMachines`.
  const realRoot = ((): string => {
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  })()
  /**
   * Is this absolute path inside the app root? `path.relative` is the only
   * correct test on Windows: paths there are case-insensitive and esbuild's
   * spelling of a drive letter need not match ours, so comparing normalized
   * strings with `startsWith` reports a perfectly good in-root file as
   * external — and across drives `relative` returns an ABSOLUTE path, which a
   * `..` check alone would miss. (win32's `relative` lowercases before
   * comparing; posix is unaffected.)
   */
  const insideRoot = (abs: string): boolean => {
    const rel = relative(realRoot, abs)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }

  const t0 = performance.now()

  const entries: string[] = []
  for (const dir of ENTRY_DIRS) entries.push(...(await walk(join(root, dir), (f) => CODE.test(f))))
  for (const name of ENTRY_FILES) {
    const p = join(root, name)
    if (await exists(p)) entries.push(p)
  }
  if (entries.length === 0) {
    throw new Error(
      `stator build: no entry points found — expected ${ENTRY_DIRS.map((d) => `${d}/`).join(' or ')} under ${root}`,
    )
  }

  const reached = new Set<string>()
  const assets = new Set<string>()
  const packages = new Set<string>()
  const external = new Set<string>()
  const unresolved = new Set<string>()
  const untraced: UntracedImport[] = []

  /**
   * The two dependencies a module carries that the bundler's own graph misses,
   * read from the SYNTAX rather than the text.
   *
   * Both used to be regex scans over raw source, which cannot tell code from
   * prose: a comment explaining why the app avoids `import(name)`, or a string
   * documenting the pattern, was picked up as a real untraceable import and
   * failed the build. Found by dogfooding, and the reason this parses. Comments
   * and string contents are simply not part of the tree.
   */
  const scan = (text: string, file: string): string => {
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      false,
      /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    /** `import.meta.url`. */
    const isImportMetaUrl = (node: ts.Node): boolean =>
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'url' &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword

    /** A specifier the bundler can follow: a string literal, or a template —
     *  esbuild glob-expands one with a fixed prefix, pulling in every match. */
    const analysable = (node: ts.Node): boolean =>
      ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)

    const visit = (node: ts.Node): void => {
      // `new URL('./x', import.meta.url)` — an asset reference no import graph
      // sees. String-literal specifiers only, the same limit as the client seam.
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'URL') {
          const [spec, meta] = node.arguments ?? []
          if (spec && ts.isStringLiteralLike(spec) && spec.text.startsWith('.')) {
            if (meta && isImportMetaUrl(meta)) assets.add(resolve(dirname(file), spec.text))
          }
        }
      }
      // `import(expr)` the bundler cannot follow. It says nothing about these,
      // so this is the only place they are caught.
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0]
        if (!arg || !analysable(arg)) {
          const start = node.getStart(sourceFile)
          untraced.push({
            file: norm(relative(realRoot, file)),
            line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
            source: `${text
              .slice(start, start + 60)
              .split('\n')[0]!
              .trim()}…`,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sourceFile, visit)
    return text
  }

  try {
    await build({
      // Unique synthetic output name per entry: a `routes/x.stator` +
      // `routes/x.ts` pair (the GET/POST route merge) otherwise collides on one
      // output path and fails the whole pass.
      entryPoints: entries.map((f) => ({
        in: f,
        out: norm(relative(root, f)).replace(/[\\/]/g, '_').replace(/\./g, '-'),
      })),
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outdir: join(root, '.stator-copy-set'), // virtual — write: false
      logLevel: 'silent',
      plugins: [
        {
          name: 'stator-copy-set',
          setup(b) {
            b.onResolve({ filter: /.*/ }, async (args) => {
              if (args.kind === 'entry-point' || args.pluginData?.resolved) return null
              if (BUILTIN.has(args.path)) return { path: args.path, external: true }

              const r = await b.resolve(args.path, {
                kind: args.kind,
                importer: args.importer,
                resolveDir: args.resolveDir,
                pluginData: { resolved: true },
              })
              if (r.errors.length > 0) {
                unresolved.add(`${args.path} (from ${norm(relative(realRoot, args.importer))})`)
                return { path: args.path, external: true }
              }
              const abs = r.path
              // Package or app file? Neither the path nor the specifier settles
              // it alone, so both are consulted. A dependency installed the
              // ordinary way lives UNDER the app root in `node_modules`, so
              // containment cannot exclude it; a dependency reached through a
              // workspace link resolves to a real path with no `node_modules`
              // segment, so the path cannot exclude it either. Meanwhile a
              // tsconfig `paths` alias looks exactly like a bare specifier and
              // is app code. So: under node_modules is always a package, and
              // outside the root a bare specifier is a package while a relative
              // one is an app file `dist` cannot contain.
              const bare = !args.path.startsWith('.') && !isAbsolute(args.path)
              const inRoot = isAbsolute(abs) && insideRoot(abs)
              if (NODE_MODULES.test(abs) || (!inRoot && bare)) {
                if (bare) {
                  packages.add(
                    args.path.startsWith('@')
                      ? args.path.split('/').slice(0, 2).join('/')
                      : args.path.split('/')[0]!,
                  )
                }
                return { path: abs, external: true }
              }
              if (!inRoot) {
                external.add(norm(abs))
                return { path: abs, external: true }
              }
              if (!CODE.test(abs)) {
                assets.add(abs) // data file: recorded, never parsed
                return { path: abs, external: true }
              }
              return { path: abs, pluginData: { resolved: true } }
            })

            b.onLoad({ filter: /\.stator$/ }, async (args) => {
              reached.add(args.path)
              const source = await readFile(args.path, 'utf8')
              const kind = /[\\/]routes[\\/].*\.stator$/.test(args.path) ? 'route' : 'component'
              const out = compile(source, {
                id: args.path,
                kind,
                resolveRegions: regionResolverFor(args.path, source),
              })
              return {
                contents: scan(out.serverCode, args.path),
                loader: 'ts',
                resolveDir: dirname(args.path),
              }
            })

            b.onLoad({ filter: CODE }, async (args) => {
              reached.add(args.path)
              const source = await readFile(args.path, 'utf8')
              return {
                contents: scan(source, args.path),
                loader: /\.(tsx|jsx)$/.test(args.path)
                  ? 'tsx'
                  : /\.(js|mjs|cjs)$/.test(args.path)
                    ? 'js'
                    : 'ts',
                resolveDir: dirname(args.path),
              }
            })
          },
        },
      ],
    })
  } catch (err) {
    const errors = (err as { errors?: Array<{ text: string }> }).errors ?? []
    throw new Error(
      `stator build: could not walk the app's module graph — ${
        errors.length > 0 ? errors.map((e) => e.text).join('; ') : (err as Error).message
      }`,
    )
  }

  const dirs = new Set<string>()
  const files = new Set<string>()
  for (const abs of [...reached, ...assets]) {
    // Assets come from the `new URL` scan rather than resolution, so they get
    // the same containment test the resolver hook applies.
    if (!insideRoot(abs)) continue
    const rel = norm(relative(realRoot, abs))
    if (rel.includes('/')) dirs.add(rel.split('/')[0]!)
    else files.add(rel)
  }
  for (const dir of SERVED_DIRS) if (await exists(join(root, dir))) dirs.add(dir)
  for (const extra of opts.include ?? []) {
    const rel = norm(extra).replace(/^\.\//, '').replace(/\/+$/, '')
    if (!(await exists(join(root, rel)))) continue
    if ((await stat(join(root, rel))).isDirectory() || !rel.includes('/')) dirs.add(rel)
    else files.add(rel)
  }

  const topLevel = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NEVER_SOURCE.has(e.name))
    .map((e) => e.name)

  return {
    dirs: [...dirs].sort(),
    files: [...files].sort(),
    unused: topLevel.filter((d) => !dirs.has(d) && d !== 'dist').sort(),
    packages: [...packages].sort(),
    external: [...external].sort(),
    unresolved: [...unresolved].sort(),
    untraced,
    reached: [...reached].map((f) => norm(relative(realRoot, f))).sort(),
    ms: Math.round(performance.now() - t0),
  }
}
