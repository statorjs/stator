---
"@statorjs/stator": minor
---

`createApp` accepts `root`: the directory `.env.local` and `.env` are read from and the base for relative `machinesDir`/`routesDir`/`staticDir`/`middlewareFile`/`bootFile` paths. Before, the programmatic entry loaded `.env` from the process working directory while `stator dev`, `stator start` and the native dev server read it from the app root, so a `server.ts` started from another directory (a service manager's working directory, `node /app/dist/server.js` from `/`) silently ran without its `.env`. The default stays the working directory, so nothing changes for a process started in the app directory.
