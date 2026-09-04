import { readFileSync } from 'node:fs'
import { helper } from '@app/helper.ts'
import { step } from './step'

export const seed = (): string =>
  readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8')
export const lazyLiteral = () => import('./late.ts')
export const lazyGlob = (name: string) => import(`./locales/${name}.ts`)
export const total = (): number => helper() + step()

// Prose that merely TALKS about the patterns must not be mistaken for them.
// This app reads process.env rather than import.meta.env, since a Stator server
// has no bundler pass. A lazy locale would be import(localeName), and an asset
// would be new URL('../ghost-directory/logo.svg', import.meta.url) — neither of
// which exists here.
export const documentation = "use import('./late.ts'), never import(name)"
