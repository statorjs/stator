import pino, { type Logger } from 'pino'

/**
 * Framework logger. Pretty colored output in dev (auto-detected via
 * NODE_ENV), JSON in production for log aggregators. Level controlled by
 * LOG_LEVEL env (default 'info').
 *
 * Application code can use this module-level logger or call `child()` for
 * scoped context. The framework uses scoped children for SSE events,
 * fan-out, and HTTP request lines.
 */
function buildLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? 'info'
  const isProd = process.env.NODE_ENV === 'production'

  if (isProd) {
    return pino({ level })
  }

  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    },
  })
}

export const logger: Logger = buildLogger()

/** Child logger with a `scope` tag for filtering. */
export function scopedLogger(scope: string): Logger {
  return logger.child({ scope })
}
