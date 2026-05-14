import {
  html,
  read,
  each,
  when,
  type InstanceOf,
  type HtmlFragment,
} from 'stator/template'
import type AdminMachine from '../machines/admin.ts'
import type ProductsMachine from '../machines/products.ts'

type SessionRow = {
  sid: string
  items: Array<{ productId: string; quantity: number; unitPrice: number }>
  itemCount: number
  total: number
}

export default function adminPage(
  admin: InstanceOf<typeof AdminMachine>,
  products: InstanceOf<typeof ProductsMachine>,
): HtmlFragment {
  return html`<section class="admin">
  <h1>Admin dashboard</h1>
  <p class="admin-hint">Live view of carts across all sessions. Open shopping
    tabs in other windows and watch this page update.</p>

  <div class="admin-metrics">
    <span class="admin-metrics-label">Runtime</span>
    <span class="admin-metric">
      <span class="admin-metric-label">heap</span>
      <span class="admin-metric-value">${read(admin, (a) => a.runtimeMetrics.heapUsedMB)} / ${read(admin, (a) => a.runtimeMetrics.heapTotalMB)} MB</span>
    </span>
    <span class="admin-metric">
      <span class="admin-metric-label">rss</span>
      <span class="admin-metric-value">${read(admin, (a) => a.runtimeMetrics.rssMB)} MB</span>
    </span>
    <span class="admin-metric">
      <span class="admin-metric-label">external</span>
      <span class="admin-metric-value">${read(admin, (a) => a.runtimeMetrics.externalMB)} MB</span>
    </span>
    <span class="admin-metric">
      <span class="admin-metric-label">sse</span>
      <span class="admin-metric-value">${read(admin, (a) => a.runtimeMetrics.activeConnections)} conn</span>
    </span>
    <span class="admin-metric">
      <span class="admin-metric-label">uptime</span>
      <span class="admin-metric-value">${read(admin, (a) => a.runtimeMetrics.uptimeSeconds)}s</span>
    </span>
  </div>

  <div class="admin-aggregates">
    <div class="aggregate">
      <span class="aggregate-label">Active sessions</span>
      <span class="aggregate-value">${read(admin, (a) => a.activeSessionCount)}</span>
    </div>
    <div class="aggregate">
      <span class="aggregate-label">Items in carts</span>
      <span class="aggregate-value">${read(admin, (a) => a.totalItemsInCarts)}</span>
    </div>
    <div class="aggregate">
      <span class="aggregate-label">Total value</span>
      <span class="aggregate-value">$${read(admin, (a) =>
        a.totalValueInCarts.toFixed(2),
      )}</span>
    </div>
  </div>

  <h2>Per-product totals</h2>
  ${when(
    read(admin, (a) => a.totalItemsInCarts > 0),
    () => html`<ul class="product-totals">
      ${each(
        read(products, (p) => p.all as Array<{ id: string; name: string }>),
        (product) => html`<li class="product-total-row">
          <span class="product-total-name">${product.name}</span>
          <span class="product-total-count">${read(
            admin,
            (a) => a.countByProduct[product.id] ?? 0,
          )}</span>
        </li>`,
      )}
    </ul>`,
  )}

  <h2>Sessions</h2>
  ${when(
    read(admin, (a) => a.activeSessionCount === 0),
    () => html`<p class="admin-empty">No active carts. Add an item from the products page.</p>`,
  )}
  <ul class="admin-sessions">
    ${each(
      read(admin, (a) => a.sessionList as SessionRow[]),
      (session) => html`<li class="admin-session">
        <div class="admin-session-head">
          <span class="admin-session-sid">${session.sid.slice(0, 8)}…</span>
          <span class="admin-session-meta">
            ${session.itemCount} item${session.itemCount === 1 ? '' : 's'} ·
            $${session.total.toFixed(2)}
          </span>
        </div>
        <ul class="admin-session-items">
          ${each(
            session.items,
            (item) => html`<li class="admin-session-item">
              <span class="admin-item-name">${(products.byId as any)(item.productId)?.name ?? item.productId}</span>
              <span class="admin-item-qty">×${item.quantity}</span>
              <span class="admin-item-price">$${(item.unitPrice * item.quantity).toFixed(2)}</span>
            </li>`,
          )}
        </ul>
      </li>`,
    )}
  </ul>
</section>`
}
