---
"@statorjs/stator": major
---

Stator declares `engines: { node: ">=24" }`, the current LTS. 2.x promised no Node floor for the runtime; 3.0 stands on Node's own test runner, assertion and mock APIs, and TypeScript stripping (`stator test` runs `node --test`), so the floor is now stated where package managers can check it.
