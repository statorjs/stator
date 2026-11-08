---
"@statorjs/language-server": minor
"stator-vscode": minor
---

The editor follows the Stator release installed in the project, not the one bundled in the extension. The language server finds the project's `@statorjs/stator`, and when it exports the editor contract (`@statorjs/stator/editor`, 3.0 and later) the `Stator.*` macros are typed from it, so each project sees its own release's API and the extension can update without moving it. Projects on earlier releases keep the macro types those releases had. An upgrade is picked up on the next edit.
