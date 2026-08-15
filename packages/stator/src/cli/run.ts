import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Shared context every command receives. */
export interface CliContext {
  /** App root — where machines/, routes/, static/, dist/ live. Defaults to cwd. */
  root: string
  /** Listen port (dev/start). Defaults to $PORT then 3000. */
  port: number
  /** Extra positionals after the command (e.g. test file globs). */
  rest: string[]
}

const COMMANDS = ['dev', 'build', 'start', 'check', 'test'] as const
type Command = (typeof COMMANDS)[number]

const HELP = `stator — the Stator toolchain CLI

Usage: stator <command> [options]

Commands:
  dev       Run the dev server (live reload, inspector)
  build     Compile the app to dist/ (runs \`check\` first)
  start     Serve a built dist/ in production mode
  check     Typecheck the whole stack (server + generated .stator types), no output
  test      Run the test suite

Options:
  --root <dir>    App root (default: current directory)
  --port <n>      Listen port for dev/start (default: $PORT or 3000)
  -h, --help      Show this help
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    root: { type: 'string' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

const command = positionals[0] as Command | undefined

if (values.help || !command) {
  process.stdout.write(HELP)
  process.exit(command ? 0 : values.help ? 0 : 1)
}

if (!COMMANDS.includes(command)) {
  process.stderr.write(`stator: unknown command "${command}"\n\n${HELP}`)
  process.exit(1)
}

const ctx: CliContext = {
  root: resolve(String(values.root ?? process.cwd())),
  port: Number(values.port ?? process.env.PORT ?? 3000),
  rest: positionals.slice(1),
}

// Dynamic import per command so `check` never loads the dev server's Vite, etc.
const { run } = (await import(`./commands/${command}.ts`)) as {
  run: (ctx: CliContext) => Promise<void>
}

try {
  await run(ctx)
} catch (err) {
  process.stderr.write(`stator ${command}: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
