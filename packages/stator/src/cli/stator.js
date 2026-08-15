#!/usr/bin/env node
// The `stator` CLI entry (bin). Plain JS so it runs on any Node the framework
// supports; it registers a small esbuild TS loader (see loader.js) so the rest
// of the CLI — and the framework API it drives — can be authored in TypeScript
// without a `tsx` dependency. As Node's native TS support stabilizes this loader
// becomes removable; the bin stays.
//
// The CLI's one hard runtime requirement is `module.register` — present on
// Node 18.19+ or 20.6+. The framework RUNTIME has no such floor, so we do NOT
// declare a package-wide `engines` — this opt-in tool self-detects instead,
// keeping the CLI a purely additive feature with no change to the package's
// node-compat contract.
import nodeModule from 'node:module'

const register = nodeModule?.register
if (typeof register !== 'function') {
  process.stderr.write(
    `stator: the CLI requires module.register — Node 18.19+ or 20.6+ (found ${process.version}).\n` +
      `The framework runtime itself has no such requirement.\n`,
  )
  process.exit(1)
}

register('./loader.js', import.meta.url)

// The real CLI is TypeScript, transformed on import by the loader just registered.
await import('./run.ts')
