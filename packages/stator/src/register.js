// `--import @statorjs/stator/register`: Stator's TS loader for any process
// the `stator` CLI doesn't start — a test runner launched by an editor,
// `npx vitest`, `node scripts/x.ts`. Stator ships TypeScript source, and Node
// won't strip types inside node_modules (or, from a linked checkout, strips
// only a subset), so anything that imports Stator, or a package built on it,
// needs this loader. `stator dev`/`start`/`build` register it themselves and
// `stator test` passes it to the runner. Plain JS so Node can import it with
// no loader in place yet.
import nodeModule from 'node:module'

if (typeof nodeModule.register !== 'function') {
  throw new Error(
    `@statorjs/stator/register needs module.register — Node 18.19+ or 20.6+ (found ${process.version}).`,
  )
}

nodeModule.register('./cli/loader.js', import.meta.url)

// Every transform the loader makes emits an inline map; V8 only applies
// them to stack traces when the process opts in.
process.setSourceMapsEnabled?.(true)
