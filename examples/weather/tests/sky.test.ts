import { describe, expect, it } from 'vitest'
import {
  cloudAlpha,
  discRadius,
  FALLBACK_SCENE,
  glowAlpha,
  particleCount,
  SCENES,
  sceneOf,
  seedClouds,
  seedParticles,
  seedStars,
  starCount,
} from '../lib/sky.ts'

describe('sky — scene table', () => {
  it('has a day and night variant for every condition family', () => {
    for (const f of ['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'thunder']) {
      expect(SCENES[`${f}-day`]).toBeDefined()
      expect(SCENES[`${f}-night`]).toBeDefined()
    }
    expect(Object.keys(SCENES)).toHaveLength(14)
  })

  it('flags night on the -night scenes and not the -day ones', () => {
    for (const [name, scene] of Object.entries(SCENES)) {
      expect(scene.night).toBe(name.endsWith('-night'))
    }
  })

  it('sceneOf resolves a known name and falls back for the unknown', () => {
    expect(sceneOf('clear-day')).toBe(SCENES['clear-day'])
    expect(sceneOf('nonsense')).toBe(SCENES[FALLBACK_SCENE])
    expect(sceneOf('')).toBe(SCENES[FALLBACK_SCENE])
  })
})

describe('sky — geometry math', () => {
  it('starCount scales with area but never below the floor', () => {
    expect(starCount(10, 10)).toBe(14)
    expect(starCount(600, 400)).toBe(40)
  })

  it('particleCount depends on the precipitation kind', () => {
    expect(particleCount(SCENES['rain-day']!, 600)).toBe(100)
    expect(particleCount(SCENES['snow-day']!, 660)).toBe(60)
    expect(particleCount(SCENES['fog-day']!, 600)).toBe(4)
    expect(particleCount(SCENES['clear-day']!, 600)).toBe(0)
  })

  it('glowAlpha is brightest with a disc, dimmest for a disc-less night', () => {
    expect(glowAlpha(SCENES['clear-day']!)).toBe(0.28)
    expect(glowAlpha(SCENES['clear-night']!)).toBe(0.22)
    expect(glowAlpha(SCENES['cloudy-day']!)).toBe(0.12)
    expect(glowAlpha(SCENES['cloudy-night']!)).toBe(0.08)
  })

  it('discRadius tracks the smaller side but floors at 16', () => {
    expect(discRadius(100, 500)).toBe(16)
    expect(discRadius(400, 400)).toBe(40)
  })

  it('cloudAlpha fades clouds at night', () => {
    expect(cloudAlpha(SCENES['cloudy-day']!, 1)).toBeCloseTo(0.55)
    expect(cloudAlpha(SCENES['cloudy-night']!, 1)).toBeCloseTo(0.22)
  })
})

describe('sky — particle seeding', () => {
  const rng = () => 0.5 // deterministic

  it('seeds one cloud per scene.clouds, positioned within the canvas', () => {
    const clouds = seedClouds(SCENES['partly-day']!, 200, 100, rng)
    expect(clouds).toHaveLength(3)
    for (const c of clouds) {
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.x).toBeLessThanOrEqual(200)
    }
  })

  it('seeds stars only for star scenes', () => {
    expect(seedStars(SCENES['clear-night']!, 300, 200, rng)).toHaveLength(starCount(300, 200))
    expect(seedStars(SCENES['clear-day']!, 300, 200, rng)).toEqual([])
  })

  it('seeds precipitation particles matching particleCount', () => {
    expect(seedParticles(SCENES['rain-day']!, 600, 300, rng)).toHaveLength(
      particleCount(SCENES['rain-day']!, 600),
    )
    expect(seedParticles(SCENES['clear-day']!, 600, 300, rng)).toEqual([])
  })
})
