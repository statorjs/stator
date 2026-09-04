import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { writeArtifactDeps } from '../src/build/artifact.ts'

/**
 * The dependency half of the deploy artifact, and the guards that keep
 * `stator start` honest about reading everything from it.
 *
 * The rule under test: a lockfile beside the app's `package.json` means both
 * travel verbatim, so the install on the target is locked to what was tested; no
 * lockfile means a workspace member, whose manifest is synthesized with pins
 * read from the INSTALLED tree (never from declared ranges — `npm ci` validates
 * the lockfile against the manifest and refuses a mismatch).
 */

const here = dirname(fileURLToPath(import.meta.url))
const bin = resolve(here, '../src/cli/stator.js')

let tmp: string | undefined
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = undefined
})

const app = async (files: Record<string, string>): Promise<string> => {
  tmp = await mkdtemp(join(tmpdir(), 'stator-artifact-'))
  const root = join(tmp, 'app')
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  await mkdir(join(root, 'out'), { recursive: true })
  return root
}

describe('artifact deps: a self-contained app', () => {
  it('copies package.json and the lockfile verbatim, and names a frozen install', async () => {
    const root = await app({
      'package.json': JSON.stringify({
        name: 'solo',
        version: '1.2.3',
        type: 'module',
        dependencies: { '@statorjs/stator': '^2.9.0' },
      }),
      'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    })
    const deps = await writeArtifactDeps({
      root,
      outDir: join(root, 'out'),
      packages: ['@statorjs/stator'],
    })

    expect(deps.kind).toBe('copied')
    expect(deps.files).toEqual(['package.json', 'package-lock.json'])
    expect(deps.install).toBe('npm ci --omit=dev')
    // Verbatim: a rewritten manifest would fail `npm ci`'s sync check, and a
    // frozen pnpm install compares the lockfile's importer manifest to this file.
    const copied = JSON.parse(await readFile(join(root, 'out/package.json'), 'utf8'))
    expect(copied.dependencies['@statorjs/stator']).toBe('^2.9.0')
    expect(copied.version).toBe('1.2.3')
  })

  it('infers the install command from the lockfile it finds', async () => {
    const root = await app({
      'package.json': JSON.stringify({ name: 'solo', version: '1.0.0' }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    })
    const deps = await writeArtifactDeps({ root, outDir: join(root, 'out'), packages: [] })
    expect(deps.kind).toBe('copied')
    expect(deps.install).toBe('pnpm install --frozen-lockfile --prod')
  })
})

describe('artifact deps: a workspace member', () => {
  it('pins each reached dependency to the version actually installed', async () => {
    const root = await app({
      'package.json': JSON.stringify({
        name: 'member',
        version: '0.0.0',
        // Unresolvable off the workspace — the reason the manifest cannot travel.
        dependencies: { '@statorjs/stator': 'workspace:*', debug: '^4.3.0' },
      }),
      'node_modules/@statorjs/stator/package.json': JSON.stringify({
        name: '@statorjs/stator',
        version: '2.9.1',
      }),
      'node_modules/debug/package.json': JSON.stringify({ name: 'debug', version: '4.4.3' }),
    })
    const deps = await writeArtifactDeps({
      root,
      outDir: join(root, 'out'),
      packages: ['@statorjs/stator', 'debug'],
    })

    expect(deps.kind).toBe('generated')
    expect(deps.pinned).toEqual({ '@statorjs/stator': '2.9.1', debug: '4.4.3' })
    expect(deps.unpinned).toBeUndefined()

    const generated = JSON.parse(await readFile(join(root, 'out/package.json'), 'utf8'))
    // `workspace:*` became a real, installable version.
    expect(generated.dependencies['@statorjs/stator']).toBe('2.9.1')
    // dist becomes the deploy root, with nothing above it to inherit `type` from.
    expect(generated.type).toBe('module')
    expect(generated.scripts.start).toBe('stator start')
  })

  it('declares only what the app reached', async () => {
    const root = await app({
      'package.json': JSON.stringify({
        name: 'member',
        version: '0.0.0',
        dependencies: { used: '^1.0.0', unused: '^1.0.0' },
      }),
      'node_modules/used/package.json': JSON.stringify({ name: 'used', version: '1.2.0' }),
      'node_modules/unused/package.json': JSON.stringify({ name: 'unused', version: '1.0.0' }),
    })
    const deps = await writeArtifactDeps({ root, outDir: join(root, 'out'), packages: ['used'] })
    expect(Object.keys(deps.pinned ?? {})).toEqual(['used'])
  })

  it('reports a dependency it could not pin instead of inventing a version', async () => {
    const root = await app({
      'package.json': JSON.stringify({
        name: 'member',
        version: '0.0.0',
        dependencies: { ghost: '^3.1.0' },
      }),
    })
    const deps = await writeArtifactDeps({ root, outDir: join(root, 'out'), packages: ['ghost'] })
    expect(deps.unpinned).toEqual(['ghost'])
    expect(deps.pinned?.ghost).toBe('^3.1.0') // the declared range, not a guess
  })
})

describe('artifact deps: no manifest at all', () => {
  it('writes nothing', async () => {
    const root = await app({ 'routes/index.ts': 'export const GET = {}\n' })
    const deps = await writeArtifactDeps({ root, outDir: join(root, 'out'), packages: [] })
    expect(deps).toEqual({ kind: 'none', files: [] })
  })
})

describe('stator start: the artifact must be complete', () => {
  const startFails = async (root: string): Promise<string> => {
    const child = spawn(process.execPath, [bin, 'start', '--root', root, '--port', '53599'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    let out = ''
    child.stdout.on('data', (b) => {
      out += b
    })
    child.stderr.on('data', (b) => {
      out += b
    })
    const code = await new Promise<number | null>((done) => child.once('exit', done))
    expect(code, `expected a non-zero exit, got:\n${out}`).not.toBe(0)
    return out
  }

  /** A built artifact, minus whatever the test wants missing. Defaults to the
   *  running framework version so a version mismatch is always deliberate —
   *  otherwise the emit-compatibility guard fires before the one under test. */
  const artifact = async (manifest: Record<string, unknown>, withConfig: boolean) => {
    const { version } = JSON.parse(await readFile(resolve(here, '../package.json'), 'utf8')) as {
      version: string
    }
    const files: Record<string, string> = {
      'routes/index.ts': `export const GET = { render: () => '<p>hi</p>' }\n`,
      'stator-manifest.json': JSON.stringify({
        buildId: 'x',
        islands: {},
        routes: {},
        machines: {},
        statorVersion: version,
        ...manifest,
      }),
    }
    if (withConfig) files['stator.config.ts'] = 'export default {}\n'
    return app(files)
  }

  it('refuses an artifact built before the manifest recorded its config', async () => {
    // "no config" and "the config didn't travel" are indistinguishable here, and
    // guessing wrong silently downgrades persistence to in-memory.
    const root = await artifact({ statorVersion: undefined }, false)
    expect(await startFails(root)).toMatch(/older stator|run `stator build`/)
  })

  it('refuses an artifact compiled by a different framework minor', async () => {
    // The artifact holds output emitted by one specific compiler. Serving it
    // with a different minor makes the runtime and the emit disagree, and the
    // failure is obscure — a template read reporting it was called outside a
    // render, because two copies of the framework hold separate render state.
    // An app whose lockfile pins an older version than the machine that built
    // it produces exactly this, silently. Observed on a real app: dist compiled
    // by 2.9.1, framework installed at 2.0.0.
    const root = await artifact({ config: null, statorVersion: '1.4.0' }, false)
    const out = await startFails(root)
    expect(out).toMatch(/compiled by @statorjs\/stator 1\.4\.0/)
    expect(out).toMatch(/rebuild/)
  })

  it('accepts a patch-level difference, which cannot change the emit', async () => {
    const { version } = JSON.parse(await readFile(resolve(here, '../package.json'), 'utf8')) as {
      version: string
    }
    const [major, minor] = version.split('.')
    const root = await artifact({ config: null, statorVersion: `${major}.${minor}.99` }, false)
    // Not the version guard — it gets far enough to fail on something else
    // (no machines/ in this hand-built artifact), which is the point.
    const out = await startFails(root)
    expect(out).not.toMatch(/compiled by @statorjs/)
  })

  it('refuses an artifact whose recorded config is missing', async () => {
    const root = await artifact({ config: 'stator.config.ts' }, false)
    expect(await startFails(root)).toMatch(/incomplete|not in the artifact/)
  })
})
