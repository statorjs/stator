---
"@statorjs/stator": minor
---

The bare package name is now importable: `import { defineConfig } from '@statorjs/stator'` works in `stator.config.ts` — the root export carries exactly the config-authoring surface (`defineConfig`, `StatorConfig`, `LogLevel`), so loading a config never pulls in server-only dependencies. The `/config` subpath keeps working unchanged.
