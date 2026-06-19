/**
 * Ambient type for `.stator` single-file components, for this app's TypeScript
 * project. (Stator apps include one of these, like Vite apps include env.d.ts.)
 */
declare module '*.stator' {
  import type { HtmlFragment } from '@statorjs/stator/template'
  const component: (props?: any) => HtmlFragment
  export default component
}
