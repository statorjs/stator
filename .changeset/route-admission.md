---
"@statorjs/stator": patch
---

A middleware guard on a page now covers that page's events and live updates. `/__events` and `/__sse` name the page they act on in a header and a query parameter, so a guard written against the request path (`c.req.path.startsWith('/members')`, as the middleware guide shows) only ever saw `/__events` or `/__sse`: a caller redirected from a gated live page could still connect to its stream and receive its content and every later update, and have the page rendered for an event. Before either endpoint touches a page, the framework now asks the app's middleware whether it would admit the caller to a `GET` of that page. A redirect becomes a `navigate` directive on the event response and a refusal is passed through; the stream is refused. The app's handlers run a second time for these requests, against the page's path; an app with no handlers of its own is unaffected.
