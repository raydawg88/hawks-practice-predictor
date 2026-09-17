export type Flag = 'green' | 'yellow' | 'orange' | 'red' | 'black'
export type PredictionState = 'likely-on' | 'watch' | 'likely-off' | 'pending'

export const UIL_NO_PRACTICE_WBGT = 92.1
export const INCIDENT_SAFETY_ALLOWANCE = 6
export const LIVE_TEMPERATURE_WARNING_GAP = 3

type PredictionInput = {
  forecastWbgt: number | null
  nearbyWbgt: number | null
  observedAirTemperature: number | null
  modeledCurrentAirTemperature: number | null
  useLiveSignal: boolean
}

export type PracticePrediction = {
  state: PredictionState
  headline: 'LIKELY ON.' | 'WATCH.' | 'LIKELY OFF.' | 'CHECK.'
  planningCeiling: number | null
  ceilingMargin: number | null
  spatialHigh: number | null
  liveTemperatureGap: number | null
  liveWarning: boolean
}

export type ForecastSnapshot = {
  capturedAt: string
  sourceUpdatedAt: string | null
  target: string
  forecastWbgt: number | null
  nearbyWbgt: number | null
  planningCeiling: number | null
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
  if (input.forecastWbgt === null) {
    return {
      state: 'pending',
      headline: 'CHECK.',
      planningCeiling: null,
      ceilingMargin: null,
      spatialHigh: null,
      liveTemperatureGap: null,
      liveWarning: false,
    }
  }

  const spatialHigh = Math.max(input.forecastWbgt, input.nearbyWbgt ?? input.forecastWbgt)
  const planningCeiling = roundOne(spatialHigh + INCIDENT_SAFETY_ALLOWANCE)
  const ceilingMargin = roundOne(UIL_NO_PRACTICE_WBGT - planningCeiling)
  const liveTemperatureGap = input.observedAirTemperature !== null && input.modeledCurrentAirTemperature !== null
    ? roundOne(input.observedAirTemperature - input.modeledCurrentAirTemperature)
    : null
  const liveWarning = input.useLiveSignal && liveTemperatureGap !== null && liveTemperatureGap >= LIVE_TEMPERATURE_WARNING_GAP

  if (input.forecastWbgt >= UIL_NO_PRACTICE_WBGT) {
    return { state: 'likely-off', headline: 'LIKELY OFF.', planningCeiling, ceilingMargin, spatialHigh, liveTemperatureGap, liveWarning }
  }

  if (planningCeiling >= UIL_NO_PRACTICE_WBGT || liveWarning) {
    return { state: 'watch', headline: 'WATCH.', planningCeiling, ceilingMargin, spatialHigh, liveTemperatureGap, liveWarning }
  }

  return { state: 'likely-on', headline: 'LIKELY ON.', planningCeiling, ceilingMargin, spatialHigh, liveTemperatureGap, liveWarning }
}

export function mergeForecastHistory(history: ForecastSnapshot[], snapshot: ForecastSnapshot, limit = 500): ForecastSnapshot[] {
  const alreadyStored = history.some((item) => item.sourceUpdatedAt === snapshot.sourceUpdatedAt && item.target === snapshot.target)
  if (alreadyStored) return history
  return [...history, snapshot].slice(-limit)
}
