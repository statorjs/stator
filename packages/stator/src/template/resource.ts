export type ResourceStatus = 'pending' | 'fulfilled' | 'rejected'

/**
 * A peekable async value. You cannot synchronously read a native promise's
 * settled state (`.then` is always a microtask), so `defer` wraps a thunk's
 * result in a resource that records its settlement as it happens — letting the
 * fill pass read `status` synchronously ("peek") at the moment it splices HTML.
 *
 * A non-promise thunk result fulfills immediately, so `defer` degrades to plain
 * inline render for synchronous data.
 */
export interface Resource<T = unknown> {
  readonly status: ResourceStatus
  readonly value?: T
  readonly reason?: unknown
  /**
   * Resolves when the resource settles (fulfilled OR rejected). Never rejects —
   * a rejection is recorded as `status: 'rejected'` + `reason`, and `settled`
   * still resolves, so the resolve phase can `await` a batch of resources with a
   * plain `Promise.all` and never has to catch.
   */
  readonly settled: Promise<void>
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  )
}

/**
 * Wrap a thunk's result in a peekable {@link Resource}. Synchronous values (and
 * synchronous throws) settle immediately; a promise records its settlement on a
 * single attached continuation.
 */
export function createResource<T>(produce: () => T | Promise<T>): Resource<T> {
  let result: T | Promise<T>
  try {
    result = produce()
  } catch (reason) {
    // A thunk that throws synchronously is a rejected resource, not a crash.
    return { status: 'rejected', reason, settled: Promise.resolve() }
  }

  if (!isPromiseLike(result)) {
    return { status: 'fulfilled', value: result, settled: Promise.resolve() }
  }

  const resource: {
    status: ResourceStatus
    value?: T
    reason?: unknown
    settled: Promise<void>
  } = { status: 'pending', settled: Promise.resolve() }

  resource.settled = Promise.resolve(result).then(
    (value) => {
      resource.status = 'fulfilled'
      resource.value = value
    },
    (reason) => {
      resource.status = 'rejected'
      resource.reason = reason
    },
  )

  return resource
}
