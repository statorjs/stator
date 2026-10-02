---
"@statorjs/stator": minor
---

Component-scoped CSS is now usage-driven per route instead of one shared `components.css` concatenating every `.stator` file present in the app — a route only ships the styles of components it actually reaches, including ones reachable only inside an inactive `match`/`when`/`each` arm (still shipped, since a live update can activate that arm later with no fresh request).

`.stator` component libraries are now a supported shape: a published package can ship compiled `.stator` components whose scoped CSS a consuming app picks up automatically, the same way its own local components' CSS is picked up — in both the production build and the dev server. `<Image>`/`<Picture>` are the first real example: they're now real `.stator` components (previously plain `.ts` functions) with a genuine scoped style of their own, and `getPicture()` joins `getImage()`/`SOURCE_TYPES` as the public, pure escape hatch for custom art-direction components.
