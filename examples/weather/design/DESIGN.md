# Weather — design spec (locked)

The visual target for the `weather` example. The reference is
[`prototype.html`](./prototype.html) (open it in a browser) — a static,
mock-data mockup that establishes the look before we build it in Stator.

## Direction: Metro / Modern UI

Authentic Windows-Phone Metro: flat, sharp-cornered, vibrant tiles; Segoe-driven
light-weight typography (panorama title at `font-weight: 200`); lowercase section
headers; a dark-default theme (near-black ground, vibrant tiles, white content)
that also supports light. No gradients or shadows on the chrome.

## Tile system

A responsive tile grid (4 columns mobile, 6 desktop; `--u` unit). Tiles are solid
vibrant colors with white (or dark, on light tiles) content: a label, a big value,
a supplementary line.

**Live-tile animations** — two authentic Metro motions, assigned by content:

- **Flip** (whole-tile turn) — the *entire* tile rotates on its horizontal center
  axis. Two full-tile faces rotate independently (front `0°→90°`, back `-90°→0°`),
  hidden by sitting edge-on at ±90° — **no `preserve-3d` / `backface-visibility`**
  (that combination is unreliable in Firefox). The flip tile's own background is
  transparent so only the rotating faces carry color. Used for two-sided tiles:
  **alert** (warning → detail), **wind** (speed → gusts/bearing).
- **Peek** (slide-up) — a full-tile-height `translateY` slide between two frames
  (the real WP "peek" is full height, not a partial nudge). Pure 2D, Firefox-safe.
  Used where the back is one supplementary line: **UV** (index → advice),
  **air quality** (value → guidance).
- **Static** — sky, humidity, precip, sun, moon. A mix of live and still tiles,
  like a real Start screen.

The effect is a per-tile choice (mirrors Metro's `data-effect`).

## The current-conditions tile (live sky)

A wide tile whose background is a small canvas "sky" scene keyed to the current
condition + day/night: drifting clouds, a breathing sun/moon glow, rain streaks,
snow, stars, fog. Adapts to light/dark and re-tints on theme change. This is the
one place atmosphere lives; everything else is flat Metro.

## Content

- **Current**: temp, condition, feels-like, wind (speed + from-direction), humidity.
- **UV**: index + rating (Low→Extreme) + protection advice.
- **Air quality**: European AQI value + category (color-coded) + dominant pollutant.
- **Alerts**: severity-colored tile (advisory/watch/warning) with a pulsing dot,
  flips to detail. (Alerts come from national feeds — NWS / MeteoAlarm — not
  Open-Meteo.)
- **Wind**: speed + direction (compass), flips to gusts + bearing.
- **Sun**: sunrise/sunset with a mini arc (or "Polar night").
- **Moon**: phase disc + illumination %.
- **Hourly** (24h) and **10-day**: surface tiles (neutral, theme-aware) holding
  the detailed rows — icons, temps, precip %, wind, min/max range bars.

## Location

A Metro search field (sharp underline + magnifier). Selecting a saved location
re-renders and the sky adapts. In the real app this hits Open-Meteo's keyless
**geocoding** endpoint; saved locations persist.

## Colors & type

- **Ground**: dark `#0a0a0a` / light `#fbfbfb`. **Content**: white / near-black.
- **Tile accents** (Windows-Phone palette): cobalt `#0050EF`, cyan `#1BA1E2`,
  teal `#00ABA9`, amber `#F0A30A`, orange `#FA6800`, indigo `#6A00FF`,
  steel `#647687`; severity red `#E51400`; AQI scale green→lime→yellow→orange→red.
- **Type**: `"Segoe UI", system-ui, …` — light weights carry the Metro feel;
  `tabular-nums` on all readings.

## Data source

[Open-Meteo](https://open-meteo.com) — **no API key**, global, CORS-free
server-side: forecast (`/v1/forecast`), air quality (European AQI), and geocoding
(`/v1/search`). Weather-code → WMO condition mapping drives icons/scenes. Alerts
are a separate national feed. The fetch runs **server-side** (in the machine's
entry effect / a `defer` thunk), so there is no CORS and no key exposure.
