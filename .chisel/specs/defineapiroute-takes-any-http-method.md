---
title: defineApiRoute takes any HTTP method
status: draft
created: 2026-11-15
updated: 2026-11-15
area: routing
---

## What and Why

A route file's export name already sets its HTTP method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`; `route-discovery.ts`). Inside `defineApiRoute`, though, `method` accepts only `'GET'`, where it switches the route to a read-only data route. Writing `method: 'POST'` (or `'DELETE'`) for a command route is a type error, which reads as "Stator can't do POST" (hit by indiepub.dev, 2026-11-15). The field should name the method for any route, with GET still meaning the data-route shape.

## Success Criteria

- `defineApiRoute({ method, … })` accepts every `HttpMethod`. `'GET'` keeps today's data-route typing (`{ machines }`, `revision`); any other method gives the command-route typing (`dispatch`, `rotateSession`, …).
- `method` stays optional for non-GET routes, so existing command routes don't change.
- Discovery checks every declared method against its export name, not only GET (`export const DELETE = defineApiRoute({ method: 'POST' })` is a located error).
- The type error for a wrong shape names the fix (e.g. "a GET export needs `method: 'GET'`").
- `guides/api-routes.md` shows a DELETE command route.

## Constraints

- Non-breaking: every existing `defineApiRoute` call typechecks and behaves the same.
