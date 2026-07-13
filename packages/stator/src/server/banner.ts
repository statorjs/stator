import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { logger } from './logger.ts'

/**
 * Human-facing startup/exit output for the DEV plane. Production keeps
 * structured pino logs (ops parse those); the dev server prints for a
 * person: clickable URLs, a one-line inventory, a graceful goodbye.
 */

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined
const c = {
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  copper: (s: string) => (useColor ? `\x1b[38;5;173m${s}\x1b[0m` : s),
}

let cachedVersion: string | undefined
function statorVersion(): string {
  if (!cachedVersion) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
      cachedVersion = String(pkg.version)
    } catch {
      cachedVersion = ''
    }
  }
  return cachedVersion
}

function lanAddress(): string | undefined {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return undefined
}

export function printDevBanner(info: {
  port: number
  /** The port originally asked for, when the server had to shift off it. */
  requestedPort?: number
  machines: number
  routes: number
  inspector?: boolean
}): void {
  const v = statorVersion()
  const lan = lanAddress()
  const shifted =
    info.requestedPort !== undefined && info.requestedPort !== info.port
      ? [`  ${c.dim(`port ${info.requestedPort} was busy — using ${info.port}`)}`]
      : []
  const lines = [
    '',
    `  ${c.copper(c.bold('stator'))}${v ? c.dim(` v${v}`) : ''}  ${c.dim('dev server')}`,
    '',
    `  ${c.dim('local')}    ${c.cyan(`http://localhost:${info.port}/`)}`,
    ...(lan ? [`  ${c.dim('network')}  ${c.cyan(`http://${lan}:${info.port}/`)}`] : []),
    '',
    `  ${c.dim(
      `${info.machines} machine${info.machines === 1 ? '' : 's'} · ${info.routes} route${
        info.routes === 1 ? '' : 's'
      }${info.inspector ? ' · inspector on' : ''} — Ctrl+C to stop`,
    )}`,
    ...shifted,
    '',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * Exit a server process like a well-mannered CLI: first signal closes
 * cleanly and exits 0 (Ctrl+C is a normal action, not a failure — without
 * this, the process dies 130 and pnpm prints an ELIFECYCLE error banner);
 * a second signal force-quits for anything that hangs in close().
 */
export function installGracefulShutdown(close: () => Promise<void> | void, quiet = false): void {
  let closing = false
  const handler = (signal: NodeJS.Signals) => {
    if (closing) process.exit(130)
    closing = true
    if (!quiet) process.stdout.write(`\n${c.dim('  stopping…')}\n`)
    void (async () => {
      try {
        await close()
      } catch (err) {
        logger.warn({ err: String(err) }, 'error during shutdown')
      }
      process.exit(0)
    })()
    void signal
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
}

/** First free TCP port at or above `start` (bounded probe). The dev plane
 *  auto-shifts off busy ports like every modern dev server; production
 *  never calls this — a taken port there is a deploy error to surface. */
export async function findFreePort(start: number, attempts = 10): Promise<number> {
  const { createServer } = await import('node:net')
  for (let port = start; port < start + attempts; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port)
    })
    if (free) return port
  }
  throw new Error(`stator: no free port found in ${start}–${start + attempts - 1}`)
}
