export type Flag = 'green' | 'yellow' | 'orange' | 'red' | 'black'
export type PredictionState = 'yes' | 'no' | 'pending'
export type DecisionSource = 'live' | 'forecast'

export const UIL_NO_PRACTICE_WBGT = 92.1

type PredictionInput = {
  forecastWbgt: number | null
  nearbyWbgt: number | null
  liveWbgt: number | null
  useLiveSignal: boolean
}

export type PracticePrediction = {
  state: PredictionState
  headline: 'YES.' | 'NO.' | 'CHECK.'
  decisionWbgt: number | null
  decisionMargin: number | null
  decisionSource: DecisionSource | null
  spatialHigh: number | null
}

export type ForecastSnapshot = {
  capturedAt: string
  sourceUpdatedAt: string | null
  target: string
  forecastWbgt: number | null
  nearbyWbgt: number | null
  decisionWbgt: number | null
  decisionSource: DecisionSource | null
  state: PredictionState
}

const roundOne = (value: number) => Math.round(value * 10) / 10

export function getUilFlag(wbgt: number): Flag {
  if (wbgt < 82) return 'green'
  if (wbgt < 87) return 'yellow'
  if (wbgt <= 90) return 'orange'
  if (wbgt < UIL_NO_PRACTICE_WBGT) return 'red'
  return 'black'
}

export function buildPracticePrediction(input: PredictionInput): PracticePrediction {
  const canUseLiveEstimate = input.useLiveSignal && input.liveWbgt !== null
  const decisionSource: DecisionSource | null = canUseLiveEstimate
    ? 'live'
    : input.forecastWbgt !== null
      ? 'forecast'
      : null
  const decisionWbgt = canUseLiveEstimate ? input.liveWbgt : input.forecastWbgt

  if (decisionWbgt === null) {
    return {
      state: 'pending',
      headline: 'CHECK.',
      decisionWbgt: null,
      decisionMargin: null,
      decisionSource: null,
      spatialHigh: input.nearbyWbgt,
    }
  }

  const spatialHigh = input.forecastWbgt === null
    ? input.nearbyWbgt
    : Math.max(input.forecastWbgt, input.nearbyWbgt ?? input.forecastWbgt)
  const roundedDecisionWbgt = roundOne(decisionWbgt)
  const decisionMargin = roundOne(UIL_NO_PRACTICE_WBGT - roundedDecisionWbgt)
  const state = roundedDecisionWbgt >= UIL_NO_PRACTICE_WBGT ? 'no' : 'yes'

  return {
    state,
    headline: state === 'no' ? 'NO.' : 'YES.',
    decisionWbgt: roundedDecisionWbgt,
    decisionMargin,
    decisionSource,
    spatialHigh,
  }
}

export function mergeForecastHistory(history: ForecastSnapshot[], snapshot: ForecastSnapshot, limit = 500): ForecastSnapshot[] {
  const alreadyStored = history.some((item) => item.sourceUpdatedAt === snapshot.sourceUpdatedAt && item.target === snapshot.target)
  if (alreadyStored) return history
  return [...history, snapshot].slice(-limit)
}
