/** The `NODE_ENV` each command runs under when the environment doesn't set
 *  one. `check` reads code without running the app, so it sets none. */
export const NODE_ENV_FOR: Readonly<Record<string, string>> = {
  dev: 'development',
  test: 'test',
  build: 'production',
  'build:lib': 'production',
  start: 'production',
}

/** Set `NODE_ENV` for `command` unless it is already set, so an explicit
 *  value (the shell, a deploy platform, `.env`) always wins. */
export function applyNodeEnv(command: string, env: NodeJS.ProcessEnv = process.env): void {
  const value = NODE_ENV_FOR[command]
  if (value && !env.NODE_ENV) env.NODE_ENV = value
}
