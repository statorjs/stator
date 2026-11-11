---
title: Client components
description: "Whole-file custom elements: StatorElement, use(), machine(), attrs, refs, and seeds."
sidebar:
  order: 4
---

A client component is a whole `.stator` file that compiles to a custom element running in the browser. Reach for one when state should stay [client-side](/concepts/server-client-boundary/) — instant, local, no round trip.

## Define an island

The root is a custom element; the `<script>` exports a name-matched `StatorElement` subclass:

```astro
<theme-toggle>
  <button on:click={toggle}>{read(theme, (t) => t.label)}</button>
</theme-toggle>

<script>
  const Theme = machine(
    { mode: 'light' },
    {
      on: { TOGGLE: (s) => { s.mode = s.mode === 'light' ? 'dark' : 'light' } },
      select: { label: (s) => s.mode === 'dark' ? '☾' : '☀' },
    },
  )

  export class ThemeToggle extends StatorElement {
    theme = use(Theme)
    toggle() { this.theme.send('TOGGLE') }
  }
</script>
```

`<theme-toggle>` ↔ `ThemeToggle` must match.

## The server fence

An island file may open with a `---` fence, just like a server component — and it behaves exactly like one: it runs **on the server, per shell render**, and its bindings are in scope for the template. The `<script>` never sees it, in either direction — fence bindings are not client globals, and script members are not fence scope. Three regions, two worlds, one file:

```astro
---
// server: runs per shell render, never ships to the browser
import { TICKETS } from '../lib/rules.ts'
---
<reg-form>
  <select name="ticket">
    {TICKETS.map((t) => <option value={t}>{t}</option>)}
  </select>
  <button on:click={submit}>register</button>
</reg-form>

<script>
  // browser: hydrates onto the server-rendered shell
  export class RegForm extends StatorElement {
    submit() { /* … */ }
  }
</script>
```

The rule of thumb: **fences are for server work the island owns; per-use data stays props.** A catalog the form always renders, a computed constant, a DB query — fence. A per-visitor pre-fill value or a parent's `read()` — prop, because it varies by use site.

Because the fence runs per shell render, an island placed three times runs its fence three times, and a server re-render containing the island re-runs it — identical to a server component's frontmatter.

### Typing the shell's props

An island's attributes are declared by `static attrs`. Everything else its use site passes is a prop of the shell: it renders on the server and never reaches the browser. Left undeclared, those props are open, so any prop is accepted and none is checked. Declare them in the fence with `Stator.props`, as a server component does:

```astro
---
import type { Colorway } from '../lib/catalog.ts'

const { colorways } = Stator.props<{ colorways: Colorway[] }>()
---
<variant-picker>
  {colorways.map((c) => <label title={c.label}>{c.value}</label>)}
</variant-picker>

<script>
  export class VariantPicker extends StatorElement {
    static attrs = { unitPrice: Number }
  }
</script>
```

The island's props are then that type plus its attrs, and closed: `<VariantPicker colorwys={…} />` is a type error, and so is a missing `colorways`. The two declarations stay separate on purpose. `static attrs` is what crosses to the browser; the fence type is what only the shell needs. To destructure an attr in the fence, name it in the type as well.

A type the fence declares or imports with `import type` can be used in the `<script>`: types erase, so nothing follows them into the bundle. A fence *value* cannot, and the compiler says so, naming it.

Three guardrails, all compile errors:

- **Route-only markers stay route-only.** `Stator.reads`, `Stator.request`, and `Stator.response` are rejected in an island's fence, as in any component.
- **No fence values in the `<script>`.** The fence runs on the server and the script in the browser. Import the module in the script too, or hand the value over as an attribute.
- **No name collisions with `use()` fields.** A fence `const theme = …` alongside a `theme = use(Theme)` field is ambiguous by construction — the template couldn't tell the server value from the client machine — so the compiler makes you rename one.

## machine() and use()

`machine(context, behavior?)` defines a small client machine inline — plain data first, then `on` (events) and `select` (derived values). The split is what makes the types work: handlers and selectors see the context fully typed (`s.mode` above is a `string`), and `use(Def, seed?)` returns an instance whose context keys and selector results are real typed properties — `this.theme.mode` and `this.theme.label` type-check like anything else.

Events are typed in three tiers:

- **No `on` map** — a data-only machine accepts nothing: its context is set at construction and read for display, and `send` is a compile error.
- **An `on` map** — the event NAMES derive from its keys, so `send('TOGLE')` is a compile error. Payloads stay open.
- **A declared union** — `events: {} as E` mirrors `defineMachine` for full payload typing, with each handler narrowed to its own event:

```ts
const Checks = machine(
  { emailError: null as string | null },
  {
    events: {} as { type: 'CHECK'; value: string } | { type: 'RESET' },
    on: {
      CHECK: (s, e) => { s.emailError = emailError(e.value) }, // e.value: string
      RESET: (s) => { s.emailError = null },
    },
  },
)
```

### Machines with real states

`machine()` has one implicit state. When an island needs a real chart (named states, `to` transitions), define it with `defineMachine` in its own module and pass the import to `use()`:

```ts
// lib/wizard.ts
import { defineMachine } from '@statorjs/stator/machine'

export default defineMachine({
  name: 'Wizard',
  lifecycle: 'session',
  events: {} as { type: 'NEXT' } | { type: 'BACK' },
  context: { answers: [] as string[] },
  initial: 'intro',
  states: {
    intro: { on: { NEXT: { to: 'details' } } },
    details: { on: { BACK: { to: 'intro' } } },
  },
  selectors: { answered: (ctx) => ctx.answers.length },
})
```

```astro
<script>
  import Wizard from '../lib/wizard.ts'

  export class SetupWizard extends StatorElement {
    wizard = use(Wizard)
    next() { this.wizard.send({ type: 'NEXT' }) }
  }
</script>
```

Passing the import to `use()` is what puts the machine's code in the island's bundle; see [running a machine, or addressing one](/concepts/server-client-boundary/#running-a-machine-or-addressing-one). It is an ordinary machine module, written like any other, and the same file tests in Node with `createActor`. Keep it [portable](/concepts/state-machines/#capabilities): a machine that reads another machine fails the build when an island runs it.

The handle carries the current state's name as `state`, typed to the machine's state names: `read(wizard, (w) => w.state === 'details')`. A `machine()` handle has it too (always `'active'`), unless the context or a selector is itself named `state`.

A reusable machine is a function that returns one. Each call gives a machine its own name, which is what lets the server register several:

```ts
// lib/toggle.ts
export const makeToggle = (name: string) =>
  defineMachine({
    name,
    lifecycle: 'session',
    events: {} as { type: 'TOGGLE' },
    context: { on: false },
    initial: 'idle',
    states: { idle: { on: { TOGGLE: (ctx) => { ctx.on = !ctx.on } } } },
    selectors: {},
  })
```

```astro
<script>
  import { makeToggle } from '../lib/toggle.ts'
  const Menu = makeToggle('Menu')

  export class NavMenu extends StatorElement {
    menu = use(Menu)
  }
</script>
```

### Eager vs deferred seeds

The optional seed sets initial context. Pass a **plain object** for static values, or a **thunk** when the seed reads `this.attrs` or the browser (these aren't available at field-construction; a thunk defers to connect):

```js
qty = use(Qty, () => ({ unitPrice: this.attrs.unitPrice }))
```

## this.attrs

Declare an attribute surface with a static coercer map. Author names are camelCase ↔ kebab DOM attrs; `Boolean` is a presence flag:

```js
static attrs = { unitPrice: Number, selected: Boolean }
// reads <… unit-price="12" selected>
```

`this.attrs` is typed from that map, with nothing else to write: `this.attrs.unitPrice` is `number | undefined` (an absent attribute reads as `undefined`), `this.attrs.selected` is `boolean`, a custom coercer gives its return type, and an attribute you did not declare is a type error.

## this.refs

Elements marked [`ref:name`](/guides/directives/#ref--element-handles) are reachable as `this.refs.name`.

## Lifecycle

Machine [actors](/concepts/state-machines/#definition-actor-instance) start on `connectedCallback` and stop on disconnect. Client-machine `read()`s and `effect()` subscribe to state and write the DOM natively — no client re-render.

### Before the island connects

The shell is server HTML, and a client machine does not exist on the server, so a client `read()` renders nothing there: empty text, and no attribute. On a cached page that is the first paint, and with scripting off it is the only one. Give the read a third argument and the shell renders that until the island connects:

```astro
<cart-button count={props.count}>
  <button on:click={open}>Cart ({read(cart, (c) => c.count, props.count)})</button>
  <p hidden={read(cart, (c) => c.count > 0, props.count > 0)}>Your cart is empty.</p>
</cart-button>
```

The fallback is an ordinary shell expression, evaluated once on the server: a literal, a prop, a fence value. It cannot read a client machine. On connect the read replaces it with the machine's value, so make the two agree, usually by seeding the machine from the same prop the fallback uses.

## Islands are leaves

Islands are also the only code Stator bundles, and there is no bundler plugin to configure — by design. Tailwind, global CSS, images, and WASM are handled outside the bundler so they apply to the whole app, not just the island tier: see [Styling and assets](/guides/styling-and-assets/).

An island's markup is its own template — server-rendered content does not flow *through* it, and that's a deliberate boundary (like early Astro shipping without SSR: a known edge, owned). Four sanctioned channels cover composition with the server:

1. **Live attrs in.** Pass a `read()` as an island prop and the attribute becomes a live server binding. Declared attrs are observed: implement `${key}Changed(next)` and every patch lands there, coerced per your `static attrs` declaration.

   ```astro
   <stock-badge stock={read(inventory, (i) => String(i.stock[sku]))} />
   ```

   ```js
   static attrs = { stock: Number }
   stockChanged(next) { this.render(next) }
   ```

2. **`dispatch` out.** The one visible boundary crossing (below).

3. **Observing server-owned DOM.** For regions the server keeps fresh *outside* the island, plain platform tools (`querySelector`, `MutationObserver`) are legitimate — islands are custom elements. Prefer channel 1 when the data can arrive as an attr.

4. **Server-rendered sections (the adopt pattern).** Island templates may contain server-evaluated expressions — props-driven maps with nested JSX, even a full component render passed as a prop. The shell renders them per use; the class adopts them by querying:

   ```astro
   <div class="opts" ref:opts>
     {props.options.map((o) => <button class="opt" data-id={o.id}>{o.label}</button>)}
   </div>
   ```

   ```js
   connectedCallback() {
     super.connectedCallback()
     for (const b of this.querySelectorAll('.opt')) {
       b.addEventListener('click', () => this.pick(b.dataset.id))
     }
   }
   ```

   Note: `on:` directives and client-machine `read()`s don't reach inside these server sections — wiring happens in the class, which is the point of the pattern.

## Committing to the server

To change *server* state from an island, dispatch to a server machine:

```js
const result = await dispatch(CartMachine, { type: 'ADD_ITEM', productId: id })
```

`dispatch` resolves `{ ok, committed, patchCount }` — three different facts. `ok` is transport; **`committed`** is whether the event actually transitioned a machine (a guard-dropped event is `ok && !committed`); `patchCount` is how many patches landed on *this* page. Buttons that announce success should look at `committed`.
