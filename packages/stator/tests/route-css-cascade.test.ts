import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { routeCssMap } from '../src/build/route-css.ts'

/**
 * Does CSS discovery cascade transitively — route → component A → component
 * B → component C, each importing the next, each with its own sibling
 * `.css`? Answered empirically rather than just read off `walkReachable`'s
 * recursion, since this is exactly the kind of thing worth being sure about.
 */

let base: string | undefined

afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true })
  base = undefined
})

describe('route-css: transitive local cascade', () => {
  it("a 3-deep local chain contributes every level's CSS to the route", async () => {
    base = await mkdtemp(join(tmpdir(), 'stator-cascade-'))
    const root = join(base, 'app')
    await mkdir(join(root, 'routes'), { recursive: true })
    await mkdir(join(root, 'templates'), { recursive: true })

    await writeFile(
      join(root, 'routes/x.ts'),
      "import A from '../templates/a.ts'\nexport const x = A\n",
    )
    await writeFile(join(root, 'templates/a.ts'), "import B from './b.ts'\nexport default B\n")
    await writeFile(join(root, 'templates/a.css'), '.a { color: red; }\n')
    await writeFile(join(root, 'templates/b.ts'), "import C from './c.ts'\nexport default C\n")
    await writeFile(join(root, 'templates/b.css'), '.b { color: green; }\n')
    await writeFile(join(root, 'templates/c.ts'), 'export default 1\n')
    await writeFile(join(root, 'templates/c.css'), '.c { color: blue; }\n')

    const map = await routeCssMap({ routesDir: join(root, 'routes'), baseDir: root })
    const css = map.get(join(root, 'routes/x.ts'))
    expect(css).toContain('.a { color: red; }')
    expect(css).toContain('.b { color: green; }')
    expect(css).toContain('.c { color: blue; }')
  })
})
