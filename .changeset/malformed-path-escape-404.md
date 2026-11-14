---
"@statorjs/stator": patch
---

A URL whose path parameter holds a malformed percent-escape (`/posts/%E0%A4%A`) is a 404. It threw out of route matching, so every such request was a 500 with a stack trace in the log.
