import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { StatorConfig } from '../config.ts'

const CONFIG_NAMES = [
  'stator.config.ts',
  'stator.config.mts',
  'stator.config.js',
  'stator.config.mjs',
]

/**
 * Load `stator.config.{ts,mts,js,mjs}` from the app root if present. Returns `{}`
 * when there is none — every field is optional. The default export may be the
 * config object or a (possibly async) function returning one.
 *
 * No key normalization: `StatorConfig` is a brand-new, never-released surface, so
 * the nested shape is the only shape — there is nothing to be backward-compatible
 * with.
 */
export async function loadConfig(root: string): Promise<StatorConfig> {
  for (const name of CONFIG_NAMES) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown }
    const raw = mod.default ?? mod
    const resolved = typeof raw === 'function' ? await (raw as () => unknown)() : raw
    if (resolved && typeof resolved === 'object') return resolved as StatorConfig
    throw new Error(`${name} must export a config object (or a function returning one)`)
  }
  return {}
}

/** Resolve the listen port: `--port` flag > `$PORT` > config > 3000. */
export function resolvePort(flag: number | undefined, configPort: number | undefined): number {
  if (flag != null) return flag
  if (process.env.PORT) return Number(process.env.PORT)
  return configPort ?? 3000
}
