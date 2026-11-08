---
"@statorjs/stator": major
---

`stator test` runs Node's built-in test runner instead of Vitest. Tests use `node:test` and `node:assert/strict`, with `mock.fn`, `mock.method` and `mock.timers` for spies and fake timers, so an app installs nothing to test. Every `*.test.ts` and `*.spec.ts` under the app runs, each file in its own process; arguments pass through (`stator test --watch`, `stator test tests/cart.test.ts`). A file that needs browser globals puts `// @env happy-dom` on its own line and keeps happy-dom as a dev dependency; no other file sees a DOM. Wire tests boot the dev app in-process with no Vite and no `STATOR_VITE_DEV`. The preload is exported as `@statorjs/stator/test-env` for runs outside the CLI.

Migrating: replace `import { describe, it, expect, vi } from 'vitest'` with `node:test` and `node:assert/strict` imports (`expect(a).toBe(b)` → `assert.equal(a, b)`, `toEqual` → `assert.deepStrictEqual`, `toMatchObject` → `assert.partialDeepStrictEqual`, `toThrow` → `assert.throws`, `vi.fn` → `mock.fn`, `vi.spyOn(o, 'm')` → `mock.method(o, 'm')`, fake timers → `mock.timers`), rename `beforeAll`/`afterAll` to `before`/`after`, and change a `@vitest-environment happy-dom` comment to `// @env happy-dom`. Vitest's `toEqual` ignored keys whose value is `undefined`; `deepStrictEqual` does not.
