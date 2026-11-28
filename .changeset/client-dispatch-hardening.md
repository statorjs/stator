---
'@statorjs/stator': minor
---

A patch that throws while it is being applied no longer takes the rest of its batch and the response's directives with it. Each patch now applies on its own: the one that throws is skipped and logged, a new `stator:patch-error` window event fires with `{ patch, error, timestamp }`, and the remaining patches and directives run. Before, a template send dropped everything after the failed patch and left an unhandled rejection, and island `dispatch()` rejected. Listen for `stator:patch-error` to learn that the page has drifted from the server, for example to offer a reload on a route that is not live. Island `dispatch()` now never rejects: a directive that throws while it runs is logged and the result still resolves. Island dispatches also fire `stator:event-sent` and `stator:patches-received`, which only template sends fired before, so the dev inspector lists them, and it shows a row for each `stator:patch-error`.
