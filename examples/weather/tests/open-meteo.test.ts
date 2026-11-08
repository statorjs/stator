import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aqiCategory,
  aqiInfo,
  cardinal,
  conditionKind,
  conditionLabel,
  hhmm,
  moonPath,
  moonPhase,
  placeId,
  sceneKind,
  sunArc,
  uvAdvice,
  uvRating,
  weatherIconSvg,
} from '../lib/open-meteo.ts'

describe('open-meteo — WMO condition mapping', () => {
  it('labels known codes and falls back to Unknown', () => {
    assert.equal(conditionLabel(0), 'Clear')
    assert.equal(conditionLabel(95), 'Thunderstorm')
    assert.equal(conditionLabel(1234), 'Unknown')
  })

  it('kinds partition the WMO code ranges', () => {
    assert.equal(conditionKind(0), 'clear')
    assert.equal(conditionKind(2), 'partly')
    assert.equal(conditionKind(3), 'cloudy')
    assert.equal(conditionKind(45), 'fog')
    assert.equal(conditionKind(53), 'drizzle')
    assert.equal(conditionKind(63), 'rain')
    assert.equal(conditionKind(73), 'snow')
    assert.equal(conditionKind(81), 'showers')
    assert.equal(conditionKind(85), 'snow') // snow showers, not rain showers
    assert.equal(conditionKind(95), 'thunder')
  })

  it('sceneKind keys off condition AND day/night', () => {
    assert.equal(sceneKind(0, true), 'clear-day')
    assert.equal(sceneKind(0, false), 'clear-night')
    assert.equal(sceneKind(63, true), 'rain-day')
    assert.equal(sceneKind(51, false), 'rain-night') // drizzle -> rain scene
    assert.equal(sceneKind(95, true), 'thunder-day')
  })
})

describe('open-meteo — AQI / UV bands', () => {
  it('aqiCategory bands on the European thresholds', () => {
    assert.equal(aqiCategory(20), 'Good')
    assert.equal(aqiCategory(21), 'Fair')
    assert.equal(aqiCategory(200), 'Extreme')
  })

  it('aqiInfo carries a label, colour and advice per band', () => {
    assert.equal(aqiInfo(15).label, 'Good')
    assert.equal(aqiInfo(90).label, 'Very poor')
    assert.equal(aqiInfo(150).label, 'Extreme')
    assert.match(aqiInfo(15).color, /^#/)
  })

  it('uvRating + uvAdvice band together', () => {
    assert.equal(uvRating(1), 'Low')
    assert.equal(uvRating(6), 'High')
    assert.equal(uvRating(12), 'Extreme')
    assert.match(uvAdvice(1), /No protection/)
    assert.match(uvAdvice(12), /shade/i)
  })
})

describe('open-meteo — moon phase', () => {
  const KNOWN_NEW = Date.UTC(2000, 0, 6, 18, 14)

  it('reads ~new at the reference new moon and ~full a half-cycle later', () => {
    const atNew = moonPhase(KNOWN_NEW)
    assert.ok(atNew.illum < 0.02)
    assert.equal(atNew.name, 'New moon')

    const full = moonPhase(KNOWN_NEW + 14.77 * 86_400_000)
    assert.ok(full.illum > 0.98)
    assert.equal(full.name, 'Full moon')
  })

  it('waxes through the first half of the cycle', () => {
    assert.equal(moonPhase(KNOWN_NEW + 5 * 86_400_000).waxing, true)
    assert.equal(moonPhase(KNOWN_NEW + 20 * 86_400_000).waxing, false)
  })

  it('moonPath returns an SVG arc path', () => {
    assert.match(moonPath(0.5, true), /^M 0 -26 A/)
  })
})

describe('open-meteo — sun arc geometry', () => {
  it('is polar when the times are missing or degenerate', () => {
    assert.equal(sunArc('', '', '').polar, true)
    // sunset before sunrise -> degenerate
    assert.equal(sunArc('2026-07-17T20:00', '2026-07-17T05:00', '2026-07-17T12:00').polar, true)
  })

  it('places the sun mid-arc at solar noon', () => {
    const arc = sunArc('2026-07-17T06:00', '2026-07-17T18:00', '2026-07-17T12:00')
    assert.equal(arc.polar, false)
    assert.ok(Math.abs(arc.sx - 64) < 10 ** -0 / 2)
    assert.match(arc.progressPath, /^M /)
  })
})

describe('open-meteo — small helpers', () => {
  it('hhmm extracts HH:MM from a local ISO', () => {
    assert.equal(hhmm('2026-07-17T05:12'), '05:12')
    assert.equal(hhmm('bad'), '—')
  })

  it('cardinal maps degrees to a 16-point compass and wraps', () => {
    assert.equal(cardinal(0), 'N')
    assert.equal(cardinal(90), 'E')
    assert.equal(cardinal(180), 'S')
    assert.equal(cardinal(270), 'W')
    assert.equal(cardinal(360), 'N')
  })

  it('placeId is a stable, rounded coordinate key', () => {
    assert.equal(placeId({ lat: 51.5074, lon: -0.1278 }), '51.507_-0.128')
    // sub-mm differences collapse to the same key
    assert.equal(placeId({ lat: 51.50741, lon: -0.12779 }), placeId({ lat: 51.5074, lon: -0.1278 }))
  })

  it('weatherIconSvg returns an inline svg glyph', () => {
    assert.ok((weatherIconSvg(0, true)).includes('<svg'))
    assert.ok((weatherIconSvg(0, true)).includes('wx-ico'))
  })
})
