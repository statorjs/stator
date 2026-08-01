---
"@statorjs/stator": minor
---

A machine instance in a template now types `state` to the machine's state-name union and `send()` to its event union, so `s.state === 'ready'` and `m.send({ type: 'SAVE', … })` autocomplete and a typo — a bad state name, event name, or event payload — is a compile error. Both were previously loose (`state: string`, `send({ type: string })`), so template typos slipped through.
