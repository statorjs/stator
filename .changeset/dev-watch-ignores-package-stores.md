---
'@statorjs/stator': patch
---

The Vite dev server (`STATOR_VITE_DEV=1`, which in-process test harnesses use) no longer watches dot directories, dependencies, build output or tests, matching the native dev server. An in-project package store such as `.pnpm-store`, which pnpm creates inside the project in CI containers, used to be watched file by file and could exhaust the host's inotify watches (`ENOSPC: System limit for number of file watchers reached`).
