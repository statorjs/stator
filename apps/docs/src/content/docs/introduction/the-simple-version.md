---
title: The simple version
description: "Stator explained without framework vocabulary: your page matches your database, with fewer places for things to break."
sidebar:
  order: 2
---

This page explains Stator without framework vocabulary. If you already think in components, hooks, and hydration, you may prefer [What is Stator?](/introduction/what-is-stator/) — it makes the same case in that language. Both pages describe the same thing.

## The one-sentence version

Your data lives in a database on the server. Stator renders your page where the data lives, and keeps the page matching it.

## The problem it removes

Most web apps today are two programs. There's a server program that owns the data, and a browser program that redraws the screen. Between them sits glue: API endpoints, fetch calls, JSON parsing, loading spinners, and client-side copies of data that go stale the moment someone else changes something.

Most bugs live in the glue. The page shows the old value. The spinner never stops. Two parts of the screen disagree about what's true.

Stator is one program. The server owns the data *and* renders the page. When data changes, the browser doesn't re-ask the server what's true — the server sends a tiny note: "change this bit." Just the number that changed, or the one new row. Nothing else moves.

There is no client-side copy of your data. Which means there is no client copy to go stale, no cache to invalidate, and no loading state to manage. That's not a discipline you have to maintain — it's a whole category of work, and of bugs, that isn't there.

## What writing it feels like

You write two things. The rules for your data, and what the page looks like.

The rules live in one file. Stator calls this a **machine** — it's your data plus the list of events that are allowed to change it:

```ts
export default defineMachine({
  name: 'NotesMachine',
  lifecycle: 'session',
  events: {} as { type: 'ADD'; text: string },
  context: { notes: [] as string[] },
  initial: 'ready',
  states: {
    ready: {
      on: {
        ADD: (ctx, ev) => {
          ctx.notes.push(ev.text)
        },
      },
    },
  },
  selectors: { all: (ctx) => ctx.notes },
})
```

The page reads from it. `read()` marks the parts that stay live:

```astro
---
import Notes from '../machines/notes.ts'

const [notes] = Stator.reads([Notes])
---

<ul>
  {each(read(notes, (n) => n.all), (note) => <li>{note}</li>)}
</ul>
<button on:click={() => notes.send({ type: 'ADD', text: 'hello' })}>
  Add a note
</button>
```

That's the whole app. Clicking the button sends the `ADD` event to the server, the machine updates, and the list on your page grows by one row. You wrote no fetch call, no endpoint, no JSON handling, and no code to update the screen.

## The part that feels like magic

Because the server owns the page, it can update *everyone's* page. Open our [live poll example](https://github.com/statorjs/stator/tree/main/examples/live-poll) in two browser windows and vote in one. The other window's bars move by themselves. You write no code for that either — the server knows what changed and tells every open page.

## What's the catch

Honest answer: every interaction is a round trip to the server. On a normal connection that's fast enough that you won't notice for most apps — forms, lists, dashboards, anything where the data is the point. For the few things that must respond instantly with no network at all (a theme toggle, a drawing canvas), Stator lets a small piece of the page run in the browser — but you reach for that deliberately, when you need it. Most pages need none.

And Stator is young. It's released and stable in its foundations, and we're still sanding the rough edges of an approach this different.

## Where to go next

- [Quick start](/introduction/quick-start/) — running in a few minutes with `pnpm create stator`
- [What is Stator?](/introduction/what-is-stator/) — the same ideas, in framework terms, with comparisons to React, Astro, and LiveView
