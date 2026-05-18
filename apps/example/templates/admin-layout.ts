import { html, type HtmlFragment } from '@statorjs/stator/template'
import baseLayout from './base-layout.ts'

/**
 * Admin layout: no machine dependencies. The admin UI doesn't show a cart
 * count in its chrome, so this layout doesn't pull CartMachine into the
 * runtime's hydration set the way customer-layout does. Cleanly separates
 * "what the admin viewer needs to see" from "what shoppers need to see."
 */
export default function adminLayout(body: HtmlFragment): HtmlFragment {
  const header = html`<header class="site-header site-header--admin">
      <a href="/admin" class="brand">stator demo · admin</a>
      <nav>
        <a href="/">← Back to shop</a>
      </nav>
    </header>`
  return baseLayout(header, body)
}
