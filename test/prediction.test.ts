import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPracticePrediction, getUilFlag, mergeForecastHistory } from '../src/prediction.ts'

test('answers no when the incident ceiling crosses the UIL limit', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 87,
    nearbyWbgt: 89,
    observedAirTemperature: 96,
    modeledCurrentAirTemperature: 95,
    useLiveSignal: true,
  })

  assert.equal(prediction.state, 'no')
  assert.equal(prediction.headline, 'NO.')
  assert.equal(prediction.planningCeiling, 95)
  assert.equal(prediction.ceilingMargin, -2.9)
  assert.equal(prediction.liveTemperatureGap, 1)
})

test('answers no when the central forecast itself reaches the UIL no-practice line', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 92.1,
    nearbyWbgt: 91,
    observedAirTemperature: 98,
    modeledCurrentAirTemperature: 98,
    useLiveSignal: true,
  })

  assert.equal(prediction.state, 'no')
  assert.equal(prediction.headline, 'NO.')
})

test('answers yes only when the planning ceiling remains below the UIL limit', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 84,
    nearbyWbgt: 85,
    observedAirTemperature: 90,
    modeledCurrentAirTemperature: 90,
    useLiveSignal: true,
  })

  assert.equal(prediction.state, 'yes')
  assert.equal(prediction.headline, 'YES.')
  assert.equal(prediction.planningCeiling, 91)
  assert.equal(prediction.ceilingMargin, 1.1)
})

test('answers no when live air temperature is materially hotter than the model', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 83,
    nearbyWbgt: 84,
    observedAirTemperature: 99,
    modeledCurrentAirTemperature: 95,
    useLiveSignal: true,
  })

  assert.equal(prediction.planningCeiling, 90)
  assert.equal(prediction.liveTemperatureGap, 4)
  assert.equal(prediction.state, 'no')
  assert.equal(prediction.liveWarning, true)
})

test('does not apply today live observation mismatch to a future day', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 83,
    nearbyWbgt: 84,
    observedAirTemperature: 99,
    modeledCurrentAirTemperature: 95,
    useLiveSignal: false,
  })

  assert.equal(prediction.state, 'yes')
  assert.equal(prediction.liveWarning, false)
})

test('returns pending when the exact-location WBGT forecast is unavailable', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: null,
    nearbyWbgt: 88,
    observedAirTemperature: 96,
    modeledCurrentAirTemperature: 95,
    useLiveSignal: true,
  })

  assert.equal(prediction.state, 'pending')
  assert.equal(prediction.headline, 'CHECK.')
  assert.equal(prediction.planningCeiling, null)
})

test('preserves every UIL Class 3 boundary', () => {
  assert.equal(getUilFlag(81.9), 'green')
  assert.equal(getUilFlag(82), 'yellow')
  assert.equal(getUilFlag(86.9), 'yellow')
  assert.equal(getUilFlag(87), 'orange')
  assert.equal(getUilFlag(90), 'orange')
  assert.equal(getUilFlag(90.1), 'red')
  assert.equal(getUilFlag(92), 'red')
  assert.equal(getUilFlag(92.1), 'black')
})

test('stores fresh forecast snapshots without duplicating the same source issue and target', () => {
  const first = {
    capturedAt: '2026-09-17T18:00:00.000Z',
    sourceUpdatedAt: '2026-09-17T17:30:00.000Z',
    target: '2026-09-17T19:45:00.000Z',
    forecastWbgt: 87,
    nearbyWbgt: 89,
    planningCeiling: 95,
    state: 'no' as const,
  }
  const duplicate = { ...first, capturedAt: '2026-09-17T18:05:00.000Z' }
  const nextRun = { ...first, capturedAt: '2026-09-17T18:10:00.000Z', sourceUpdatedAt: '2026-09-17T18:08:00.000Z', forecastWbgt: 88 }

  const history = mergeForecastHistory([first], duplicate)
  assert.deepEqual(history, [first])
  assert.deepEqual(mergeForecastHistory(history, nextRun), [first, nextRun])
})
