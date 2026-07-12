# TodoMVC · Stator

The [TodoMVC](https://todomvc.com) app, the Stator way — official stylesheet,
canonical behavior, and a state story most implementations can't tell:

- **Reload the page. Your todos are still there.** No localStorage, no sync —
  the list lives in a session machine on the server, which is its natural home.
- **`machines/todos.ts` is the entire app logic**, UI-blind and unit-tested
  (`pnpm test`, no browser needed).
- **Filters are links** (`/?filter=active`) — URL state, not router state.
- **In-place editing with zero client JavaScript**: double-click dispatches
  `EDIT_START`, the row's *server* state flips it to a form, Enter submits it
  as a plain form POST. View source on the wire inspector while you do it.
- The one place client state belongs — the draft you're typing — is a tiny
  island (`templates/todo-input.stator`): keystrokes stay local, Enter commits
  one typed event to the server.

```sh
pnpm install
pnpm dev        # live reload + the wire inspector
pnpm test       # the machine's rules, at unit speed
pnpm build && pnpm start   # production
```

Docs: https://docs.statorjs.dev · Reference app: https://demo.statorjs.dev
