---
'@statorjs/stator': patch
---

`match()` looks up only the arms the cases object declares. A matched value such as `constructor`, `toString`, `__proto__` or `valueOf` used to find the `Object.prototype` member of that name and throw during the render or the live update; it now renders an empty slot, like any value with no arm. A cases object that declares an arm with one of those names still renders it.
