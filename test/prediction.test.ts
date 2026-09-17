import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPracticePrediction, getUilFlag, mergeForecastHistory } from '../src/prediction.ts'

test('uses the live conditions estimate inside the practice decision window', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 89,
    nearbyWbgt: 89,
    liveWbgt: 90.8,
    useLiveSignal: true,
  })

  assert.equal(prediction.state, 'yes')
  assert.equal(prediction.headline, 'YES.')
  assert.equal(prediction.decisionWbgt, 90.8)
  assert.equal(prediction.decisionMargin, 1.3)
  assert.equal(prediction.decisionSource, 'live')
})

test('answers no when the live conditions estimate reaches the UIL line', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 89,
    nearbyWbgt: 89,
    liveWbgt: 92.4,
    useLiveSignal: true,
  })

  assert.equal(prediction.state, 'no')
  assert.equal(prediction.headline, 'NO.')
  assert.equal(prediction.decisionWbgt, 92.4)
  assert.equal(prediction.decisionSource, 'live')
})

test('uses the exact-campus forecast outside the live decision window', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 92.2,
    nearbyWbgt: 89,
    liveWbgt: 88,
    useLiveSignal: false,
  })

  assert.equal(prediction.state, 'no')
  assert.equal(prediction.decisionWbgt, 92.2)
  assert.equal(prediction.decisionSource, 'forecast')
})

test('does not turn a below-line forecast into no with a fixed allowance', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 89,
    nearbyWbgt: 89,
    liveWbgt: null,
    useLiveSignal: false,
  })

  assert.equal(prediction.state, 'yes')
  assert.equal(prediction.decisionWbgt, 89)
  assert.equal(prediction.decisionMargin, 3.1)
})

test('falls back to the forecast when live weather inputs are unavailable', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: 90,
    nearbyWbgt: 91,
    liveWbgt: null,
    useLiveSignal: true,
  })

  assert.equal(prediction.state, 'yes')
  assert.equal(prediction.decisionWbgt, 90)
  assert.equal(prediction.decisionSource, 'forecast')
})

test('returns pending when the exact-location WBGT forecast is unavailable', () => {
  const prediction = buildPracticePrediction({
    forecastWbgt: null,
    nearbyWbgt: 88,
    liveWbgt: 89,
    useLiveSignal: false,
  })

  assert.equal(prediction.state, 'pending')
  assert.equal(prediction.headline, 'CHECK.')
  assert.equal(prediction.decisionWbgt, null)
  assert.equal(prediction.decisionSource, null)
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
    forecastWbgt: 89,
    nearbyWbgt: 89,
    decisionWbgt: 89,
    decisionSource: 'forecast' as const,
    state: 'yes' as const,
  }
  const duplicate = { ...first, capturedAt: '2026-09-17T18:05:00.000Z' }
  const nextRun = { ...first, capturedAt: '2026-09-17T18:10:00.000Z', sourceUpdatedAt: '2026-09-17T18:08:00.000Z', forecastWbgt: 90 }

  const history = mergeForecastHistory([first], duplicate)
  assert.deepEqual(history, [first])
  assert.deepEqual(mergeForecastHistory(history, nextRun), [first, nextRun])
})
