import test from 'node:test'
import assert from 'node:assert/strict'
import { cloudCoverFromLayers, estimateOutdoorWbgt } from '../src/wbgt.ts'

const afternoon = new Date('2026-07-19T20:00:00.000Z')

test('matches the published NWS clear and light-wind reference example', () => {
  const estimate = estimateOutdoorWbgt({
    airTemperatureF: 100,
    relativeHumidity: 39,
    windMph: 5,
    cloudCover: 10,
    pressureHpa: 1000,
    latitude: 37.209,
    at: afternoon,
  })

  assert.equal(Math.round(estimate), 94)
})

test('cloud cover lowers the live estimate enough to cross the UIL line', () => {
  const estimate = estimateOutdoorWbgt({
    airTemperatureF: 100,
    relativeHumidity: 39,
    windMph: 5,
    cloudCover: 65,
    pressureHpa: 1000,
    latitude: 37.209,
    at: afternoon,
  })

  assert.equal(Math.round(estimate), 91)
})

test('a stronger breeze lowers the live estimate enough to cross the UIL line', () => {
  const estimate = estimateOutdoorWbgt({
    airTemperatureF: 100,
    relativeHumidity: 39,
    windMph: 13,
    cloudCover: 10,
    pressureHpa: 1000,
    latitude: 37.209,
    at: afternoon,
  })

  assert.equal(Math.round(estimate), 90)
})

test('converts METAR cloud layers into a numerical sky-cover estimate', () => {
  assert.equal(cloudCoverFromLayers([{ amount: 'FEW' }]), 12.5)
  assert.equal(cloudCoverFromLayers([{ amount: 'SCT' }]), 37.5)
  assert.equal(cloudCoverFromLayers([{ amount: 'BKN' }]), 75)
  assert.equal(cloudCoverFromLayers([{ amount: 'OVC' }]), 100)
  assert.equal(cloudCoverFromLayers([{ amount: 'FEW' }, { amount: 'BKN' }]), 75)
})
