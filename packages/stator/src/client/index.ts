/**
 * Client authoring API for `.stator` `<script>` islands — `@statorjs/stator/client`.
 * Browser-safe (no server imports). The compiler auto-injects what a generated
 * island needs; these are also the symbols an author references directly.
 */
export { StatorElement, defineElement } from './element.ts'
export { use } from './use.ts'
export type { ClientInstance } from './use.ts'
export { machine } from './machine.ts'
export type { MachineConfig } from './machine.ts'
export { bind, effect } from './bind.ts'
export { dispatch } from './dispatch.ts'
