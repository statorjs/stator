import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
      assert.notEqual(SCENES[`${f}-day`], undefined)
      assert.notEqual(SCENES[`${f}-night`], undefined)
    }
    assert.equal((Object.keys(SCENES)).length, 14)
  })

  it('flags night on the -night scenes and not the -day ones', () => {
    for (const [name, scene] of Object.entries(SCENES)) {
      assert.equal(scene.night, name.endsWith('-night'))
    }
  })

  it('sceneOf resolves a known name and falls back for the unknown', () => {
    assert.equal(sceneOf('clear-day'), SCENES['clear-day'])
    assert.equal(sceneOf('nonsense'), SCENES[FALLBACK_SCENE])
    assert.equal(sceneOf(''), SCENES[FALLBACK_SCENE])
  })
})

describe('sky — geometry math', () => {
  it('starCount scales with area but never below the floor', () => {
    assert.equal(starCount(10, 10), 14)
    assert.equal(starCount(600, 400), 40)
  })

  it('particleCount depends on the precipitation kind', () => {
    assert.equal(particleCount(SCENES['rain-day']!, 600), 100)
    assert.equal(particleCount(SCENES['snow-day']!, 660), 60)
    assert.equal(particleCount(SCENES['fog-day']!, 600), 4)
    assert.equal(particleCount(SCENES['clear-day']!, 600), 0)
  })

  it('glowAlpha is brightest with a disc, dimmest for a disc-less night', () => {
    assert.equal(glowAlpha(SCENES['clear-day']!), 0.28)
    assert.equal(glowAlpha(SCENES['clear-night']!), 0.22)
    assert.equal(glowAlpha(SCENES['cloudy-day']!), 0.12)
    assert.equal(glowAlpha(SCENES['cloudy-night']!), 0.08)
  })

  it('discRadius tracks the smaller side but floors at 16', () => {
    assert.equal(discRadius(100, 500), 16)
    assert.equal(discRadius(400, 400), 40)
  })

  it('cloudAlpha fades clouds at night', () => {
    assert.ok(Math.abs((cloudAlpha(SCENES['cloudy-day']!, 1)) - 0.55) < 10 ** -2 / 2)
    assert.ok(Math.abs((cloudAlpha(SCENES['cloudy-night']!, 1)) - 0.22) < 10 ** -2 / 2)
  })
})

describe('sky — particle seeding', () => {
  const rng = () => 0.5 // deterministic

  it('seeds one cloud per scene.clouds, positioned within the canvas', () => {
    const clouds = seedClouds(SCENES['partly-day']!, 200, 100, rng)
    assert.equal(clouds.length, 3)
    for (const c of clouds) {
      assert.ok(c.x >= 0)
      assert.ok(c.x <= 200)
    }
  })

  it('seeds stars only for star scenes', () => {
    assert.equal((seedStars(SCENES['clear-night']!, 300, 200, rng)).length, starCount(300, 200))
    assert.deepStrictEqual(seedStars(SCENES['clear-day']!, 300, 200, rng), [])
  })

  it('seeds precipitation particles matching particleCount', () => {
    assert.equal((seedParticles(SCENES['rain-day']!, 600, 300, rng)).length, particleCount(SCENES['rain-day']!, 600))
    assert.deepStrictEqual(seedParticles(SCENES['clear-day']!, 600, 300, rng), [])
  })
})
