---
'@statorjs/stator': patch
---

A Stator release no longer resets every session. The machine code hash took the package version as an input, so every release — 2.14.0 changed only the template splitter — discarded every persisted machine snapshot in every app. The input is now a hash of the engine and the actor host (the modules that build actors, hydrate and persist snapshots, and run effects and timers), measured from the installed framework's own files the same way machines are. A release that touches only the compiler, CLI, renderer, dev servers or editor tooling leaves sessions alone; one that changes the engine resets them, as before. Upgrading to this release resets sessions once, because the digest formula changed.
