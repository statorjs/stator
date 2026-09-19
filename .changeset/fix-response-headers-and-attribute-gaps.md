---
'@statorjs/stator': patch
---

Fix `Stator.response.headers` typing to match the real runtime value — a `Headers` instance, not `Record<string, string>`. The wrong ambient type let `Stator.response.headers['Location'] = x` typecheck cleanly while silently doing nothing at runtime (a bracket assignment on a real `Headers` object just creates a stray own JS property its internal storage never sees), while the correct fix is `.set('Location', x)`. Confirmed against a real app: this broke a shipped redirect feature with no error anywhere until something actually followed the redirect.

Also closes two typed-attribute gaps found by the same app: `input` was missing `form=` (already present on `button`, the standard way to submit an element outside a `<form>`'s own DOM subtree), and `form` was missing `onsubmit=` (a plain native inline-handler attribute, distinct from the `on:submit={...}` Stator directive).
