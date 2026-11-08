import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_PATTERNS, testArgs } from '../src/cli/commands/test.ts'

describe('stator test', () => {
  it('runs node --test with the loader and the preload, and the default patterns when no files are named', () => {
    const args = testArgs([])
    assert.equal(args.filter((a) => a === '--import').length, 2)
    assert.ok(args.some((a) => a.endsWith('/register.js')))
    assert.ok(args.some((a) => a.endsWith('/test-env.ts')))
    assert.ok(args.includes('--test'))
    assert.deepStrictEqual(args.slice(-DEFAULT_PATTERNS.length), DEFAULT_PATTERNS)
  })

  it('passes flags through and keeps the defaults; named files replace them', () => {
    assert.deepStrictEqual(testArgs(['--watch']).slice(-3), ['--watch', ...DEFAULT_PATTERNS])
    const named = testArgs(['tests/cart.test.ts'])
    assert.equal(named.at(-1), 'tests/cart.test.ts')
    assert.ok(!named.includes(DEFAULT_PATTERNS[0]!))
  })

  it('gives DOM globals only to a file marked // @env happy-dom', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stator-test-env-'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    writeFileSync(
      join(dir, 'dom.test.ts'),
      "// @env happy-dom\nimport assert from 'node:assert/strict'\nimport { it } from 'node:test'\nit('dom', () => assert.equal(typeof document.createElement, 'function'))\n",
    )
    writeFileSync(
      join(dir, 'server.test.ts'),
      "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nit('server', () => assert.equal(typeof (globalThis as { document?: unknown }).document, 'undefined'))\n",
    )
    // happy-dom resolves from the app; this package has it as a dev dependency.
    // A runner inside a test file is refused while the child still sees the
    // parent's test context, so it gets an environment without it.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env
    const res = spawnSync(process.execPath, [...testArgs(['dom.test.ts', 'server.test.ts'])], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, NODE_PATH: join(import.meta.dirname, '..', 'node_modules') },
    })
    // Exit 0 means both files passed: the marked one saw a DOM, the other did not.
    // (Asserted on status, not output, so any reporter works, the gate's dot one included.)
    assert.equal(res.status, 0, res.stdout + res.stderr)
  })
})
