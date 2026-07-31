---
"@statorjs/stator": patch
---

Data GET routes (`defineApiRoute({ method: 'GET', reads: [...] })`) now type `machines` off the `reads:` tuple, so `machines.SomeMachine` is a typed read proxy instead of `unknown` — selector access typechecks without a cast, and a mistyped machine name is a compile error. A route with no `reads:` gets an empty `machines`.
