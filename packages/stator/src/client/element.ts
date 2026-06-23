import { pushCollector, popCollector } from './use.ts'
import type { Actor } from '../engine/index.ts'

const ACTORS = Symbol('stator.actors')
const DISPOSERS = Symbol('stator.disposers')

/** camelCase author name → kebab DOM attribute (`unitPrice` → `unit-price`). */
function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
}

/**
 * Base class for a client island. The author writes
 * `export class QuantityStepper extends StatorElement { ... }`; the compiler
 * registers it (via `defineElement`) against the kebab-case tag.
 *
 * Lifecycle: on connect, start the actors created by `use()` during
 * construction and run the element's `setup()` (where the compiler emits the
 * `bind()` / `on:` wiring); on disconnect, dispose bindings and stop actors.
 * Element lifetime owns actor lifetime — full-page navigation resets client
 * state, which is the intended default for ephemeral UI.
 */
export class StatorElement extends HTMLElement {
  /** @internal — actors collected during construction (set by `defineElement`). */
  [ACTORS]: Actor<any, any>[] = [];
  /** @internal — binding disposers registered during setup. */
  [DISPOSERS]: Array<() => void> = []

  /** Named handles to `ref:`-marked elements within this island, resolved
   *  lazily by `data-ref`. `this.refs.btn` → the nearest `[data-ref="btn"]`. */
  get refs(): Record<string, HTMLElement> {
    const self = this
    return new Proxy(
      {},
      {
        get(_t, name: string) {
          return self.querySelector(`[data-ref="${name}"]`) as HTMLElement | null
        },
      },
    ) as Record<string, HTMLElement>
  }

  /** Read + coerce a single attribute by its literal name (raw escape hatch for
   *  dynamic / undeclared attributes). */
  attr<T = string>(name: string, coerce?: (raw: string) => T): T | undefined {
    const raw = this.getAttribute(name)
    if (raw === null) return undefined
    return coerce ? coerce(raw) : (raw as unknown as T)
  }

  /** Typed, coerced view of the element's declared attributes.
   *
   *  `static attrs = { unitPrice: Number, selected: Boolean }` declares the
   *  surface; `this.attrs.unitPrice` reads the kebab DOM attribute (`unit-price`)
   *  and coerces it. `Number`/parse coercers run on the string; `Boolean` is
   *  treated as a presence flag (attribute present → true). camelCase author name
   *  ↔ kebab DOM attribute is framework-managed. */
  get attrs(): Record<string, unknown> {
    const decl = (this.constructor as { attrs?: Record<string, (raw: string) => unknown> }).attrs
    const self = this
    return new Proxy(
      {},
      {
        get(_t, prop: string) {
          const coerce = decl?.[prop]
          const attrName = camelToKebab(prop)
          if (coerce === (Boolean as unknown)) {
            return self.hasAttribute(attrName)
          }
          const raw = self.getAttribute(attrName)
          if (raw === null) return undefined
          return coerce ? coerce(raw) : raw
        },
      },
    )
  }

  /** Register a disposer to run on disconnect (used by generated bind wiring). */
  protected track(dispose: () => void): void {
    this[DISPOSERS].push(dispose)
  }

  /** Overridden by the compiler-generated subclass: wires bindings + listeners.
   *  Runs after actors start, on connect. */
  protected setup(): void {}

  connectedCallback(): void {
    for (const actor of this[ACTORS]) actor.start()
    this.setup()
  }

  disconnectedCallback(): void {
    for (const dispose of this[DISPOSERS]) dispose()
    this[DISPOSERS] = []
    for (const actor of this[ACTORS]) actor.stop()
  }
}

/**
 * Register a client-island class against its custom-element tag. Brackets
 * construction so `use()` calls (which run as field initializers during
 * construction) are collected onto the instance for lifecycle management.
 *
 * The compiler emits `defineElement(QuantityStepper, 'quantity-stepper')`.
 */
export function defineElement(UserClass: typeof StatorElement, tag: string): void {
  const Wrapped = class extends UserClass {
    constructor() {
      const bucket = pushCollector()
      try {
        super()
      } finally {
        popCollector()
      }
      ;(this as any)[ACTORS] = bucket
    }
  }
  if (!customElements.get(tag)) customElements.define(tag, Wrapped)
}
