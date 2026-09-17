export type CloudLayer = { amount?: string | null }

export type OutdoorWbgtInput = {
  airTemperatureF: number
  relativeHumidity: number
  windMph: number
  cloudCover: number
  pressureHpa?: number | null
  latitude: number
  at: Date
}

const DEGREES_TO_RADIANS = Math.PI / 180
const STEFAN_BOLTZMANN = 5.67e-8

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
const sinDegrees = (value: number) => Math.sin(value * DEGREES_TO_RADIANS)
const cosDegrees = (value: number) => Math.cos(value * DEGREES_TO_RADIANS)

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function julianDay(year: number, month: number, day: number) {
  const monthStarts = isLeapYear(year)
    ? [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
    : [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  return monthStarts[month - 1] + day
}

function solarConstantAdjustment(angle: number) {
  return 1 / (
    1 - 9.464e-4 * Math.sin(angle) - 0.01671 * Math.cos(angle)
    + 1.489e-4 * Math.cos(2 * angle) - 2.917e-5 * Math.sin(3 * angle)
    + 3.438e-4 * Math.pow(Math.cos(4 * angle), 2)
  )
}

function maximumSolarFlux(latitude: number, at: Date) {
  const year = at.getUTCFullYear()
  const day = julianDay(year, at.getUTCMonth() + 1, at.getUTCDate())
  const daysInYear = isLeapYear(year) ? 366 : 365
  const annualAngle = day / daysInYear * 2 * Math.PI
  const extraterrestrialRadiation = solarConstantAdjustment(annualAngle) * 1367
  const declination = 0.412 * Math.cos((day + 10) * 2 * Math.PI / daysInYear - Math.PI)
  const projectedRadiation = (
    sinDegrees(latitude) * Math.sin(declination)
    + cosDegrees(latitude) * Math.cos(declination)
  ) * extraterrestrialRadiation

  if (projectedRadiation <= 0) return 0
  const coefficient = (
    -1.56e-12 * Math.pow(projectedRadiation, 4)
    + 5.972e-9 * Math.pow(projectedRadiation, 3)
    - 8.364e-6 * Math.pow(projectedRadiation, 2)
    + 5.183e-3 * projectedRadiation
    - 0.435
  )
  return Math.max(0, projectedRadiation * coefficient)
}

function dewPointFahrenheit(airTemperatureF: number, relativeHumidity: number) {
  const temperatureKelvin = (airTemperatureF - 32) / 1.8 + 273.15
  const a = 0.0091379024 * temperatureKelvin + 6106.396 / temperatureKelvin - Math.log(relativeHumidity / 100)
  const dewPointKelvin = (a - Math.sqrt(a * a - 223.1986)) / 0.0182758048
  return (dewPointKelvin - 273.15) * 1.8 + 32
}

/**
 * Estimates afternoon outdoor WBGT from current weather inputs using the
 * National Weather Service calculator method published at weather.gov/ict/WBGT.
 * It is a weather-derived estimate, not a substitute for the school's globe sensor.
 */
export function estimateOutdoorWbgt(input: OutdoorWbgtInput) {
  const airTemperatureF = input.airTemperatureF
  const relativeHumidity = clamp(input.relativeHumidity, 1, 100)
  const windMph = clamp(input.windMph, 0, 100)
  const cloudFraction = clamp(input.cloudCover, 0, 100) / 100
  const pressureHpa = input.pressureHpa && input.pressureHpa > 0 ? input.pressureHpa : 1000
  const solarFlux = maximumSolarFlux(input.latitude, input.at)
  const dewPointF = dewPointFahrenheit(airTemperatureF, relativeHumidity)
  const airTemperatureC = (airTemperatureF - 32) / 1.8
  const dewPointC = (dewPointF - 32) / 1.8

  const calculationWindMph = Math.max(windMph, 4)
  const windMetersPerHour = calculationWindMph * 1609
  const vaporRatio = Math.exp(17.67 * (dewPointC - airTemperatureC) / (dewPointC + 243.5))
  const saturationTerm = Math.exp(17.502 * airTemperatureC / (240.97 + airTemperatureC))
  const vaporPressure = vaporRatio * (1.0007 + 0.00000346 * pressureHpa) * (6.112 * saturationTerm)
  const vaporRadiation = Math.pow(vaporPressure * 0.575, 1 / 7)
  const diffuseFraction = 1 - cloudFraction
  const radiationTerm = cloudFraction / (4 * 0.707 * STEFAN_BOLTZMANN) + (1.2 / STEFAN_BOLTZMANN) * diffuseFraction
  const combinedRadiation = solarFlux * radiationTerm + vaporRadiation * Math.pow(airTemperatureC, 4)
  const convection = (Math.pow(windMetersPerHour, 0.58) * 0.315) / 5.3865e-8
  const globeTemperatureF = ((combinedRadiation + convection * airTemperatureC + 7680000) / (convection + 256000)) * 1.8 + 32

  const psychrometricPressure = 0.0006355 * pressureHpa
  const saturatedPressure = 6.11 * Math.pow(10, airTemperatureC * 7.5 / (airTemperatureC + 237.3))
  const dewPressure = 6.11 * Math.pow(10, dewPointC * 7.5 / (dewPointC + 237.3))
  const pressureDifference = saturatedPressure - dewPressure
  const temperatureDifference = airTemperatureC - dewPointC
  let wetBulbC = temperatureDifference === 0
    ? airTemperatureC
    : (airTemperatureC * psychrometricPressure + dewPointC * pressureDifference / temperatureDifference)
      / (psychrometricPressure + pressureDifference / temperatureDifference)

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const wetBulbKelvin = wetBulbC + 273.15
    const wetBulbPressure = 6.11 * Math.pow(10, wetBulbC * 7.5 / (wetBulbC + 237.3))
    const difference = psychrometricPressure * (airTemperatureC - wetBulbC) - (wetBulbPressure - dewPressure)
    const derivative = wetBulbPressure * (0.0091 - 6106.4 / Math.pow(wetBulbKelvin, 2)) - psychrometricPressure
    wetBulbC = wetBulbKelvin - difference / derivative - 273.15
  }

  const wetBulbF = wetBulbC * 1.8 + 32
  const windMetersPerSecond = windMph * 0.4474
  const naturalWetBulbF = clamp(wetBulbF + 0.0021 * solarFlux - 0.43 * windMetersPerSecond + 1.93, 50, 85)
  return 0.2 * globeTemperatureF + 0.7 * naturalWetBulbF + 0.1 * airTemperatureF
}

const CLOUD_LAYER_COVERAGE: Record<string, number> = {
  CLR: 0,
  SKC: 0,
  NCD: 0,
  FEW: 12.5,
  SCT: 37.5,
  BKN: 75,
  OVC: 100,
  VV: 100,
}

export function cloudCoverFromLayers(layers: CloudLayer[]) {
  const coverage = layers
    .map((layer) => CLOUD_LAYER_COVERAGE[layer.amount?.toUpperCase() ?? ''])
    .filter((value): value is number => value !== undefined)
  return coverage.length > 0 ? Math.max(...coverage) : null
}
