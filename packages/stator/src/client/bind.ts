import { actorOf, type ClientInstanceBase } from './use.ts'

/**
 * The one client binding mechanism: subscribe to a set of client actors, and on
 * any change re-evaluate a value thunk, diff against the last value, and write
 * the DOM. The client mirror of the server's recompute loop.
 *
 * The compiler generates one `bind()` call per `bind:` directive: it infers the
 * dependency set (the `use()` instances the expression references), passes the
 * expression as the thunk, and supplies the target node + write function.
 *
 * Returns a disposer that unsubscribes.
 */
export function bind(
  deps: ClientInstanceBase[],
  compute: () => unknown,
  apply: (value: unknown) => void,
): () => void {
  let last = compute()
  apply(last)

  const onChange = (): void => {
    const next = compute()
    if (!Object.is(next, last)) {
      last = next
      apply(next)
    }
  }

  const unsubs = deps.map((d) => actorOf(d).subscribe(onChange).unsubscribe)
  return () => {
    for (const u of unsubs) u()
  }
}

/**
 * Text-slot binding for a client-machine `read()` in text position. The
 * compiler renders an `<!--sN-->` comment where the expression sat; this finds
 * every occurrence of the marker under `root` (a marker inside a `.map()`
 * repeats per row), materializes one text node after each, and binds them all
 * to the thunk through the normal `bind()` diff loop. Returns a disposer.
 */
export function bindSlot(
  root: Node,
  marker: string,
  deps: ClientInstanceBase[],
  compute: () => unknown,
): () => void {
  // Manual walk, not TreeWalker: happy-dom's walker prunes descent at
  // non-matching nodes, so a SHOW_COMMENT filter never reaches nested comments
  // — and the manual loop is as small as the workaround discussion.
  const texts: Text[] = []
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const n = stack.pop() as Node
    if (n.nodeType === 8 /* COMMENT_NODE */ && (n as Comment).data === marker) {
      const t = document.createTextNode('')
      n.parentNode?.insertBefore(t, n.nextSibling)
      texts.push(t)
    } else {
      for (let c = n.firstChild; c; c = c.nextSibling) stack.push(c)
    }
  }
  return bind(deps, compute, (v) => {
    const s = v == null ? '' : String(v)
    for (const t of texts) if (t.data !== s) t.data = s
  })
}

/**
 * Imperative reactivity escape hatch: run `fn` now and again whenever any
 * dependency changes (no diffing — `fn` owns its own DOM writes). The lower-
 * level primitive `{key}Changed` desugars to. Returns a disposer.
 */
export function effect(deps: ClientInstanceBase[], fn: () => void): () => void {
  fn()
  const unsubs = deps.map((d) => actorOf(d).subscribe(fn).unsubscribe)
  return () => {
    for (const u of unsubs) u()
  }
}
