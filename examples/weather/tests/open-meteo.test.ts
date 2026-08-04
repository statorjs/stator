import { describe, expect, it } from 'vitest'
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
    expect(conditionLabel(0)).toBe('Clear')
    expect(conditionLabel(95)).toBe('Thunderstorm')
    expect(conditionLabel(1234)).toBe('Unknown')
  })

  it('kinds partition the WMO code ranges', () => {
    expect(conditionKind(0)).toBe('clear')
    expect(conditionKind(2)).toBe('partly')
    expect(conditionKind(3)).toBe('cloudy')
    expect(conditionKind(45)).toBe('fog')
    expect(conditionKind(53)).toBe('drizzle')
    expect(conditionKind(63)).toBe('rain')
    expect(conditionKind(73)).toBe('snow')
    expect(conditionKind(81)).toBe('showers')
    expect(conditionKind(85)).toBe('snow') // snow showers, not rain showers
    expect(conditionKind(95)).toBe('thunder')
  })

  it('sceneKind keys off condition AND day/night', () => {
    expect(sceneKind(0, true)).toBe('clear-day')
    expect(sceneKind(0, false)).toBe('clear-night')
    expect(sceneKind(63, true)).toBe('rain-day')
    expect(sceneKind(51, false)).toBe('rain-night') // drizzle -> rain scene
    expect(sceneKind(95, true)).toBe('thunder-day')
  })
})

describe('open-meteo — AQI / UV bands', () => {
  it('aqiCategory bands on the European thresholds', () => {
    expect(aqiCategory(20)).toBe('Good')
    expect(aqiCategory(21)).toBe('Fair')
    expect(aqiCategory(200)).toBe('Extreme')
  })

  it('aqiInfo carries a label, colour and advice per band', () => {
    expect(aqiInfo(15).label).toBe('Good')
    expect(aqiInfo(90).label).toBe('Very poor')
    expect(aqiInfo(150).label).toBe('Extreme')
    expect(aqiInfo(15).color).toMatch(/^#/)
  })

  it('uvRating + uvAdvice band together', () => {
    expect(uvRating(1)).toBe('Low')
    expect(uvRating(6)).toBe('High')
    expect(uvRating(12)).toBe('Extreme')
    expect(uvAdvice(1)).toMatch(/No protection/)
    expect(uvAdvice(12)).toMatch(/shade/i)
  })
})

describe('open-meteo — moon phase', () => {
  const KNOWN_NEW = Date.UTC(2000, 0, 6, 18, 14)

  it('reads ~new at the reference new moon and ~full a half-cycle later', () => {
    const atNew = moonPhase(KNOWN_NEW)
    expect(atNew.illum).toBeLessThan(0.02)
    expect(atNew.name).toBe('New moon')

    const full = moonPhase(KNOWN_NEW + 14.77 * 86_400_000)
    expect(full.illum).toBeGreaterThan(0.98)
    expect(full.name).toBe('Full moon')
  })

  it('waxes through the first half of the cycle', () => {
    expect(moonPhase(KNOWN_NEW + 5 * 86_400_000).waxing).toBe(true)
    expect(moonPhase(KNOWN_NEW + 20 * 86_400_000).waxing).toBe(false)
  })

  it('moonPath returns an SVG arc path', () => {
    expect(moonPath(0.5, true)).toMatch(/^M 0 -26 A/)
  })
})

describe('open-meteo — sun arc geometry', () => {
  it('is polar when the times are missing or degenerate', () => {
    expect(sunArc('', '', '').polar).toBe(true)
    // sunset before sunrise -> degenerate
    expect(sunArc('2026-07-17T20:00', '2026-07-17T05:00', '2026-07-17T12:00').polar).toBe(true)
  })

  it('places the sun mid-arc at solar noon', () => {
    const arc = sunArc('2026-07-17T06:00', '2026-07-17T18:00', '2026-07-17T12:00')
    expect(arc.polar).toBe(false)
    expect(arc.sx).toBeCloseTo(64, 0)
    expect(arc.progressPath).toMatch(/^M /)
  })
})

describe('open-meteo — small helpers', () => {
  it('hhmm extracts HH:MM from a local ISO', () => {
    expect(hhmm('2026-07-17T05:12')).toBe('05:12')
    expect(hhmm('bad')).toBe('—')
  })

  it('cardinal maps degrees to a 16-point compass and wraps', () => {
    expect(cardinal(0)).toBe('N')
    expect(cardinal(90)).toBe('E')
    expect(cardinal(180)).toBe('S')
    expect(cardinal(270)).toBe('W')
    expect(cardinal(360)).toBe('N')
  })

  it('placeId is a stable, rounded coordinate key', () => {
    expect(placeId({ lat: 51.5074, lon: -0.1278 })).toBe('51.507_-0.128')
    // sub-mm differences collapse to the same key
    expect(placeId({ lat: 51.50741, lon: -0.12779 })).toBe(placeId({ lat: 51.5074, lon: -0.1278 }))
  })

  it('weatherIconSvg returns an inline svg glyph', () => {
    expect(weatherIconSvg(0, true)).toContain('<svg')
    expect(weatherIconSvg(0, true)).toContain('wx-ico')
  })
})
