import { readFileSync } from 'node:fs'
import { helper } from '@app/helper.ts'
import { step } from './step'

export const seed = (): string =>
  readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8')
export const lazyLiteral = () => import('./late.ts')
export const lazyGlob = (name: string) => import(`./locales/${name}.ts`)
export const total = (): number => helper() + step()
