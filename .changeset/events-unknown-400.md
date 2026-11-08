---
"@statorjs/stator": major
---

`POST /__events` refuses an event type the target machine's chart never handles, in any state or at machine level, with a 400 that names it. Before, such an event reached the machine and silently committed nothing, which hid typos and stale clients. An event the chart handles in a different state still reaches the machine and reports `committed: false`, since the same interaction can be valid one moment and stale the next. Server-side dispatch (`dispatchToApp`, effect completions, `subscribes`) is unchanged.
