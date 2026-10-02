#!/usr/bin/env node
// Plain-JS entry for `compile-components.ts` — mirrors `cli/stator.js`'s
// pattern: register the framework's own esbuild TS loader (no `tsx` dep),
// then import the real (TypeScript) script.
import nodeModule from 'node:module'

nodeModule.register('../src/cli/loader.js', import.meta.url)

await import('./compile-components.ts')
