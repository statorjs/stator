// Native-dev fixture: a module with a top-level side effect. Importer-only
// invalidation must NOT re-run it when an unrelated file changes — think of a
// `lib/db.ts` opening a connection — and MUST re-run it when it changes.
export const instanceId = Math.random().toString(36).slice(2)
