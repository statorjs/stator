---
'@statorjs/stator': patch
---

An `after` delay longer than about 24.8 days (2^31-1 ms) fires at its deadline. Before, Node clamped it to 1 ms, so a 30-day trial expired at once; a timer restored after a restart with that much time left did the same. Longer delays are now waited out in steps, and leaving the state cancels whichever step is pending.
