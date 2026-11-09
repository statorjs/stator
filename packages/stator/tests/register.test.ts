import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { testEnv } from '../src/cli/commands/test.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

/**
 * An app installed from a registry: Stator COPIED into node_modules (a link
 * would resolve back to this checkout, outside node_modules), and a package
 * built on it two levels down — `@acme/widgets` depends on `@acme/runtime`,
 * which imports Stator — so nothing about the fix depends on finding direct
 * dependents. Stator's own dependencies resolve upward to this package's
 * node_modules.
 */
const app = resolve(here, '.tmp-register-app')

before(
  () => {
    rmSync(app, { recursive: true, force: true })
    const stator = join(app, 'node_modules', '@statorjs', 'stator')
    mkdirSync(stator, { recursive: true })
    cpSync(join(pkgRoot, 'src'), join(stator, 'src'), { recursive: true })
    cpSync(join(pkgRoot, 'package.json'), join(stator, 'package.json'))
    const pkg = (name: string, deps: Record<string, string>, code: string) => {
      const dir = join(app, 'node_modules', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name, type: 'module', exports: './index.js', dependencies: deps }),
      )
      writeFileSync(join(dir, 'index.js'), code)
    }
    // Built JS reaching Stator's TypeScript: buildHonoApp's module pulls in
    // the session runtime, whose constructor parameter properties Node's own
    // type stripping rejects even outside node_modules.
    pkg(
      '@acme/runtime',
      { '@statorjs/stator': '*' },
      "export { buildHonoApp } from '@statorjs/stator/server/runtime'\nexport { createActor } from '@statorjs/stator/machine'\n",
    )
    pkg('@acme/widgets', { '@acme/runtime': '*' }, "export * from '@acme/runtime'\n")
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { '@acme/widgets': '*' } }),
    )
    writeFileSync(
      join(app, 'main.mjs'),
      "const m = await import('@acme/widgets')\nconsole.log(typeof m.createActor, typeof m.buildHonoApp)\n",
    )
  },
  { timeout: 30_000 },
)

after(() => {
  rmSync(app, { recursive: true, force: true })
})

const run = (env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ['main.mjs'], { cwd: app, env, encoding: 'utf8' })

describe('@statorjs/stator/register', () => {
  it('without it, Node cannot load Stator from node_modules', () => {
    const { NODE_OPTIONS: _, ...env } = process.env
    const res = run(env)
    assert.notEqual(res.status, 0)
    assert.match(
      res.stderr,
      /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|strip-only|Unknown file extension/,
    )
  })

  it('with it, a package built on Stator loads, however deep', () => {
    const res = run(testEnv({ ...process.env, NODE_OPTIONS: '' }))
    assert.equal(res.stderr, '')
    assert.equal(res.stdout.trim(), 'function function')
  })

  it('also loads by its public specifier, as an editor or script would pass it', () => {
    const res = run({ ...process.env, NODE_OPTIONS: '--import @statorjs/stator/register' })
    assert.equal(res.stderr, '')
    assert.equal(res.stdout.trim(), 'function function')
  })

  it('registers without a deprecation warning', () => {
    const res = run({
      ...process.env,
      NODE_OPTIONS: '--throw-deprecation --import @statorjs/stator/register',
    })
    assert.equal(res.status, 0, res.stderr)
    assert.doesNotMatch(res.stderr, /DeprecationWarning|DEP0205/)
  })
})

describe('stator test', () => {
  it('adds the loader to NODE_OPTIONS, keeping what was there, once', () => {
    const env = testEnv({ NODE_OPTIONS: '--max-old-space-size=2048' })
    assert.match(
      env.NODE_OPTIONS ?? '',
      /^--max-old-space-size=2048 --import file:\/\/.*\/src\/register\.js$/,
    )
    assert.equal(testEnv(env).NODE_OPTIONS, env.NODE_OPTIONS)
    assert.ok(testEnv({}).NODE_OPTIONS)
    assert.match(testEnv({}).NODE_OPTIONS!, /^--import file:/)
  })
})
