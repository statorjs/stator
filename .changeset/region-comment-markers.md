---
"@statorjs/stator": minor
---

Reactive regions (`each`/`when`/`match`/`defer`) are now delimited by HTML comment markers (`<!--s:id-->…<!--/s:id-->`) instead of a wrapper `<span style="display:contents">`. This fixes reactive lists and branches inside `<table>`/`<tbody>`/`<tr>`/`<select>`/`<ul>`, where the parser foster-parented the wrapper span out of its container and broke rendering — a reactive `each` of `<tr>` now works. It also stops the framework from injecting a node into your authored DOM, so CSS sibling/child selectors (`.a + .b`, `:nth-child`) match the elements you wrote. No API change; live-update patches address the same slot ids. Region-materializing patches parse through a `<template>`, so table-context fragments survive.
