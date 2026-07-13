---
"create-stator": minor
---

Scaffolding now offers to finish the job: an "install dependencies?" prompt
that detects whether you launched via pnpm, npm, yarn, or bun (and installs
with that), and a "initialize a git repository?" prompt (init + initial
commit). Next-steps output uses your package manager's real commands and
skips what's already done. Flags for scripts and CI: `--install/--no-install`,
`--git/--no-git`, and `-y`/`--yes` to accept all defaults; non-interactive
runs without flags skip both.
