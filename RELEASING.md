# Releasing

Versions and changelogs are managed by [changesets](https://github.com/changesets/changesets); publishing is manual (npm 2FA; marketplace PATs). Release-relevant changes go through **pull requests**, where two gates enforce that nothing ships undocumented.

## Day to day

Change a published package? Add a changeset in the same PR:

```sh
pnpm changeset        # pick package(s) + bump + summary
```

That writes `.changeset/<name>.md`. Changesets accumulate on `main`; the version bumps happen later, in the Version PR.

### The two gates (on every PR)

- **Require changeset** — a PR touching `@statorjs/stator`, `@statorjs/language-server`, or `create-stator` source must include a changeset naming that package. Fires on any source change.
- **Extension bundle gate** — a PR is blocked if it changes what the VS Code extension actually *ships* (its compiled bundle, built at the PR base vs head) without a `stator-vscode` changeset. It compares the built output, not the touched files — so comment-only or tree-shaken-away changes in the compiler/language-server don't nag you, and a real behavioral change can't reach the marketplace undocumented. This is why you no longer hand-edit `editors/vscode/package.json` — a changeset drives the bump.

## Cutting a release

1. CI maintains a **"Version Packages" PR** whenever changesets exist on `main` — it applies the bumps, writes per-package `CHANGELOG.md`s, and deletes the consumed changesets. Review and merge it. **Do not** run the version step by hand (it's the automation's job — keep the PR flow honest).

2. **Write the root `CHANGELOG.md` story** for a minor with an arc (NOT automated — the Version PR only writes per-package changelogs). A `## @statorjs/stator X.Y.0 — YYYY-MM-DD` narrative synthesizing the minor's changesets into its through-line (see the 2.0.0 / 2.3.0 entries for voice). Patches and arc-less minors can skip it. Do it when you merge the Version PR, while the arc is fresh — it went un-written for 2.1–2.4 because it lived only as a passing "Notes" line, not as a checklist step.

3. Publish, per target — both manual, both after the Version PR merges:

   ```sh
   # npm packages (@statorjs/stator, language-server, create-stator):
   pnpm release              # changeset publish — OTP; skips private pkgs
   git push --follow-tags

   # VS Code extension — ONLY if the Version PR bumped `stator-vscode`
   # (its name appears in the PR body / its CHANGELOG got an entry):
   cd editors/vscode
   pnpm run publish:vsce     # Azure PAT
   pnpm run publish:ovsx     # OVSX_PAT
   ```

   The extension is `private: true`, so `changeset publish` skips it — but changesets still versioned it and wrote its changelog. The only manual part is the marketplace push, exactly mirroring the npm OTP step.

4. **Update the landing page** (`apps/landing/index.html`) — it is plain HTML with no build step, so these are hand-maintained and nothing bumps them for you. **Six** strings, and `grep -n '2\.8' apps/landing/index.html` (the *outgoing* version) is the way to find them all — some are bare `X.Y`, so a `X.Y.Z` pattern silently misses them:

   | where | shape |
   | --- | --- |
   | nav | `REV X.Y` |
   | hero spec | `DOC-002 · vX.Y · released` |
   | hero prose | `released software, now at X.Y` |
   | §6 intro | `what's shipped as of X.Y` |
   | footer | `STATOR · vX.Y.Z` |
   | footer | `REV. YYYY.MM` |

   Leave the `(X.Y)` tags inside the `/// SHIPPED` list alone — that list is a per-release ledger, newest first, and those tags are history. Add a new entry at its top for the minor's headline.

   Do this **after** publishing, not before: `netlify.toml` auto-deploys the landing page on every push to `main`, so a bump that merges ahead of `pnpm release` puts a version on the site that isn't on npm yet.

## Preview releases (`next`)

For a minor that changes something you want to *use* before it is permanent — a build-pipeline change, the shape of the deploy artifact — cut previews to npm under the `next` tag first, then finish as one minor.

```sh
pnpm changeset pre enter next     # writes .changeset/pre.json — commit it
```

From then on nothing else about the flow changes. Land work with changesets as usual; the Version PR now bumps to `X.Y.0-next.N` instead of `X.Y.0`, and `pnpm release` publishes those under the **`next`** dist-tag:

```sh
pnpm add @statorjs/stator@next    # preview
pnpm add @statorjs/stator         # still the stable release — `latest` is untouched
```

Iterate as many times as you like: land more changesets, merge the Version PR again, publish again — `next.0`, `next.1`, `next.2`. Every accumulated changeset stays recorded in `pre.json`.

When it's ready:

```sh
pnpm changeset pre exit           # commit the pre.json change
```

The next Version PR then produces the final `X.Y.0`, with a changelog covering **every** changeset consumed across the previews. That is also when you write the root `CHANGELOG.md` story and update the landing page — once, for the real release, not per preview.

Notes:

- `latest` never moves while in pre mode, so a preview cannot reach anyone who did not ask for `@next`.
- **create-stator's scaffold range deliberately trails during a preview.** A caret range cannot install a prerelease — `^2.10.0` is not satisfied by `2.10.0-next.0` — so advancing it mid-train would make `pnpm create stator` scaffold an app that cannot install at all. `sync-scaffold-range.mjs` leaves it on the last stable line while `pre.json` exists and advances it when the final ships; `check-scaffold-range.mjs` tolerates the gap for the same reason.
- Don't hand-edit versions or delete `pre.json` before exiting — it is what makes the final changelog complete.
- Prereleases are real published versions. A bad `next.N` is unpublishable-in-practice like any other; cut `next.N+1`.

## How the extension fits changesets

`.changeset/config.json` sets `privatePackages.version: true` so the private extension rides the normal Version-PR flow (bump + changelog), and lists every *other* private package (apps, examples) in `ignore` so they aren't versioned. `scripts/check-ignore-list.mjs` asserts that list stays complete in CI — add a new example, and a missing `ignore` entry fails the build.

The extension declares **no** workspace dependency on the language-server (it bundles the source at build time), so a framework change never *cascades* into an extension bump — only a real bundle change (caught by the gate) does.

## Notes

- The root `CHANGELOG.md` stays hand-written for release *stories* (1.0.0-style narratives); per-package changelogs are generated.
- `create-stator`'s `STATOR_RANGE` const pins what scaffolded apps get — bump it when a new framework minor ships. `scripts/check-scaffold-range.mjs` enforces this in CI.
- Branch protection on `main` requires the gate checks to pass before merge (repo Settings → Branches).
