---
title: Forms and inputs
description: "The forms pattern: the input owns the draft, the platform guards it, a typed event commits it, and pre-fill is an attribute at render."
sidebar:
  order: 5
---

Stator has no two-way binding. Forms follow one pattern with four moves, and the `registration` starter (`pnpm create stator --template registration`) is the worked example of all of them.

## The input owns the draft

Uncommitted typing is not machine state — nothing else needs to read it, and the browser already gives the draft a home with cursor, IME, and undo handled natively. Guard it with platform constraints, not events:

```astro
<input name="email" type="email" required maxlength="60" />
<input name="seats" type="number" min="1" max="6" value="1" />
```

A constraint prevents bad input outright. A prevented character never needs correcting, so there is nothing to jank.

## A typed event commits it

The commit boundary — submit, Enter, `change` — reads the draft once and sends one event the machine declares:

```astro
<form ref:form on:submit={submit}>…</form>
```

```ts
async submit(e: Event) {
  e.preventDefault()
  const form = this.refs.form as HTMLFormElement
  const result = await dispatch(DeskMachine, {
    type: 'REGISTER',
    name: (form.elements.namedItem('name') as HTMLInputElement).value,
    seats: (form.elements.namedItem('seats') as HTMLInputElement).valueAsNumber,
  })
  if (result.committed) form.reset()
}
```

The machine's guards run server-side and a refusal comes back `committed: false` — the form keeps the visitor's typing. Only your own successful commit clears the field, and `form.reset()` returns it to the server-rendered defaults. That is the safe writeback moment: the framework never writes into a control you are typing in.

## Pre-fill is an attribute at render

An edit form's values are server state, so they arrive as server-rendered attributes — `value` for text and numbers, `checked` for booleans, `selected` for options:

```astro
<input name="name" value={attendee.name} />
<input name="updates" type="checkbox" checked={attendee.updates} />
```

Attributes set a control's *default*, which is exactly right for pre-fill: the state provides the starting point, then the visitor owns the draft. `false`/`null` render the attribute absent, so a checkbox can pre-fill unchecked.

## Live validation is one-way

Per-field feedback is a client machine fed by events and displayed with `read()` — state flows *out* to messages and counters, never back into the control:

```astro
<input name="email" type="email" required on:blur={checkEmail} />
<p role="alert">{read(checks, (c) => c.emailError)}</p>
```

Run the same pure rule functions in the browser for instant feedback and in the machine's guard for enforcement — the server never trusts the client's copy. Truth rules the browser can't answer (duplicates, capacity) live only in the guard. The [registration starter](https://github.com/statorjs/stator/tree/main/examples/registration) shows the full two-tier arrangement.

## What about live input masks?

Formatting-as-you-type (phone masks, currency) is caret-math territory that belongs to a dedicated mask library wired through `ref:`. Machine-side, store the normalized value and format it with a selector wherever it *displays* — the input itself formats on commit, not per keystroke.
