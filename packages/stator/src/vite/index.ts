/**
 * INTERNAL — the framework's own Vite glue: the `.stator` plugin the Vite-backed
 * dev server uses and the island bundler's machine-import stub. Not a plugin
 * surface: Stator never reads a user `vite.config.*` and accepts no bundler
 * plugins (a plugin would reach client islands and nothing else, silently
 * splitting the app into a tier where it applies and a tier where it doesn't).
 * What to do instead — global CSS, Tailwind, images, WASM — is documented under
 * "Styling and assets" in the docs.
 */
export { CLIENT_QUERY, stator } from './plugin.ts'
export { MACHINE_STUB_PREFIX, machineStub } from './stub.ts'
