import { createRequire } from 'node:module'
import pino, { type Logger, type TransportSingleOptions } from 'pino'

/**
 * Framework logger. Pretty colored output in dev (auto-detected via
 * NODE_ENV), JSON in production for log aggregators. Level defaults to `warn`
 * in production (quiet — errors and warnings only) and `info` in dev; the
 * `LOG_LEVEL` env overrides both, and `stator.config.ts`'s `logging.level`
 * overrides the default when `LOG_LEVEL` is unset (applied at app construction).
 *
 * Application code can use this module-level logger or call `child()` for
 * scoped context. The framework uses scoped children for SSE events,
 * fan-out, and HTTP request lines.
 */
/** pino-pretty is an optional nicety, not a framework dependency — apps add
 *  it as a devDependency for colored dev output (the create-stator template
 *  does). Without it, dev logs are plain JSON rather than a crash.
 *
 *  The target is the resolved absolute path, never the bare package name:
 *  pino resolves a bare name from its callers' script names, and a module
 *  evaluated by a Vite SSR runner has none, so the bare name is unresolvable
 *  there. An absolute path is passed through untouched. */
export function prettyTransport(): TransportSingleOptions | null {
  let target: string
  try {
    target = createRequire(import.meta.url).resolve('pino-pretty')
  } catch {
    return null
  }
  return {
    target,
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
      singleLine: false,
    },
  }
}

function buildLogger(): Logger {
  const isProd = process.env.NODE_ENV === 'production'
  const level = process.env.LOG_LEVEL ?? (isProd ? 'warn' : 'info')

  const transport = isProd ? null : prettyTransport()
  return transport ? pino({ level, transport }) : pino({ level })
}

export const logger: Logger = buildLogger()

// Pino children capture the parent level at CREATION and do not follow later
// changes to it. The framework's scoped loggers (http, sse, effect, …) are all
// created at module load, so `logger.level = …` alone would never quiet them.
// Track them and set the level on each explicitly in `setLogLevel`.
const scopedChildren: Logger[] = []

/** Child logger with a `scope` tag for filtering. */
export function scopedLogger(scope: string): Logger {
  const child = logger.child({ scope })
  scopedChildren.push(child)
  return child
}

/**
 * Set the level on the root logger AND every scoped child. Children created
 * after this call inherit the new root level, so this is complete regardless of
 * import order. Called once at app construction from the resolved config.
 */
export function setLogLevel(level: string): void {
  logger.level = level
  for (const child of scopedChildren) child.level = level
}
