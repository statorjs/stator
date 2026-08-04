/**
 * The animated-sky scene data + geometry math, factored out of the `live-sky`
 * island so it can be unit-tested. The island keeps only the canvas wiring (the
 * requestAnimationFrame loop and the 2D drawing calls); every value it draws
 * from — which scene a condition maps to, how many particles to seed, the glow
 * and disc geometry — lives here and is covered by `tests/sky.test.ts`.
 */

export type Scene = {
  /** One gradient — day/night is baked in from the weather's is_day (not the UI
   *  theme), so the sky reflects reality. */
  sky: [string, string]
  glow: string
  clouds: number
  /** A crisp sun/moon disc; null when overcast/wet. */
  disc: 'sun' | 'moon' | null
  part: 'stars' | 'rain' | 'snow' | 'fog' | null
  night: boolean
}

export const FALLBACK_SCENE = 'cloudy-day'

export const SCENES: Record<string, Scene> = {
  'clear-day': { sky: ['#4f9fe0', '#cfe6f7'], glow: '255,206,120', clouds: 1, disc: 'sun', part: null, night: false },
  'clear-night': { sky: ['#0a1326', '#131d33'], glow: '190,206,255', clouds: 0, disc: 'moon', part: 'stars', night: true },
  'partly-day': { sky: ['#589fdb', '#d6e7f4'], glow: '255,206,120', clouds: 3, disc: 'sun', part: null, night: false },
  'partly-night': { sky: ['#0b1428', '#141e34'], glow: '190,206,255', clouds: 3, disc: 'moon', part: 'stars', night: true },
  'cloudy-day': { sky: ['#8ba2b8', '#dbe4ec'], glow: '236,242,250', clouds: 5, disc: null, part: null, night: false },
  'cloudy-night': { sky: ['#1b2833', '#111a24'], glow: '150,165,190', clouds: 5, disc: null, part: null, night: true },
  'fog-day': { sky: ['#a7b4c0', '#dfe6ec'], glow: '232,238,244', clouds: 3, disc: null, part: 'fog', night: false },
  'fog-night': { sky: ['#1e2a34', '#141d26'], glow: '140,155,175', clouds: 3, disc: null, part: 'fog', night: true },
  'rain-day': { sky: ['#6f8498', '#b3c1d0'], glow: '205,216,228', clouds: 5, disc: null, part: 'rain', night: false },
  'rain-night': { sky: ['#141f2a', '#0d151d'], glow: '120,140,165', clouds: 5, disc: null, part: 'rain', night: true },
  'snow-day': { sky: ['#9fb0c2', '#dbe3ec'], glow: '232,240,248', clouds: 4, disc: null, part: 'snow', night: false },
  'snow-night': { sky: ['#1a2634', '#111923'], glow: '150,168,195', clouds: 4, disc: null, part: 'snow', night: true },
  'thunder-day': { sky: ['#5c6b7e', '#9aa8b8'], glow: '240,180,90', clouds: 6, disc: null, part: 'rain', night: false },
  'thunder-night': { sky: ['#12181f', '#0b0f14'], glow: '150,160,180', clouds: 6, disc: null, part: 'rain', night: true },
}

/** Resolve a scene name (the live `scene` attribute) to its data, falling back
 *  to an overcast day for anything unrecognized. */
export function sceneOf(name: string): Scene {
  return SCENES[name] ?? SCENES[FALLBACK_SCENE]!
}

/** Twinkling-star count scales with canvas area, with a floor so tiny tiles
 *  still show a few. */
export function starCount(w: number, h: number): number {
  return Math.max(14, Math.round((w * h) / 6000))
}

/** How many precipitation/fog particles a scene seeds across width `w`. */
export function particleCount(scene: Scene, w: number): number {
  if (scene.part === 'rain') return Math.round(w / 6)
  if (scene.part === 'snow') return Math.round(w / 11)
  if (scene.part === 'fog') return 4
  return 0
}

/** Ambient-halo opacity behind the disc: brighter with a sun/moon present,
 *  dimmer at night, dimmest for disc-less (overcast/wet) scenes. */
export function glowAlpha(scene: Scene): number {
  return scene.disc ? (scene.night ? 0.22 : 0.28) : scene.night ? 0.08 : 0.12
}

/** Sun/moon disc radius for a canvas of the given size (floored so it never
 *  vanishes on a small tile). */
export function discRadius(w: number, h: number): number {
  return Math.max(16, Math.min(w, h) * 0.1)
}

/** Per-lobe cloud alpha — clouds read markedly fainter at night. */
export function cloudAlpha(scene: Scene, a: number): number {
  return scene.night ? a * 0.22 : a * 0.55
}

export type Cloud = { x: number; y: number; s: number; v: number; a: number }
export type Star = { x: number; y: number; r: number; tw: number }
export type Particle = { x: number; y: number; z: number }

/** Seed the drifting cloud lobes for a scene. `rng` is injectable so tests get
 *  determinism; the island uses the default `Math.random`. */
export function seedClouds(scene: Scene, w: number, h: number, rng: () => number = Math.random): Cloud[] {
  return Array.from({ length: scene.clouds }, () => ({
    x: rng() * w,
    y: 8 + rng() * (h * 0.55),
    s: 0.7 + rng(),
    v: 5 + rng() * 9,
    a: 0.5 + rng() * 0.4,
  }))
}

/** Seed the twinkling stars (only for star scenes). */
export function seedStars(scene: Scene, w: number, h: number, rng: () => number = Math.random): Star[] {
  if (scene.part !== 'stars') return []
  return Array.from({ length: starCount(w, h) }, () => ({
    x: rng() * w,
    y: rng() * h * 0.8,
    r: rng() * 1.1 + 0.3,
    tw: rng() * 6.28,
  }))
}

/** Seed the rain/snow/fog particles. */
export function seedParticles(scene: Scene, w: number, h: number, rng: () => number = Math.random): Particle[] {
  return Array.from({ length: particleCount(scene, w) }, () => ({
    x: rng() * w,
    y: rng() * h,
    z: 0.5 + rng(),
  }))
}
