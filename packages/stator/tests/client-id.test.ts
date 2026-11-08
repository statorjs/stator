// @env happy-dom
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * The page-load identity must be a PAGE singleton, not a module-instance
 * value: the page runtime and island modules are separate bundles, each with
 * its own copy of client-id.ts. Two copies disagreeing means SSE fan-out
 * never recognizes the dispatching page's own connection, and keyed inserts
 * double-apply there (the registration starter's duplicate-row bug).
 * A second import under a query string simulates the second bundle: a fresh module instance in
 * the same window must yield the SAME id.
 */
describe('clientId', () => {
  it('is stable across module instances within one page', async () => {
    const first = (await import('../src/client/client-id.ts')).clientId
    // A different specifier is a different module instance to Node's loader.
    const specifier = '../src/client/client-id.ts?second-bundle'
    const second = ((await import(specifier)) as { clientId: string }).clientId
    assert.equal(second, first)
    assert.equal((window as { __statorClientId?: string }).__statorClientId, first)
  })

  it('newEventId stays unique per call', async () => {
    const { newEventId } = await import('../src/client/client-id.ts')
    assert.notEqual(newEventId(), newEventId())
  })
})
