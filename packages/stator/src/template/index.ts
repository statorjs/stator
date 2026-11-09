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
// The custom-directive surface (defineDirective/invoke) is not exported: the
// compiler owns the closed directive namespace, so it would be unusable from
// `.stator` files. The runtime pieces are internals in ./directives/core.ts.
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
