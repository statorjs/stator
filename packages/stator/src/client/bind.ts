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
