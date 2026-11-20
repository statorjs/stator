---
'@statorjs/stator': patch
---

An event sent from the browser to an app machine is now refused clearly. `/__events` answers with a 403 that names the machine and points to the session-machine gateway, instead of failing with a 500 and a "not loaded into this runtime" stack trace. A template `machine.send(…)` or an island `dispatch(Machine, …)` aimed at an app machine is also a type error at the call, so `stator check` and the editor report it before it runs. A machine def now carries its `lifecycle` as a literal type to make that possible.
