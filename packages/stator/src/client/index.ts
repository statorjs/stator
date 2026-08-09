/**
 * Client authoring API for `.stator` `<script>` islands — `@statorjs/stator/client`.
 * Browser-safe (no server imports). The compiler auto-injects what a generated
 * island needs; these are also the symbols an author references directly.
 */

export { attrValue, setAttr } from '../wire/attr-value.ts'
export { bind, bindSlot, effect } from './bind.ts'
export type { DispatchResult } from './dispatch.ts'
export { dispatch } from './dispatch.ts'
export { defineElement, StatorElement } from './element.ts'
export type { ClientBehavior } from './machine.ts'
export { machine } from './machine.ts'
export type { DispatchError } from './transport.ts'
export type { ClientInstance, ClientInstanceBase } from './use.ts'
export { use } from './use.ts'
