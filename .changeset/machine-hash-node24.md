---
'@statorjs/stator': minor
---

Machine hashes are measured for a `node24` target, matching the Node floor. A machine whose code uses syntax esbuild rewrote for Node 20 (an import attribute, for example) gets a new hash, and its persisted sessions start fresh once on upgrade. Most machines hash the same as before. `server/machine-hash.ts` is part of the engine hash, so this release resets persisted sessions once in any case; it lands in the same release as the other engine changes, so that is still one reset.
