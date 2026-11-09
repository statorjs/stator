#!/usr/bin/env node
// The `stator` CLI entry (bin). Plain JS so it runs on any Node the framework
// supports; it registers a small esbuild TS loader (see loader.js) so the rest
// of the CLI — and the framework API it drives — can be authored in TypeScript
// without a `tsx` dependency.
//
// The package declares `engines: { node: ">=24" }`: Node's own test
// runner, assertion APIs and TypeScript stripping are what `stator test` and
// the native dev loop stand on. The check below stays as a clear message for
// a Node too old to have `module.register` at all.
import nodeModule from 'node:module'

const register = nodeModule?.register
if (typeof register !== 'function') {
  process.stderr.write(
    `stator: the CLI requires module.register — Node 18.19+ or 20.6+ (found ${process.version}).\n` +
      `The framework runtime itself has no such requirement.\n`,
  )
  process.exit(1)
}

// The loader and source maps — the same registration `--import
// @statorjs/stator/register` gives a process the CLI doesn't start. Source
// maps: every transform in the owned pipeline (the TS loader, the dev
// loader's `.stator` compile) already EMITS an inline map, but V8 ignores
// maps when capturing stacks unless the process opts in — the runtime
// equivalent of `--enable-source-maps`, which a bin script can't put on its
// own invocation. (`.stator` traces resolve to the compiled server module —
// right file, generated lines — until the compiler emits its own map.)
await import('../register.js')

// The real CLI is TypeScript, transformed on import by the loader just registered.
await import('./run.ts')
