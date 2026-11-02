/**
 * What the dev servers never watch: dependencies, build output, tests, and any
 * dot-prefixed segment (VCS and config dirs, editor temp files, and a package
 * manager's in-project store such as `.pnpm-store`). Shared by the native
 * watcher and the Vite one, so neither descends a tree that isn't app source.
 * A store inside the project is common in containers, where pnpm puts it on
 * the project's filesystem; watching its files exhausts the host's inotify
 * watches.
 */
const PRUNE_DIR = /(^|\/)(node_modules|dist|tests|test|__tests__)(\/|$)/
const DOT_SEGMENT = /(^|\/)\.[^/]+/

/** True for a root-relative, `/`-separated path the dev watcher skips. */
export function isPrunedDevPath(rel: string): boolean {
  return PRUNE_DIR.test(rel) || DOT_SEGMENT.test(rel)
}
