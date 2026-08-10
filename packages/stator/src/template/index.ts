export { clientShellAttrs } from './client-shell.ts'
export type { BranchResult } from './conditional.ts'
export {
  isBranchResult,
  match,
  renderBranchBody,
  when,
} from './conditional.ts'
export type { DeferArms, DeferResult } from './defer.ts'
export { defer, isDeferResult } from './defer.ts'
// The custom-directive surface (defineDirective/invoke) was removed from the
// public barrel in 2.0: it was documented but unusable from `.stator` files
// (the compiler owns the closed directive namespace), and a future custom-
// directive system would be global configuration, not per-template calls.
// The runtime pieces live on in ./directives/core.ts as internals.
export { isDirectiveInvocation } from './directives/core.ts'
export type { ClassListSpec, StyleListSpec } from './directives/list-attr.ts'
export { classList, styleList } from './directives/list-attr.ts'
export { on } from './directives/on.ts'
export type { SpreadAttrs } from './directives/spread.ts'
export { spreadAttrs } from './directives/spread.ts'
export type { EachResult } from './each.ts'
export { each, isEachResult, itemBind, renderListBody } from './each.ts'
export { html, raw } from './html.ts'
export type {
  AriaAttributes,
  ElementSpecificAttributes,
  GlobalHTMLAttributes,
  HTMLAttributes,
  Reactive,
  StatorDirectiveAttributes,
  StatorIntrinsicElements,
} from './html-attributes.ts'
export type { ReadResult } from './read.ts'
export { isReadResult, read } from './read.ts'
export type { HtmlFragment, InstanceOf } from './types.ts'
export { createHtmlFragment, isHtmlFragment } from './types.ts'
