// The few test conveniences Node's runner does not ship, kept local so the
// suite needs no assertion or mocking library: retry-until-passing, global
// stubs with a restore, and an async timer advance that lets promise
// callbacks run between timer firings (node's `mock.timers.tick` is sync).
import { mock } from 'node:test'

/** Retry `check` until it stops throwing, or rethrow its last error. */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeout = 1000, interval = 20 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      return await check()
    } catch (err) {
      if (Date.now() >= deadline) throw err
      await new Promise((r) => setTimeout(r, interval))
    }
  }
}

const stubbed = new Map<string, PropertyDescriptor | undefined>()

/** Replace a global for this test; `unstubAllGlobals` puts it back. */
export function stubGlobal(name: string, value: unknown): void {
  if (!stubbed.has(name)) stubbed.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

export function unstubAllGlobals(): void {
  for (const [name, desc] of stubbed) {
    if (desc) Object.defineProperty(globalThis, name, desc)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  stubbed.clear()
}

/** Install mocked timers (setTimeout, setInterval, Date). */
export function useFakeTimers(): void {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
}

/** Advance mocked time by `ms`, in small steps, flushing pending promise
 *  callbacks after each, so a timer that resolves a promise which schedules
 *  the next timer behaves as it would in real time. */
export async function advanceTimersAsync(ms: number, step = 10): Promise<void> {
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  await flush()
  for (let done = 0; done < ms; done += step) {
    mock.timers.tick(Math.min(step, ms - done))
    await flush()
  }
}
