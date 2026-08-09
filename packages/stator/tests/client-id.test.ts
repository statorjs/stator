// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

/**
 * The page-load identity must be a PAGE singleton, not a module-instance
 * value: the page runtime and island modules are separate bundles, each with
 * its own copy of client-id.ts. Two copies disagreeing means SSE fan-out
 * never recognizes the dispatching page's own connection, and keyed inserts
 * double-apply there (the registration starter's duplicate-row bug).
 * `vi.resetModules` simulates the second bundle: a fresh module instance in
 * the same window must yield the SAME id.
 */
describe('clientId', () => {
  it('is stable across module instances within one page', async () => {
    const first = (await import('../src/client/client-id.ts')).clientId
    vi.resetModules()
    const second = (await import('../src/client/client-id.ts')).clientId
    expect(second).toBe(first)
    expect((window as { __statorClientId?: string }).__statorClientId).toBe(first)
  })

  it('newEventId stays unique per call', async () => {
    const { newEventId } = await import('../src/client/client-id.ts')
    expect(newEventId()).not.toBe(newEventId())
  })
})
