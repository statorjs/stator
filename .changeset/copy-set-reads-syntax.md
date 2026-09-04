---
"@statorjs/stator": patch
---

The build's copy set no longer mistakes prose for code. A comment explaining why an app avoids `import(name)` was read as a real untraceable dynamic import and failed the build, and a comment mentioning a `new URL('./x', import.meta.url)` path invented a directory that does not exist.

Both checks were regex scans over raw source, which cannot tell code from prose — the file's own explanation of a pattern looks exactly like the pattern. They now walk the syntax tree, where comments and string contents simply are not present. Everything real still resolves: a string-literal `import()` is followed, a template literal with a fixed prefix is glob-expanded, a genuinely computed specifier is still reported with its file and line, and a `new URL(literal, import.meta.url)` asset is still copied. A template-literal asset path (`` new URL(`./x.json`, import.meta.url) ``) is picked up too now, which the old pattern missed.

Found by dogfooding a real app against `2.10.0-next.0`.
