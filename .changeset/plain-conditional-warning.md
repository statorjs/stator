---
'@statorjs/stator': patch
'stator-vscode': patch
---

`stator check` and the language server warn about a plain conditional that is chosen once at render from a value that can change afterwards. `{found ? <PollPage /> : <NotFound />}` or `{isOwner && <Tools />}`, where the test comes from `Stator.request.claims()` or from a value read off a machine handle in the frontmatter, has no id scope of its own, so a later live update can land on the wrong elements until the page reloads. The warning points at the conditional and names the fix: `when(read(machine, …), …)`, which makes the branch part of the page's live state. It fires only when an arm holds a binding (`read()`, `each`/`when`/`match`, an `on:` handler) or a component; a test computed by a helper function isn't traced. It never fails the check.
