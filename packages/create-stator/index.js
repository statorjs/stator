#!/usr/bin/env node
// Minimal Stator scaffolder: copies the embedded template into a new
// directory and stamps the project name. No prompts, no network.
import { cp, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2]
if (!target) {
  console.log('Usage: pnpm create stator <directory>')
  console.log('       npm create stator@latest <directory>')
  process.exit(1)
}

const dest = resolve(process.cwd(), target)
try {
  const existing = await readdir(dest)
  if (existing.length > 0) {
    console.error(`create-stator: ${target} exists and is not empty — refusing to overwrite.`)
    process.exit(1)
  }
} catch {
  // does not exist — fine
}

const templateDir = fileURLToPath(new URL('./template', import.meta.url))
await cp(templateDir, dest, { recursive: true })

// npm strips dotfiles from published packages; ship as _gitignore and rename.
try {
  await stat(join(dest, '_gitignore'))
  await rename(join(dest, '_gitignore'), join(dest, '.gitignore'))
} catch {
  // already named .gitignore (running from the repo)
}

const name = basename(dest)
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
const pkgPath = join(dest, 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
pkg.name = name
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

console.log(`
  Scaffolded ${name} into ${dest}

  Next steps:
    cd ${target}
    pnpm install
    pnpm dev        # http://localhost:3000

  Other scripts: pnpm typecheck · pnpm build · pnpm start
`)
