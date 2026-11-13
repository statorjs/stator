# Weather

A forecast dashboard in a Metro, live-tile style: search for places, pin them, and flip between them. Forecasts come from [Open-Meteo](https://open-meteo.com), which needs no API key.

```sh
pnpm install
pnpm dev
pnpm test       # machines, the API client and the sky model, no browser needed
```

## What to look at

- `machines/forecast-cache.ts` is an **app** machine: one cache of fetched forecasts, shared by every visitor and refreshed by an **effect**.
- `machines/weather.ts`, `settings.ts` and `search.ts` are **session** machines: this visitor's places, units and search results. `panels.ts` holds no state; it **reads** the others and the cache, and shapes what each tile shows.
- Picking a search result sends its position, not the place: `search.ts` looks it up in the geocoder's results, so the coordinates the server fetches never come from the browser.
- `routes/index.stator` is a **live** page: a refreshed forecast reaches every open tab over SSE.
- `lib/open-meteo.ts` is the API client. It is plain code that the cache's effect calls; nothing in it knows about Stator.
- Several tiles are **client islands**. `templates/live-sky.stator` draws the sky on a canvas, `templates/location-search.stator` debounces typing before it dispatches a search, and `templates/app-bar-ctl.stator` runs `lib/view-mode.ts`, an ordinary machine, in the browser.

The app makes outbound requests to Open-Meteo's forecast and geocoding APIs. The forecast cache is in memory and refills on demand. Each visitor's places and settings are in memory too, unless you copy `.env.example` to `.env.local` and set `REDIS_URL`.

## Learn more

- Docs: https://docs.statorjs.dev
- Reference app: https://demo.statorjs.dev ([source](https://github.com/statorjs/stator/tree/main/apps/store))
