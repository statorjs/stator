import { readFileSync } from 'node:fs'

/** The `import.meta.url`-relative root file the old copy step never copied. */
export const rootData = (): string => readFileSync(new URL('../app.data', import.meta.url), 'utf8')
