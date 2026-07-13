---
"create-stator": minor
---

New `with-auth` template: a notice board with accounts — guarded login
(wrong password is literally `committed: false`), hash-at-the-edge
registration, role- and ownership-guarded actions, per-user durable state,
and session rotation on login/logout. Requires Node 24 (`node:sqlite`).
