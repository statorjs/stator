# Contributing to Stator

Thanks for the interest — and a heads-up before anything else: **Stator
isn't accepting code pull requests right now.** Not because contributions
aren't valued, but because of how this project is built: every feature on
the [roadmap](ROADMAP.md) earns its place through evidence from real usage,
and the design loop is deliberately tight while the 1.x foundations
(see `.chisel/specs/active/`) are being worked out. Unsolicited PRs — even
good ones — will be closed with a pointer here. That will change; this
document will too.

What moves the project forward *today* is using it:

## Build something

The single most valuable contribution. Scaffold an app
(`pnpm create stator my-app`), build something real, and tell us where it
shone and where it fought you. The storefront demo found eight framework
bugs before 1.0 shipped — your app will find things ours didn't.

## Report what you find

Open a [GitHub issue](https://github.com/statorjs/stator/issues) for:

- **Bugs** — a minimal reproduction wins: `pnpm create stator repro`, the
  fewest machines/routes that show it, and your versions. For wire-level
  weirdness, the inspector's patch log (bottom of every dev page) is gold.
- **DX paper cuts** — confusing errors, phantom editor squiggles, docs that
  lied to you, a scaffold step that stumbled. We treat these as seriously
  as bugs; half our changelog is paper cuts someone bothered to report.
- **Use cases that don't fit** — "I tried to build X and there was no home
  for Y" is exactly the evidence the roadmap runs on. Tell the story; the
  missing primitive analysis feeds on it.

## Share a template

Community templates need no PR and no permission — `create-stator` scaffolds
from any public repo:

```sh
pnpm create stator my-app --template github:you/your-stator-template
```

Build one, publish it in your own repository, tell people. If a template
gets traction we'll gladly link it from the docs.

## Docs and typos

Small documentation fixes are the one PR exception — typos, broken links,
factually wrong sentences. For anything structural (new guides, reorganized
sections), open an issue first.

## Security

Please don't open public issues for vulnerabilities — use GitHub's
[private vulnerability reporting](https://github.com/statorjs/stator/security/advisories/new)
on this repository.
