import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compile } from '../src/compiler/compile.ts'
import { compileWarnings, RAW_SCRIPT_WARNING } from '../src/compiler/warnings.ts'

const at = (src: string, needle: string): number => src.indexOf(needle)

describe('compiler warnings: <script> strings passed to raw()', () => {
  it('compiles the template-literal repro, and warns at the literal', () => {
    // Once lifted out as a client component, cutting the literal in half.
    const src = `---
import { raw } from '@statorjs/stator/template'
const json = '{"prerender":[]}'
---
<head>{json ? raw(\`<script type="speculationrules">\${json}</script>\`) : null}</head>`
    const out = compile(src, { id: 'speculation.stator', kind: 'component' })
    assert.deepStrictEqual(out.scripts, [])
    assert.equal(out.isClient, false)

    const warnings = compileWarnings(src)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]!.message, RAW_SCRIPT_WARNING)
    assert.equal(warnings[0]!.offset, at(src, '`<script'))
    assert.equal(warnings[0]!.loc.line, 5)
  })

  it('warns in frontmatter too, and for a plain string literal', () => {
    const src = `---
const tag = raw('<script>go()</script>')
---
<p>{tag}</p>`
    const warnings = compileWarnings(src)
    assert.deepStrictEqual(
      warnings.map((w) => w.offset),
      [at(src, "'<script>")],
    )
    assert.equal(warnings[0]!.loc.line, 2)
  })

  it('warns inside an attribute expression and nested JSX', () => {
    const src = `<div data-x={raw('<script src="a.js"></script>')}>{ok && <p>{raw("<SCRIPT>x</SCRIPT>")}</p>}</div>`
    assert.deepStrictEqual(
      compileWarnings(src).map((w) => w.offset),
      [at(src, `'<script src`), at(src, '"<SCRIPT>')],
    )
  })

  it('warns for a concatenation, at its start', () => {
    const src = `---
const tag = raw('<script type="application/ld+json">' + data + '</script>')
---
<p>{tag}</p>{raw(("<scr" + "ipt>") + (body + '</script>'))}`
    const warnings = compileWarnings(src)
    assert.deepStrictEqual(
      warnings.map((w) => w.offset),
      [at(src, "'<script type"), at(src, '("<scr')],
    )
    assert.equal(warnings[0]!.loc.line, 2)
    assert.equal(warnings[1]!.loc.line, 4)
  })

  it("doesn't warn for a concatenation without <script, or one split by a value", () => {
    assert.deepStrictEqual(
      compileWarnings(
        `<p>{raw('<b>' + name + '</b>')}{raw('<' + tag + 'script>')}{raw(a + b)}</p>`,
      ),
      [],
    )
  })

  it("doesn't warn for a function call passed to raw()", () => {
    assert.deepStrictEqual(compileWarnings('<head>{raw(render("<script>"))}</head>'), [])
  })

  it("doesn't warn for a variable passed to raw()", () => {
    assert.deepStrictEqual(compileWarnings('<head>{raw(snippet)}</head>'), [])
  })

  it("doesn't warn for a plain string, which is escaped on output", () => {
    assert.deepStrictEqual(
      compileWarnings(`<pre>{'Use <script>…</script> for client code'}</pre>`),
      [],
    )
  })

  it("doesn't warn for a <style> string", () => {
    assert.deepStrictEqual(compileWarnings(`<head>{raw('<style>p {}</style>')}</head>`), [])
  })

  it("doesn't warn for a top-level <script> or a lookalike tag", () => {
    const src = `<p>{raw('<scripted-thing></scripted-thing>')}</p>
<script>export class A extends StatorElement { m() { return raw('<script>') } }</script>`
    assert.deepStrictEqual(compileWarnings(src), [])
  })
})

describe('compiler warnings: a plain conditional on a value that can change after render', () => {
  const messages = (src: string): string[] => compileWarnings(src).map((w) => w.message)

  it('warns for a machine snapshot, at the conditional, with the read() to use', () => {
    const src = `---
import Polls from '../machines/polls.ts'
import PollPage from '../templates/poll-page.stator'
const [polls] = Stator.reads([Polls])
const id = Stator.request.params.id ?? ''
const found = polls.byId(id) !== undefined
---
<main>
  {found ? (
    <PollPage polls={polls} id={id} />
  ) : (
    <h1>Poll not found</h1>
  )}
</main>`
    const warnings = compileWarnings(src, 'routes/p/[id].stator')
    assert.equal(warnings.length, 1)
    assert.equal(
      warnings[0]!.message,
      'this branch is chosen once, when the page renders. If `found` changes later, live ' +
        'updates in or after it can land on the wrong elements until the page reloads. Use ' +
        'when(read(polls, (p) => p.byId(id) !== undefined), …) so the branch is part of the ' +
        "page's live state.",
    )
    assert.equal(warnings[0]!.offset, at(src, 'found ? ('))
    assert.deepStrictEqual(
      [warnings[0]!.loc.file, warnings[0]!.loc.line, warnings[0]!.loc.column],
      ['routes/p/[id].stator', 9, 4],
    )
  })

  it('warns for a test on claims, and names when() and a session machine', () => {
    const src = `---
import Board from '../machines/board.ts'
const [board] = Stator.reads([Board])
const claims = Stator.request.claims()
---
<nav>{claims ? <b>{read(board, (b) => b.members)}</b> : <a href="/login">Sign in</a>}</nav>
<p>{read(board, (b) => b.total)}</p>`
    const warnings = compileWarnings(src)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]!.offset, at(src, 'claims ? <b>'))
    assert.equal(
      warnings[0]!.message,
      'this branch is chosen once, when the page renders. If `claims` changes later, live ' +
        'updates in or after it can land on the wrong elements until the page reloads. Use ' +
        'when(claims, …) to keep the ids around it stable; if the branch must follow sign-in ' +
        'and sign-out, keep the identity in a session machine and use when(read(machine, …), …).',
    )
  })

  it('follows claims through a derived binding, into an && with an on: handler', () => {
    const src = `---
const [board] = Stator.reads([Board])
const claims = Stator.request.claims<{ role: string }>()
const isOwner = claims?.role === 'owner'
---
<div>{isOwner && <button on:click={() => board.send({ type: 'CLEAR' })}>Clear</button>}</div>`
    const warnings = compileWarnings(src)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]!.offset, at(src, 'isOwner &&'))
    assert.ok(warnings[0]!.message.includes('If `isOwner` changes later'))
    assert.ok(warnings[0]!.message.includes('when(isOwner, …)'))
  })

  it('follows destructuring, of claims and of a machine handle', () => {
    const claims = `---
const { role } = Stator.request.claims<{ role: string }>() ?? {}
---
<p>{role === 'admin' ? <AdminBar /> : null}</p>`
    assert.equal(messages(claims).length, 1)
    assert.ok(messages(claims)[0]!.includes("when(role === 'admin', …)"))

    const machine = `---
const [polls] = Stator.reads([Polls])
const { open } = polls
---
<p>{open && <span>{read(polls, (p) => p.count)}</span>}</p>`
    assert.equal(messages(machine).length, 1)
    assert.ok(messages(machine)[0]!.includes('If `open` changes later'))
    assert.ok(messages(machine)[0]!.includes('when(read(polls, (p) => …), …)'))
  })

  it('warns for a choice between components', () => {
    const src = `---
const [auth] = Stator.reads([Auth])
const signedIn = auth.isAuthenticated
---
<header>{signedIn ? <Account auth={auth} /> : <SignIn />}</header>`
    assert.equal(messages(src).length, 1)
    assert.ok(messages(src)[0]!.includes('when(read(auth, (a) => a.isAuthenticated), …)'))
  })

  it('warns for a handle read written straight into the test', () => {
    const src = `---
const [auth] = Stator.reads([Auth])
---
<header>{auth.isAuthenticated && <b>{read(auth, (a) => a.name)}</b>}</header>`
    assert.equal(messages(src).length, 1)
    assert.ok(messages(src)[0]!.includes('If `auth` changes later'))
    assert.ok(messages(src)[0]!.includes('when(read(auth, (a) => a.isAuthenticated), …)'))
  })

  it('warns in a component for a prop the template passes to read()', () => {
    const src = `---
const { polls, id, title } = Stator.props<{ polls: P; id: string; title?: string }>()
const closed = polls.isClosed(id)
---
<section>
  {title && <h2>{title}</h2>}
  {closed ? <p>Closed</p> : <button on:click={() => polls.send({ type: 'VOTE', id })}>Vote</button>}
  <p>{read(polls, (p) => p.votes(id))}</p>
</section>`
    assert.deepStrictEqual(
      compileWarnings(src).map((w) => w.offset),
      [at(src, 'closed ?')],
    )
  })

  it('reports a chained conditional once, at the outer one', () => {
    const src = `---
const [auth] = Stator.reads([Auth])
const role = auth.role
---
<p>{role === 'admin' ? <Admin /> : role === 'member' ? <Member /> : <Guest />}</p>`
    assert.deepStrictEqual(
      compileWarnings(src).map((w) => w.offset),
      [at(src, "role === 'admin'")],
    )
  })

  it("doesn't follow a test computed by a helper function", () => {
    const src = `---
const [board] = Stator.reads([Board])
const claims = Stator.request.claims()
const isOwner = canEdit(claims)
const hasRows = count(board) > 0
---
<div>
  {isOwner && <Editor board={board} />}
  {hasRows ? <Rows board={board} /> : <Empty />}
  {canEdit(claims) && <Editor board={board} />}
</div>`
    assert.deepStrictEqual(compileWarnings(src), [])
  })

  it("doesn't warn when the arms are static markup, with or without a binding after", () => {
    const src = `---
const [board] = Stator.reads([Board])
const claims = Stator.request.claims()
const empty = board.isEmpty
---
<main>
  {claims ? <a href="/me">Account</a> : <a href="/login">Sign in</a>}
  <p class={empty ? 'muted' : ''}>{empty && <em>Nothing yet</em>}</p>
  <p>{read(board, (b) => b.total)}</p>
  {claims && <footer>Signed in</footer>}
</main>`
    assert.deepStrictEqual(compileWarnings(src), [])
  })

  it("doesn't warn inside a read()-driven arm unless a binding follows it there", () => {
    const last = `---
const [auth, board] = Stator.reads([Auth, Board])
const isAdmin = auth.isAdmin
---
<main>
  {when(read(board, (b) => b.open), () => (
    <section>
      <p>{read(board, (b) => b.total)}</p>
      {isAdmin && <Tools board={board} />}
    </section>
  ))}
  <p>{read(board, (b) => b.title)}</p>
</main>`
    assert.deepStrictEqual(compileWarnings(last), [])

    const followed = last.replace(
      '    </section>',
      '      <p>{read(board, (b) => b.note)}</p>\n    </section>',
    )
    assert.deepStrictEqual(
      compileWarnings(followed).map((w) => w.offset),
      [at(followed, 'isAdmin &&')],
    )

    const matched = `---
const [auth, board] = Stator.reads([Auth, Board])
const isAdmin = auth.isAdmin
---
{match(read(board, (b) => b.phase), {
  open: () => <div>{isAdmin ? <Tools board={board} /> : null}</div>,
  closed: () => <p>{read(board, (b) => b.total)}</p>,
})}`
    assert.deepStrictEqual(compileWarnings(matched), [])
  })

  it('warns inside an arm that is not driven by a read()', () => {
    const src = `---
const [auth, board] = Stator.reads([Auth, Board])
const isAdmin = auth.isAdmin
const wide = Stator.request.query.wide === '1'
---
{when(wide, () => <div>{isAdmin ? <Tools board={board} /> : null}</div>)}`
    assert.deepStrictEqual(
      compileWarnings(src).map((w) => w.offset),
      [at(src, 'isAdmin ?')],
    )
  })

  it("doesn't warn where a parameter or local hides the frontmatter name", () => {
    const src = `---
const [board] = Stator.reads([Board])
const row = board.first
---
<ul>
  {each(read(board, (b) => b.rows), (row) => (row ? <Row row={row} /> : null))}
  {read(board, (b) => {
    const row = b.rows[0]
    return row ? row.title : ''
  })}
</ul>`
    assert.deepStrictEqual(compileWarnings(src), [])
  })

  it("doesn't warn for a test on a request value, a prop, or an each item", () => {
    const src = `---
const [board] = Stator.reads([Board])
const tab = Stator.request.query.tab
const { compact } = Stator.props<{ compact?: boolean }>()
---
<div>
  {tab === 'all' ? <All board={board} /> : <Mine board={board} />}
  {compact && <Summary board={board} />}
  {each(read(board, (b) => b.rows), (r) => (r.done ? <Done row={r} /> : <Open row={r} />))}
</div>`
    assert.deepStrictEqual(compileWarnings(src), [])
  })

  it("doesn't warn in an island, whose reads are client reads", () => {
    const src = `---
const [board] = Stator.reads([Board])
const empty = board.isEmpty
---
<my-list>{empty ? <p>{read(rows, (r) => r.label)}</p> : <button on:click={add}>Add</button>}</my-list>
<script>
export class MyList extends StatorElement {
  rows = this.use(Rows)
  add() {}
}
</script>`
    assert.deepStrictEqual(compileWarnings(src), [])
  })

  it('keeps positions exact past a doctype, a comment and an inline script', () => {
    const src = `---
const [auth] = Stator.reads([Auth])
const uid = auth.userId
---
<!doctype html>
<html>
  <head>
    <!-- theme: {before paint} -->
    <script is:inline>if (a < b) { document.documentElement.dataset.theme = 'dark' }</script>
  </head>
  <body>
    {uid
      ? <Account auth={auth} />
      : <a href="/login">Sign in</a>}
    {raw('<script>' + uid + '</script>')}
  </body>
</html>`
    const warnings = compileWarnings(src)
    assert.deepStrictEqual(
      warnings.map((w) => [w.offset, w.loc.line, w.loc.column]),
      [
        [at(src, 'uid\n'), 12, 6],
        [at(src, "'<script>' + uid"), 15, 10],
      ],
    )
    assert.ok(warnings[0]!.message.includes('when(read(auth, (a) => a.userId), …)'))
  })
})
