// Preload for `node --test`: each test file runs in its own process, and
// this runs first in it. Tests exercise failure paths on purpose (403s,
// snapshot recovery), so the framework logger is silent unless LOG_LEVEL is
// exported. A file that needs a browser-shaped global scope says so with an
// `// @env happy-dom` line; nothing else gets DOM globals, so a server test
// can never pass by accident on a `typeof window` branch.
import { readFileSync } from 'node:fs'

process.env.LOG_LEVEL ??= 'silent'

const file = process.argv[1]
if (file && /^\/\/ @env happy-dom$/m.test(readFileSync(file, 'utf8'))) {
  await import('./happy-dom.ts')
}
