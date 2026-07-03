/**
 * Client authoring API for `.stator` `<script>` islands — `@statorjs/stator/client`.
 * Browser-safe (no server imports). The compiler auto-injects what a generated
 * island needs; these are also the symbols an author references directly.
 */

export { bind, effect } from './bind.ts'
export { dispatch } from './dispatch.ts'
export { defineElement, StatorElement } from './element.ts'
export type { MachineConfig } from './machine.ts'
export { machine } from './machine.ts'
export type { ClientInstance } from './use.ts'
export { use } from './use.ts'
