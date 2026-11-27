---
'@statorjs/stator': patch
---

A failed app-store write while settling an app machine's entry effect is logged at error level (`entry-effect settle persist failed`, with the machine and the cause) instead of ending the process. Before, the rejection was unhandled, so a Redis blip during a `persist: true` app machine's entry effect, including at boot, crashed the server. The effect's completion is still delivered, and its write brings the stored snapshot up to date.
