/**
 * Ambient type for `.stator` single-file components, for this app's TypeScript
 * project, used until `stator check` or `stator dev` writes each component's own
 * types under `.stator/types`.
 */
declare module '*.stator' {
  import type { HtmlFragment } from '@statorjs/stator/template'

  // biome-ignore lint/suspicious/noExplicitAny: the wildcard fallback must admit every component's props — `Record<string, unknown>` would reject interfaces without index signatures
  const component: (props?: any) => HtmlFragment
  export default component
}
