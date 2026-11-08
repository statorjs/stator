import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { IScriptSnapshot } from 'typescript'
import { URI } from 'vscode-uri'
import { ambientFor, statorLanguagePlugin } from '../src/language-plugin.ts'
import { findProjectStator } from '../src/project-stator.ts'

/** A project dir with `@statorjs/stator` installed at `version`, exporting
 *  `/editor` or not. Returns the path of a route file inside it. */
function project(version: string, editor: boolean): { routeFile: string; pkgJson: string } {
  const root = mkdtempSync(join(tmpdir(), 'stator-ls-'))
  const pkgDir = join(root, 'node_modules', '@statorjs', 'stator')
  mkdirSync(pkgDir, { recursive: true })
  const pkgJson = join(pkgDir, 'package.json')
  writeFileSync(pkgJson, pkgJsonFor(version, editor))
  mkdirSync(join(root, 'src', 'routes', 'blog'), { recursive: true })
  return { routeFile: join(root, 'src', 'routes', 'blog', 'index.stator'), pkgJson }
}

function pkgJsonFor(version: string, editor: boolean): string {
  const exports: Record<string, string> = {
    '.': './src/index.ts',
    './compiler': './src/compiler/index.ts',
  }
  if (editor) exports['./editor'] = './src/editor.ts'
  return JSON.stringify({ name: '@statorjs/stator', version, exports })
}

const snap = (text: string): IScriptSnapshot => ({
  getText: (s, e) => text.slice(s, e),
  getLength: () => text.length,
  getChangeRange: () => undefined,
})

describe('the project install of @statorjs/stator', () => {
  it('is found by walking up from the file, with its version', () => {
    const { routeFile } = project('2.16.0', false)
    const found = findProjectStator(routeFile)
    assert.ok(found)
    assert.equal(found.version, '2.16.0')
    assert.equal(found.editorContract, false)
  })

  it('reports the editor contract when the install exports /editor', () => {
    const { routeFile } = project('3.0.0-next.2', true)
    const found = findProjectStator(routeFile)
    assert.ok(found)
    assert.equal(found.editorContract, true)
  })

  it('is undefined with nothing installed above the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'stator-ls-none-'))
    assert.equal(findProjectStator(join(root, 'x.stator')), undefined)
  })

  it('picks up an upgrade on the next lookup', () => {
    const { routeFile, pkgJson } = project('2.16.0', false)
    assert.equal(findProjectStator(routeFile)?.editorContract, false)
    writeFileSync(pkgJson, pkgJsonFor('3.0.0', true))
    const later = new Date(Date.now() + 5000)
    utimesSync(pkgJson, later, later)
    assert.equal(findProjectStator(routeFile)?.editorContract, true)
  })
})

describe('the Stator macros follow the project install', () => {
  const SRC = `---\nconst { title } = Stator.props<{ title: string }>()\n---\n<h1>{title}</h1>\n`
  const tsxOf = (file: string): string => {
    const vc = statorLanguagePlugin.createVirtualCode!(
      URI.file(file),
      'stator',
      snap(SRC),
      {} as never,
    )
    assert.ok(vc)
    const tsx = vc.embeddedCodes?.find((c) => c.id === 'tsx')
    assert.ok(tsx)
    return tsx.snapshot.getText(0, tsx.snapshot.getLength())
  }

  it('types them from the project /editor when it exports one', () => {
    const { routeFile } = project('3.0.0', true)
    assert.equal(ambientFor(URI.file(routeFile)), 'project')
    const tsx = tsxOf(routeFile)
    assert.match(tsx, /from '@statorjs\/stator\/editor'/)
    assert.doesNotMatch(tsx, /declare const Stator: \{/)
  })

  it('falls back to the bundled shape for an install that predates it', () => {
    const { routeFile } = project('2.16.0', false)
    assert.equal(ambientFor(URI.file(routeFile)), 'bundled')
    const tsx = tsxOf(routeFile)
    assert.doesNotMatch(tsx, /@statorjs\/stator\/editor/)
    assert.match(tsx, /declare const Stator: \{/)
  })

  it('falls back for a file outside any project or not on disk', () => {
    assert.equal(
      ambientFor(URI.file(join(mkdtempSync(join(tmpdir(), 'ls-')), 'x.stator'))),
      'bundled',
    )
    assert.equal(ambientFor(URI.parse('untitled:Untitled-1')), 'bundled')
  })
})
