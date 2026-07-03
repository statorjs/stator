/**
 * Ambient type for `.stator` single-file components. A `.stator` module's
 * default export is its render function — it takes the component's props and
 * returns an HtmlFragment. Consumers reference this via the package's types.
 */
declare module '*.stator' {
  import type { HtmlFragment } from '@statorjs/stator/template'

  // biome-ignore lint/suspicious/noExplicitAny: the wildcard fallback must admit every component's props — `Record<string, unknown>` would reject interfaces without index signatures
  const component: (props?: any) => HtmlFragment
  export default component
}
