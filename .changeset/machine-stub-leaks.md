---
"@statorjs/stator": patch
---

An island that only dispatches to a machine no longer ships the machine's code when the import is written in certain ways. Each of these put the whole machine module, and everything it imports, into the browser bundle of a dispatch-only island:

- a tsconfig `paths` alias or a package `imports` entry (`import Cart from '@app/machines/cart.ts'`), which the stub rule never looked at;
- a `.js` specifier for a `.ts` machine outside `machines/`;
- a type imported beside the machine without the `type` keyword (`import Cart, { CartEvents } from …`), which was read as needing the module;
- a parameter or block-scoped local with the import's name, which was read as the import.

A literal secret in a module the machine imports went with it. The decision is now made on the file the bundler itself resolves, whatever the specifier; a named import counts only when it is read as a value; and a nested binding with an import's name is its own. A `.js` specifier for a machine in `machines/` also builds now, where it failed.

The first two predate 3.0. The last two came with the by-use-site rule in 3.0.0-next.6.
