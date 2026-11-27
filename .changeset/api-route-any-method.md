---
'@statorjs/stator': minor
---

`defineApiRoute` accepts `method: 'POST'`, `'PUT'`, `'PATCH'` or `'DELETE'` on a command route; before, any method but `'GET'` was a type error. `method` stays optional on a command route, and the export name still routes the request. Discovery checks a declared method against the export name, so `export const DELETE = defineApiRoute({ method: 'POST', … })` fails at startup naming the file, and a method outside `GET`, `POST`, `PUT`, `PATCH`, `DELETE` throws when the route is defined. `HttpMethod` and `CommandMethod` are exported as types from `@statorjs/stator/server`.
