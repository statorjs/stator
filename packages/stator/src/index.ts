// Root export = the config-authoring surface only. `stator.config.ts` is the
// first file anyone writes against the bare package name, and it must never
// drag server-only dependencies (sharp, ioredis) into a config load — anything
// beyond config keeps its own subpath.

export type { LogLevel, StatorConfig } from './config.ts'
export { defineConfig } from './config.ts'
