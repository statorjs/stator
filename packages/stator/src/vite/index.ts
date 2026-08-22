/**
 * Vite integration for `.stator` single-file components.
 * `import { stator } from '@statorjs/stator/vite'` and add it to `plugins`.
 */
export { CLIENT_QUERY, stator } from './plugin.ts'
export { MACHINE_STUB_PREFIX, machineStub } from './stub.ts'
