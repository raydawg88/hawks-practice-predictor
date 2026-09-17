import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, Cloud, CloudLightning, CloudRain, CloudSun, Database, Droplets, ExternalLink, Fan, Gauge, GlassWater, MapPin, RefreshCw, ShieldCheck, Shirt, Snowflake, Sun, TriangleAlert, Wind } from 'lucide-react'
import WeatherBackdrop from './WeatherBackdrop'
import { buildPracticePrediction, getUilFlag, INCIDENT_SAFETY_ALLOWANCE, mergeForecastHistory, type Flag, type ForecastSnapshot, type PracticePrediction, UIL_NO_PRACTICE_WBGT } from './prediction'
const ZIP_CODE = '75032'
const TIME_ZONE = 'America/Chicago'
const AUTO_REFRESH_MS = 5 * 60 * 1000
const PRACTICE_COORDINATES = { latitude: 32.845676, longitude: -96.470486 }
const FALLBACK_NEARBY_COORDINATES = { latitude: 32.886, longitude: -96.4095 }
const PRACTICE_LOCATION_NAME = 'Rockwall-Heath High School'

type GridValue = { validTime: string; value: number | null }
type GridField = { uom?: string; values?: GridValue[] }
type ForecastPeriod = {
  startTime: string
  isDaytime: boolean
  temperature: number
  temperatureUnit: string
  shortForecast: string
  detailedForecast: string
  windSpeed: string
  probabilityOfPrecipitation?: { value: number | null }
  relativeHumidity?: { value: number | null }
}
type Outlook = {
  date: Date
  day: string
  dateLabel: string
  wbgt: number | null
  temperature: number | null
  condition: string
  detail: string
  rainChance: number
  humidity: number
  wind: string
  cloudCover: number
  flag: Flag | null
  nearbyWbgt: number | null
  prediction: PracticePrediction
}
type Observation = {
  station: string
  stationName: string
  time: Date
  condition: string
  temperature: number | null
  humidity: number | null
  wind: number | null
}
type WeatherState = {
  outlooks: Outlook[]
  currentWbgt: number | null
  office: string | null
  gridId: string
  nearbyGridId: string
  coordinates: { latitude: number; longitude: number }
  nearbyCoordinates: { latitude: number; longitude: number }
  observation: Observation | null
  modeledCurrentAirTemperature: number | null
  sourceUpdatedAt: Date | null
  updatedAt: Date
}

const FLAG_META: Record<Flag, { name: string; color: string; verdict: string; instruction: string; rules: string[] }> = {
  green: {
    name: 'Normal heat', color: '#39A96B', verdict: 'YES.', instruction: 'Outdoor practice is heat-permitted under normal UIL limits.',
    rules: ['At least 3 rest breaks each hour', 'Each break lasts at least 3 minutes'],
  },
  yellow: {
    name: 'Heat watch', color: '#F3C74F', verdict: 'YES.', instruction: 'Practice is heat-permitted with added caution.',
    rules: ['Use discretion for intense or prolonged exercise', 'At least 3 breaks/hour · 4 minutes each', 'Onsite rapid-cooling zone required'],
  },
  orange: {
    name: 'More breaks', color: '#F47B35', verdict: 'YES.', instruction: 'Practice is heat-permitted with major modifications.',
    rules: ['2-hour maximum', 'At least 4 breaks/hour · 4 minutes each', 'Onsite rapid-cooling zone required'],
  },
  red: {
    name: 'Strict limits', color: '#C8102E', verdict: 'YES.', instruction: 'Practice is heat-permitted only under strict limits.',
    rules: ['1-hour maximum', '20 minutes of rest distributed through the hour', 'Onsite rapid-cooling zone required'],
  },
  black: {
    name: 'No practice', color: '#111111', verdict: 'NO.', instruction: 'No outdoor workouts under the UIL heat plan.',
    rules: ['Delay outdoor practice until a cooler WBGT is reached'],
  },
}

const THRESHOLDS = [
  { flag: 'Normal practice', range: '< 82.0°', color: '#39A96B', note: '3 breaks/hour · 3 minutes each' },
  { flag: 'Heat watch', range: '82.0–86.9°', color: '#F3C74F', note: '3 breaks/hour · 4 minutes each · cooling zone' },
  { flag: 'More breaks', range: '87.0–90.0°', color: '#F47B35', note: '2-hour max · 4 breaks/hour · 4 minutes each' },
  { flag: 'Strict limits', range: '90.1–92.0°', color: '#C8102E', note: '1-hour max · 20 minutes of rest during the hour' },
  { flag: 'No practice', range: '≥ 92.1°', color: '#111111', note: 'Cancel or move indoors' },
]

function parseDuration(duration: string): number {
  const match = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!match) return 3600000
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match
  return ((Number(days) * 24 + Number(hours)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000
}

function getInterval(validTime: string) {
  const [startText, duration = 'PT1H'] = validTime.split('/')
  const start = new Date(startText)
  return { start, end: new Date(start.getTime() + parseDuration(duration)) }
}

function dateKey(date: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function targetForOffset(dayOffset: number, hour: number, minute: number) {
  const todayText = dateKey(new Date())
  const [year, month, day] = todayText.split('-').map(Number)
  const targetCalendar = new Date(Date.UTC(year, month - 1, day + dayOffset, 12))
  const localHourAtNoon = Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(targetCalendar))
  const offsetHours = localHourAtNoon - 12
  return new Date(Date.UTC(targetCalendar.getUTCFullYear(), targetCalendar.getUTCMonth(), targetCalendar.getUTCDate(), hour - offsetHours, minute))
}

function gridValueAt(field: GridField | undefined, target: Date) {
  return field?.values?.find((item) => {
    if (item.value === null) return false
    const interval = getInterval(item.validTime)
    return interval.start <= target && interval.end > target
  })?.value ?? null
}

function toFahrenheit(value: number | null, unit = '') {
  if (value === null) return null
  return unit.toLowerCase().includes('degc') ? value * 1.8 + 32 : value
}

function celsiusToFahrenheit(value: number | null) {
  return value === null ? null : value * 1.8 + 32
}

function kilometersToMiles(value: number | null) {
  return value === null ? null : value * 0.621371
}

async function fetchLatestObservation(stationsUrl: string): Promise<Observation | null> {
  try {
    const stationsResponse = await fetch(stationsUrl, { headers: { Accept: 'application/geo+json' } })
    if (!stationsResponse.ok) return null
    const stations = await stationsResponse.json()
    const candidates = (stations.features ?? []).slice(0, 4)
    const observations = await Promise.all(candidates.map(async (feature: { properties?: { stationIdentifier?: string; name?: string } }) => {
      const station = feature.properties
      if (!station?.stationIdentifier) return null
      const response = await fetch(`https://api.weather.gov/stations/${station.stationIdentifier}/observations/latest`, { headers: { Accept: 'application/geo+json' } })
      if (!response.ok) return null
      const observation = await response.json()
      const properties = observation.properties
      return {
        station: station.stationIdentifier,
        stationName: station.name ?? station.stationIdentifier,
        time: new Date(properties.timestamp),
        condition: properties.textDescription ?? 'Current conditions',
        temperature: celsiusToFahrenheit(properties.temperature?.value ?? null),
        humidity: properties.relativeHumidity?.value ?? null,
        wind: kilometersToMiles(properties.windSpeed?.value ?? null),
      } satisfies Observation
    }))

    return observations.find((observation) => observation?.temperature !== null) ?? observations.find(Boolean) ?? null
  } catch {
    return null
  }
}

function WeatherGlyph({ condition, className = 'h-6 w-6' }: { condition: string; className?: string }) {
  if (/thunder|storm/i.test(condition)) return <CloudLightning className={className} />
  if (/rain|shower/i.test(condition)) return <CloudRain className={className} />
  if (/partly|mostly sunny|mostly clear/i.test(condition)) return <CloudSun className={className} />
  if (/cloud|overcast|fog/i.test(condition)) return <Cloud className={className} />
  return <Sun className={className} />
}

function plainDecision(outlook: Outlook | null) {
  if (!outlook) return 'FORECAST PENDING'
  if (outlook.prediction.state === 'no') return 'NO PRACTICE'
  if (outlook.prediction.state === 'yes') return 'YES · PRACTICE'
  return 'FORECAST PENDING'
}

function predictionReason(outlook: Outlook | null) {
  if (!outlook || outlook.wbgt === null) return 'Waiting for the exact-location WBGT forecast.'
  const { prediction } = outlook
  if (prediction.state === 'no') {
    if (outlook.wbgt >= UIL_NO_PRACTICE_WBGT) return `NO — the NWS forecast itself reaches the ${UIL_NO_PRACTICE_WBGT}°F no-practice line.`
    if (prediction.liveWarning) return `NO — live air temperature is running ${prediction.liveTemperatureGap?.toFixed(1)}°F hotter than the model.`
    return `NO — the forecast is below the line, but the conservative planning ceiling reaches ${prediction.planningCeiling?.toFixed(1)}°F.`
  }
  return `YES — the conservative ${prediction.planningCeiling?.toFixed(1)}°F planning ceiling stays ${prediction.ceilingMargin?.toFixed(1)}° below the UIL line.`
}

function DecisionMeter({ outlook }: { outlook: Outlook | null }) {
  const minimum = 78
  const maximum = 100
  const wbgt = outlook?.wbgt ?? null
  const ceiling = outlook?.prediction.planningCeiling ?? null
  const marker = Math.max(0, Math.min(100, (((wbgt ?? minimum) - minimum) / (maximum - minimum)) * 100))
  const ceilingMarker = Math.max(0, Math.min(100, (((ceiling ?? minimum) - minimum) / (maximum - minimum)) * 100))
  const line = ((UIL_NO_PRACTICE_WBGT - minimum) / (maximum - minimum)) * 100
  const rangeStart = Math.min(marker, ceilingMarker)
  const rangeWidth = Math.max(0, ceilingMarker - marker)
  const margin = outlook?.prediction.ceilingMargin ?? null
  const message = margin === null
    ? 'Waiting for the forecast'
    : margin <= 0
      ? `Planning ceiling is ${Math.abs(margin).toFixed(1)}°F over the line`
      : `Planning ceiling is ${margin.toFixed(1)}°F below the line`

  return (
    <div className="rounded-[1.75rem] border border-white/25 bg-black/65 p-5 shadow-2xl backdrop-blur-xl sm:p-7 lg:p-8">
      <div className="grid gap-6 md:grid-cols-12 md:items-end">
        <div className="md:col-span-5">
          <div className="text-[10px] font-semibold tracking-[0.13em] text-[#f0a9b7]">THE DECISION METER · {(outlook?.day ?? 'TODAY').toUpperCase()} AROUND 3 PM</div>
          <h2 className="mt-3 text-[clamp(2rem,4vw,4rem)] font-medium leading-[0.9] tracking-[-0.055em]">HOW CLOSE ARE WE<br />TO NO PRACTICE?</h2>
        </div>
        <div className="md:col-span-3 md:border-l md:border-white/15 md:pl-6">
          <div className="text-[9px] font-semibold tracking-[0.12em] text-white/45">PLANNING CEILING</div>
          <div className="mt-2 text-5xl font-medium tracking-[-0.06em] sm:text-6xl">{ceiling?.toFixed(1) ?? '—'}°</div>
          <p className="mt-2 text-[10px] leading-4 text-white/45">Not a measurement. A conservative upper estimate.</p>
        </div>
        <div className="md:col-span-4 md:text-right">
          <div className="text-[9px] font-semibold tracking-[0.12em] text-white/45">RISK DISTANCE</div>
          <div className="mt-2 text-xl font-semibold sm:text-2xl">{message}</div>
        </div>
      </div>
      <div className="relative mt-10 h-4 bg-white/20" role="img" aria-label={`NWS forecast ${wbgt?.toFixed(1) ?? 'unavailable'} degrees WBGT, conservative planning ceiling ${ceiling?.toFixed(1) ?? 'unavailable'} degrees, no outdoor practice line ${UIL_NO_PRACTICE_WBGT} degrees WBGT`}>
        <div className="absolute inset-y-0 right-0 bg-hawk/80" style={{ left: `${line}%` }} />
        {wbgt !== null && ceiling !== null && <div className="absolute inset-y-0 bg-[#f5b7c3]/60" style={{ left: `${rangeStart}%`, width: `${rangeWidth}%` }} />}
        <div className="absolute -bottom-3 -top-3 w-px bg-white" style={{ left: `${line}%` }} />
        <div className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-black" style={{ left: `${marker}%` }} />
        <div className="absolute top-1/2 h-7 w-2 -translate-x-1/2 -translate-y-1/2 bg-[#f5b7c3] shadow-[0_0_24px_rgba(200,16,46,.9)]" style={{ left: `${ceilingMarker}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-[9px] font-semibold tracking-[0.08em] text-white/50">
        <span><i className="mr-2 inline-block h-3 w-3 rounded-full border-2 border-white bg-black align-middle" />NWS {wbgt?.toFixed(1) ?? '—'}°</span>
        <span className="text-center"><i className="mr-2 inline-block h-3 w-1 bg-[#f5b7c3] align-middle" />CEILING {ceiling?.toFixed(1) ?? '—'}°</span>
        <span className="text-right">{UIL_NO_PRACTICE_WBGT}° · NO PRACTICE</span>
      </div>
      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 border-t border-white/15 pt-4 text-[10px] text-white/50"><span><strong className="text-white">Forecast</strong> is the exact-campus NWS value</span><span><strong className="text-white">Ceiling</strong> includes nearby-grid spread + {INCIDENT_SAFETY_ALLOWANCE}°F incident allowance</span><span><strong className="text-white">The school</strong> makes the official call</span></div>
    </div>
  )
}

function HawksMark() {
  return (
    <div className="flex items-center gap-3" aria-label="Rockwall-Heath Hawks Practice Predictor">
      <img src="/heath-varsity-h.png" alt="Rockwall-Heath varsity H" className="h-12 w-auto object-contain sm:h-14" />
      <div className="hidden border-l border-white/20 pl-3 text-[10px] font-semibold tracking-[0.1em] text-white/65 sm:block">PRACTICE<br />PREDICTOR</div>
    </div>
  )
}

export default function App() {
  const [weather, setWeather] = useState<WeatherState | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scrollProgress, setScrollProgress] = useState(0)
  const [reduceMotion, setReduceMotion] = useState(false)

  const loadWeather = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let nearbyCoordinates = FALLBACK_NEARBY_COORDINATES
      try {
        const zipResponse = await fetch(`https://api.zippopotam.us/us/${ZIP_CODE}`)
        if (!zipResponse.ok) throw new Error('ZIP lookup failed')
        const zipData = await zipResponse.json()
        nearbyCoordinates = { latitude: Number(zipData.places[0].latitude), longitude: Number(zipData.places[0].longitude) }
      } catch { /* The known Heath ZIP centroid keeps the cross-check usable. */ }

      const [pointsResponse, nearbyPointsResponse] = await Promise.all([
        fetch(`https://api.weather.gov/points/${PRACTICE_COORDINATES.latitude.toFixed(4)},${PRACTICE_COORDINATES.longitude.toFixed(4)}`, { headers: { Accept: 'application/geo+json' } }),
        fetch(`https://api.weather.gov/points/${nearbyCoordinates.latitude.toFixed(4)},${nearbyCoordinates.longitude.toFixed(4)}`, { headers: { Accept: 'application/geo+json' } }),
      ])
      if (!pointsResponse.ok) throw new Error('The National Weather Service exact-location feed is unavailable.')
      const points = await pointsResponse.json()
      const nearbyPoints = nearbyPointsResponse.ok ? await nearbyPointsResponse.json() : points

      const [gridResponse, nearbyGridResponse, dailyResponse, observation] = await Promise.all([
        fetch(points.properties.forecastGridData, { headers: { Accept: 'application/geo+json' } }),
        fetch(nearbyPoints.properties.forecastGridData, { headers: { Accept: 'application/geo+json' } }),
        fetch(points.properties.forecast, { headers: { Accept: 'application/geo+json' } }),
        fetchLatestObservation(points.properties.observationStations),
      ])
      if (!gridResponse.ok) throw new Error('The National Weather Service WBGT feed is unavailable.')
      const grid = await gridResponse.json()
      const nearbyGrid = nearbyGridResponse.ok ? await nearbyGridResponse.json() : grid
      const daily = dailyResponse.ok ? await dailyResponse.json() : null
      const properties = grid.properties
      const nearbyProperties = nearbyGrid.properties
      const periods: ForecastPeriod[] = daily?.properties?.periods ?? []
      const modeledCurrentTarget = observation?.time ?? new Date()
      const modeledCurrentAirTemperature = toFahrenheit(gridValueAt(properties.temperature, modeledCurrentTarget), properties.temperature?.uom)

      const outlooks = Array.from({ length: 7 }, (_, index): Outlook => {
        const target = targetForOffset(index, 14, 45)
        const dayPeriod = periods.find((period) => period.isDaytime && dateKey(new Date(period.startTime)) === dateKey(target))
        const wbgt = toFahrenheit(gridValueAt(properties.wetBulbGlobeTemperature, target), properties.wetBulbGlobeTemperature?.uom)
        const nearbyWbgt = toFahrenheit(gridValueAt(nearbyProperties.wetBulbGlobeTemperature, target), nearbyProperties.wetBulbGlobeTemperature?.uom)
        const gridTemp = toFahrenheit(gridValueAt(properties.temperature, target), properties.temperature?.uom)
        const rainChance = gridValueAt(properties.probabilityOfPrecipitation, target) ?? dayPeriod?.probabilityOfPrecipitation?.value ?? 0
        const humidity = gridValueAt(properties.relativeHumidity, target) ?? dayPeriod?.relativeHumidity?.value ?? 0
        const cloudCover = gridValueAt(properties.skyCover, target) ?? (/cloud/i.test(dayPeriod?.shortForecast ?? '') ? 70 : 18)
        const prediction = buildPracticePrediction({
          forecastWbgt: wbgt,
          nearbyWbgt,
          observedAirTemperature: observation?.temperature ?? null,
          modeledCurrentAirTemperature,
          useLiveSignal: index === 0,
        })
        const condition = rainChance >= 40
          ? (/thunder/i.test(dayPeriod?.shortForecast ?? '') ? 'Thunderstorms likely' : 'Chance of showers')
          : cloudCover >= 70
            ? 'Cloudy'
            : cloudCover >= 35
              ? 'Partly cloudy'
              : cloudCover >= 15
                ? 'Mostly sunny'
                : 'Sunny'

        return {
          date: target,
          day: index === 0 ? 'Today' : new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(target),
          dateLabel: new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric' }).format(target),
          wbgt,
          temperature: gridTemp ?? dayPeriod?.temperature ?? null,
          condition,
          detail: dayPeriod?.detailedForecast ?? condition,
          rainChance,
          humidity,
          wind: dayPeriod?.windSpeed ?? '—',
          cloudCover,
          flag: prediction.planningCeiling === null ? null : getUilFlag(prediction.planningCeiling),
          nearbyWbgt,
          prediction,
        }
      })

      const sourceUpdatedAt = properties.updateTime ? new Date(properties.updateTime) : null
      const nextWeather: WeatherState = {
        outlooks,
        currentWbgt: toFahrenheit(gridValueAt(properties.wetBulbGlobeTemperature, new Date()), properties.wetBulbGlobeTemperature?.uom),
        office: points.properties.cwa ?? null,
        gridId: points.properties.forecastGridData.replace('https://api.weather.gov/gridpoints/', ''),
        nearbyGridId: nearbyPoints.properties.forecastGridData.replace('https://api.weather.gov/gridpoints/', ''),
        coordinates: PRACTICE_COORDINATES,
        nearbyCoordinates,
        observation,
        modeledCurrentAirTemperature,
        sourceUpdatedAt,
        updatedAt: new Date(),
      }
      setWeather(nextWeather)

      try {
        const storageKey = 'hawks-practice-forecast-history-v1'
        const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as ForecastSnapshot[]
        const today = outlooks[0]
        const snapshot: ForecastSnapshot = {
          capturedAt: nextWeather.updatedAt.toISOString(),
          sourceUpdatedAt: sourceUpdatedAt?.toISOString() ?? null,
          target: today.date.toISOString(),
          forecastWbgt: today.wbgt,
          nearbyWbgt: today.nearbyWbgt,
          planningCeiling: today.prediction.planningCeiling,
          state: today.prediction.state,
        }
        window.localStorage.setItem(storageKey, JSON.stringify(mergeForecastHistory(stored, snapshot)))
      } catch { /* Forecast history is optional when browser storage is unavailable. */ }
    } catch (caught) {
      setWeather(null)
      setError(caught instanceof Error ? caught.message : 'Weather data could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadWeather(), 0)
    const refreshTimer = window.setInterval(() => void loadWeather(), AUTO_REFRESH_MS)
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') void loadWeather()
    }
    document.addEventListener('visibilitychange', refreshOnReturn)
    window.addEventListener('online', refreshOnReturn)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(refreshTimer)
      document.removeEventListener('visibilitychange', refreshOnReturn)
      window.removeEventListener('online', refreshOnReturn)
    }
  }, [loadWeather])

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updateMotion = () => setReduceMotion(motion.matches)
    const updateScroll = () => {
      setScrollProgress(window.scrollY / Math.max(window.innerHeight, 1))
    }
    updateMotion()
    updateScroll()
    motion.addEventListener('change', updateMotion)
    window.addEventListener('scroll', updateScroll, { passive: true })
    return () => {
      motion.removeEventListener('change', updateMotion)
      window.removeEventListener('scroll', updateScroll)
    }
  }, [])

  const selected = weather?.outlooks[selectedIndex] ?? null
  const status = selected?.flag ? FLAG_META[selected.flag] : null
  const accent = selected?.prediction.state === 'yes' ? '#61D18B' : '#C8102E'
  const questionDay = selectedIndex === 0
    ? 'TODAY'
    : selected
      ? new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long' }).format(selected.date).toUpperCase()
      : 'TODAY'
  const updated = useMemo(() => weather ? new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(weather.updatedAt) : '—', [weather])
  const sourceUpdated = useMemo(() => weather?.sourceUpdatedAt ? new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(weather.sourceUpdatedAt) : '—', [weather])
  const observationTime = useMemo(() => weather?.observation ? new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(weather.observation.time) : '—', [weather])
  const heroShift = reduceMotion ? 0 : Math.min(scrollProgress * 68, 68)
  const storyShift = reduceMotion ? 0 : Math.max(-40, Math.min(60, (scrollProgress - 1.1) * 36))

  return (
    <main className="min-h-screen bg-[#0a0d0f] font-sans text-white">
      <section className="relative isolate flex min-h-[880px] flex-col overflow-hidden px-4 pb-4 pt-4 sm:min-h-[900px] sm:px-8 sm:pb-6 sm:pt-5 lg:min-h-[940px] lg:px-12">
        <WeatherBackdrop
          cloudCover={selected?.cloudCover ?? 35}
          rainChance={selected?.rainChance ?? 0}
          condition={selected?.condition ?? 'Sunny'}
          progress={scrollProgress}
          reduceMotion={reduceMotion}
        />

        <header className="relative z-20 mx-auto flex w-full max-w-[1600px] items-center justify-between border-b border-white/25 pb-4">
          <HawksMark />
          <div className="hidden items-center gap-7 text-[10px] font-medium tracking-[0.08em] text-white/75 md:flex">
            <span className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5" /> ROCKWALL-HEATH CAMPUS</span>
            <span>NWS GRID {weather?.gridId ?? 'FWD / —'}</span>
            <span>NWS ISSUED {sourceUpdated}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-white/25 bg-black/15 px-3 py-2 text-[9px] font-semibold tracking-[0.1em] backdrop-blur-md sm:flex">
              <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" /></span>
              AUTO-UPDATES · 5 MIN
            </span>
            <button onClick={() => void loadWeather()} disabled={loading} className="rounded-full border border-white/30 bg-black/15 p-2.5 backdrop-blur-md transition-colors hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-50" aria-label="Refresh forecast now">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </header>

        <div className="relative z-10 mx-auto w-full max-w-[1600px] pb-8 pt-8 sm:pt-10 lg:pb-10">
          <div className="grid gap-7 lg:grid-cols-12 lg:items-end" style={{ transform: `translate3d(0, ${-heroShift * 0.18}px, 0)` }}>
            <div className="lg:col-span-8">
            <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] font-semibold tracking-[0.1em] text-white/75 md:hidden">
              <span className="flex items-center gap-1.5"><MapPin className="h-3 w-3" /> RHHS CAMPUS</span>
              <span>NWS {weather?.office ?? 'FWD'} · ISSUED {sourceUpdated}</span>
            </div>
            <div className="mb-4 flex items-center gap-3 text-[11px] font-semibold tracking-[0.12em]">
              <span className="h-2.5 w-2.5" style={{ backgroundColor: accent }} />
              PRACTICE PREDICTOR · {plainDecision(selected)} · 2:45–3:00 PM
            </div>
            <h1 className="max-w-5xl text-[clamp(2.6rem,6.4vw,6.7rem)] font-medium leading-[0.86] tracking-[-0.072em] text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.38)]">
              IS THERE OUTDOOR<br />PRACTICE {questionDay}?
            </h1>
            <div className="mt-6 flex flex-wrap items-end gap-x-8 gap-y-5">
              <div className="text-[clamp(4.1rem,10.8vw,10.5rem)] font-bold leading-[0.7] tracking-[-0.085em] text-white drop-shadow-[0_4px_25px_rgba(0,0,0,0.32)]">
                {loading ? '…' : error ? 'CHECK.' : selected?.prediction.headline ?? '—'}
              </div>
            </div>
            </div>
            <div className="lg:col-span-4">
              <div className="border-l-2 pl-5" style={{ borderColor: accent }}>
                <p className="text-xl font-semibold leading-6">{error ?? predictionReason(selected)}</p>
                <p className="mt-3 text-sm leading-5 text-white/70">This is a planning call, not an official cancellation or approval.</p>
              </div>
              <div className="mt-6 flex max-w-xl items-start gap-3 rounded-xl border border-white/25 bg-black/45 px-4 py-3 text-xs leading-5 text-white/70 backdrop-blur-md">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#f0a9b7]" />
                <p><strong className="text-white">The field reading wins.</strong> UIL requires a current reading within 15 minutes before practice and continued checks during practice.</p>
              </div>
            </div>
          </div>

          <div className="mt-8" style={{ transform: `translate3d(0, ${heroShift * 0.08}px, 0)` }}>
            <DecisionMeter outlook={selected} />
          </div>

          {selected?.prediction.state === 'no' && (
            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-white/25 bg-hawk px-5 py-4 text-white shadow-xl">
              <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" />
              <p className="text-sm font-semibold leading-5">Plan for no outdoor practice unless the school announces otherwise. This predictor chooses NO whenever the conservative ceiling crosses the UIL line.</p>
            </div>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <section className="rounded-[1.5rem] border border-white/20 bg-black/50 p-5 backdrop-blur-xl sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <div><p className="text-[10px] font-semibold tracking-[0.12em] text-[#f0a9b7]">1 · RIGHT NOW</p><h2 className="mt-2 text-2xl font-medium">What is happening</h2></div>
                <span className="text-right text-[9px] leading-4 text-white/45">{weather?.observation?.station ?? 'NWS'}<br />AS OF {observationTime}</span>
              </div>
              <div className="mt-6 grid grid-cols-2 border-y border-white/15 py-5">
                <div><span className="text-[9px] tracking-[0.1em] text-white/45">AIR TEMPERATURE</span><strong className="mt-2 block text-4xl font-medium tracking-[-0.06em]">{weather?.observation?.temperature?.toFixed(0) ?? '—'}°</strong></div>
                <div className="border-l border-white/15 pl-5"><span className="text-[9px] tracking-[0.1em] text-white/45">ESTIMATED WBGT</span><strong className="mt-2 block text-4xl font-medium tracking-[-0.06em]">{weather?.currentWbgt?.toFixed(1) ?? '—'}°</strong></div>
              </div>
              <div className="mt-5 flex items-center gap-3"><WeatherGlyph condition={weather?.observation?.condition ?? 'Current'} className="h-6 w-6 text-[#ffd278]" /><strong>{weather?.observation?.condition ?? 'Loading conditions'}</strong></div>
              <div className="mt-5 grid grid-cols-2 text-xs"><div><Droplets className="mb-2 h-4 w-4 text-white/45" /><strong>{weather?.observation?.humidity?.toFixed(0) ?? '—'}%</strong><span className="block text-[9px] text-white/40">HUMIDITY</span></div><div><Wind className="mb-2 h-4 w-4 text-white/45" /><strong>{weather?.observation?.wind?.toFixed(0) ?? '—'} mph</strong><span className="block text-[9px] text-white/40">WIND</span></div></div>
              {selected?.prediction.liveTemperatureGap !== null && selected?.prediction.liveTemperatureGap !== undefined && <p className={`mt-5 text-xs leading-5 ${selected.prediction.liveWarning ? 'font-semibold text-[#ffd278]' : 'text-white/50'}`}>The station is {Math.abs(selected.prediction.liveTemperatureGap).toFixed(1)}°F {selected.prediction.liveTemperatureGap >= 0 ? 'hotter' : 'cooler'} than the NWS grid expected right now.</p>}
              <p className="mt-3 text-[10px] leading-4 text-white/45">Air temperature is observed at the nearest reporting station. Current WBGT is modeled at campus, not measured by the school sensor.</p>
            </section>

            <section className="rounded-[1.5rem] border border-white/20 bg-black/50 p-5 backdrop-blur-xl sm:p-6">
              <div><p className="text-[10px] font-semibold tracking-[0.12em] text-[#f0a9b7]">2 · {selected?.day.toUpperCase() ?? 'TODAY'} AROUND 3 PM</p><h2 className="mt-2 text-2xl font-medium">What NWS predicts</h2></div>
              <div className="mt-6 grid grid-cols-2 border-y border-white/15 py-5">
                <div><span className="text-[9px] tracking-[0.1em] text-white/45">AIR TEMPERATURE</span><strong className="mt-2 block text-4xl font-medium tracking-[-0.06em]">{selected?.temperature?.toFixed(0) ?? '—'}°</strong></div>
                <div className="border-l border-white/15 pl-5"><span className="text-[9px] tracking-[0.1em] text-white/45">CAMPUS WBGT</span><strong className="mt-2 block text-4xl font-medium tracking-[-0.06em]">{selected?.wbgt?.toFixed(1) ?? '—'}°</strong></div>
              </div>
              <div className="mt-5 flex items-center gap-3"><WeatherGlyph condition={selected?.condition ?? 'Sunny'} className="h-6 w-6 text-[#ffd278]" /><strong>{selected?.condition ?? 'Loading forecast'}</strong></div>
              <p className="mt-3 text-xs leading-5 text-white/65">{selected?.detail ?? 'Forecast details will appear when the weather service responds.'}</p>
              <div className="mt-5 grid grid-cols-3 border-t border-white/15 pt-5 text-xs">
              <div><Droplets className="mb-2 h-4 w-4 text-white/55" /><strong>{selected?.rainChance.toFixed(0) ?? '—'}%</strong><span className="block text-[10px] text-white/45">RAIN</span></div>
              <div><Gauge className="mb-2 h-4 w-4 text-white/55" /><strong>{selected?.humidity.toFixed(0) ?? '—'}%</strong><span className="block text-[10px] text-white/45">HUMIDITY</span></div>
              <div><Wind className="mb-2 h-4 w-4 text-white/55" /><strong>{selected?.wind ?? '—'}</strong><span className="block text-[10px] text-white/45">WIND</span></div>
              </div>
              <p className="mt-5 text-[10px] leading-4 text-white/45">Surrounding Heath grid cross-check: <strong className="text-white/80">{selected?.nearbyWbgt?.toFixed(1) ?? '—'}°F WBGT</strong>.</p>
            </section>

            <section className="rounded-[1.5rem] border border-white/20 bg-white/90 p-5 text-black backdrop-blur-xl sm:p-6">
              <div><p className="text-[10px] font-semibold tracking-[0.12em] text-hawk">3 · CONSERVATIVE PLANNING CALL</p><h2 className="mt-2 text-2xl font-medium">What families should plan for</h2></div>
              <div className="mt-6 border-y border-black/15 py-5"><span className="text-[9px] tracking-[0.1em] text-black/45">PLANNING CEILING</span><strong className="mt-2 block text-5xl tracking-[-0.06em]">{selected?.prediction.planningCeiling?.toFixed(1) ?? '—'}°</strong><span className="mt-2 block text-xl font-semibold">{plainDecision(selected)}</span><span className="mt-3 inline-flex px-2 py-1 text-[10px] font-bold text-white" style={{ backgroundColor: accent }}>{selected?.prediction.state === 'no' ? 'NO PRACTICE PREDICTED' : status?.name ?? 'Loading'}</span></div>
              {selected?.prediction.state === 'no'
                ? <ul className="mt-5 grid gap-2 text-sm leading-5 text-black/65"><li className="flex gap-2"><span className="font-bold text-hawk">•</span><span>Plan for no outdoor practice unless the school confirms otherwise.</span></li></ul>
                : status && <ul className="mt-5 grid gap-2 text-sm leading-5 text-black/65">{status.rules.map((rule) => <li key={rule} className="flex gap-2"><span className="font-bold text-hawk">•</span><span>{rule}</span></li>)}</ul>}
              <div className="mt-6 border-t border-black/15 pt-5 text-xs leading-5 text-black/55">
                The ceiling uses the hotter local NWS grid plus a temporary {INCIDENT_SAFETY_ALLOWANCE}°F allowance based on the September 16 miss. It is deliberately conservative and is not an official WBGT reading.
              </div>
            </section>
          </div>
        </div>

        <div className="relative z-10 mx-auto mt-auto w-full max-w-[1600px] overflow-hidden rounded-[1.5rem] border border-white/15 bg-black/55 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <div className="text-[10px] font-semibold tracking-[0.12em]">SEVEN-DAY PRACTICE RISK</div>
            <div className="text-[10px] text-white/45">SELECT A DAY · 2:45–3:00 PM</div>
          </div>
          <div className="flex snap-x overflow-x-auto sm:grid sm:grid-cols-7 sm:overflow-visible">
            {(weather?.outlooks ?? []).map((outlook, index) => {
              const meta = outlook.flag ? FLAG_META[outlook.flag] : null
              return (
                <button
                  key={`${outlook.day}-${index}`}
                  onClick={() => setSelectedIndex(index)}
                  className={`min-w-[132px] snap-start border-r border-white/10 px-4 py-3 text-left transition-colors last:border-r-0 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white sm:min-w-0 ${selectedIndex === index ? 'bg-white/12' : ''}`}
                  aria-pressed={selectedIndex === index}
                >
                  <span className="mb-3 block h-1 w-7" style={{ backgroundColor: meta?.color ?? 'rgba(255,255,255,.2)' }} />
                  <span className="text-xs font-semibold">{outlook.day}</span>
                  <span className="ml-2 text-[10px] text-white/40">{outlook.dateLabel}</span>
                  <WeatherGlyph condition={outlook.condition} className="my-3 h-5 w-5 text-white/80" />
                  <span className="block text-xl font-medium tracking-[-0.05em]">{outlook.prediction.planningCeiling?.toFixed(1) ?? '—'}° <small className="text-[8px] font-semibold tracking-[0.08em] text-white/40">CEILING</small></span>
                  <span className="mt-0.5 block text-[9px] text-white/45">NWS {outlook.wbgt?.toFixed(1) ?? '—'}°</span>
                  <span className="mt-1 block text-[10px] font-medium" style={{ color: meta?.color ?? 'rgba(255,255,255,.45)' }}>{plainDecision(outlook)}</span>
                  {outlook.prediction.ceilingMargin !== null && <span className="mt-1 block text-[9px] text-white/45">{outlook.prediction.ceilingMargin <= 0 ? `${Math.abs(outlook.prediction.ceilingMargin).toFixed(1)}° OVER LINE` : `${outlook.prediction.ceilingMargin.toFixed(1)}° BELOW LINE`}</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="relative z-10 mx-auto mt-3 flex w-full max-w-[1600px] justify-between px-1 text-[9px] text-white/45">
          <span>{weather?.observation ? `${weather.observation.stationName.toUpperCase()} · ${observationTime}` : 'CURRENT STATION LOADING'}</span>
          <span>EXACT CAMPUS + NEARBY GRID + LIVE STATION · UIL CLASS 3</span>
        </div>
      </section>

      <section className="relative overflow-hidden bg-[#f1efe9] px-4 py-24 text-[#101214] sm:px-8 lg:px-12 lg:py-36">
        <div className="absolute inset-0 opacity-45 [background-image:linear-gradient(rgba(16,18,20,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(16,18,20,.08)_1px,transparent_1px)] [background-size:56px_56px]" />
        <div className="relative mx-auto max-w-[1600px]">
          <div className="grid gap-12 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <p className="text-xs font-bold tracking-[0.14em] text-hawk">WHY THIS PAGE EXISTS</p>
              <h2 className="mt-6 text-[clamp(3.5rem,8vw,8rem)] font-medium leading-[0.84] tracking-[-0.075em]">HEAT IS NOW<br />A FIELD DECISION.</h2>
            </div>
            <div className="max-w-lg self-end lg:col-span-4 lg:col-start-9">
              <p className="text-xl font-medium leading-7">Texas UIL’s statewide heat-safety standard takes effect August 1, 2026.</p>
              <p className="mt-5 text-sm leading-6 text-black/60">It requires WBGT monitoring for outdoor activity. This page turns the NWS planning forecast into one immediate answer for Rockwall-Heath girls golf families. It is not the coach’s final call.</p>
              <a href="https://www.uiltexas.org/health/info/heat-stress-and-athletic-participation" target="_blank" rel="noreferrer" className="mt-7 inline-flex items-center gap-2 border-b border-black pb-1 text-xs font-bold tracking-[0.08em]">READ THE OFFICIAL UIL PLAN <ExternalLink className="h-3.5 w-3.5" /></a>
            </div>
          </div>

          <div className="mt-20 grid border-y border-black/20 md:grid-cols-3">
            <div className="border-b border-black/15 py-8 md:border-b-0 md:border-r md:px-8 md:first:pl-0"><span className="text-[clamp(4rem,8vw,7rem)] font-medium leading-none tracking-[-0.08em]">15</span><span className="ml-2 text-xl">MIN</span><p className="mt-4 max-w-xs text-sm leading-5 text-black/55">The required reading window before outdoor practice begins.</p></div>
            <div className="border-b border-black/15 py-8 md:border-b-0 md:border-r md:px-8"><span className="text-[clamp(4rem,8vw,7rem)] font-medium leading-none tracking-[-0.08em]">30</span><span className="ml-2 text-xl">MIN</span><p className="mt-4 max-w-xs text-sm leading-5 text-black/55">Conditions must be checked again throughout practice.</p></div>
            <div className="py-8 md:pl-8"><span className="text-[clamp(4rem,8vw,7rem)] font-medium leading-none tracking-[-0.08em]">82°</span><span className="ml-2 text-xl">WBGT</span><p className="mt-4 max-w-xs text-sm leading-5 text-black/55">Class 3 activities require a rapid-cooling zone at or above this point.</p></div>
          </div>
          <div className="grid bg-[#101214] text-white md:grid-cols-3">
            <div className="border-b border-white/15 p-6 md:border-b-0 md:border-r"><p className="text-[9px] font-bold tracking-[0.12em] text-[#f0a9b7]">WATER, ALWAYS</p><p className="mt-3 text-sm leading-5 text-white/65">UIL says athletes must have unrestricted access to water and may never be denied it.</p></div>
            <div className="border-b border-white/15 p-6 md:border-b-0 md:border-r"><p className="text-[9px] font-bold tracking-[0.12em] text-[#f0a9b7]">REST MEANS REST</p><p className="mt-3 text-sm leading-5 text-white/65">Every required break includes unlimited hydration and no activity.</p></div>
            <div className="p-6"><p className="text-[9px] font-bold tracking-[0.12em] text-[#f0a9b7]">THE FIELD READING WINS</p><p className="mt-3 text-sm leading-5 text-white/65">The school must use the current category, trend and professional judgment—not this prediction alone.</p></div>
          </div>
        </div>
      </section>

      <section className="relative isolate min-h-[900px] overflow-hidden border-y border-white/15 bg-[#0a0d0f] px-4 py-24 sm:px-8 lg:px-12 lg:py-36">
        <img src="/weather/heath-storm.webp" alt="Illustrative rain sweeping across a coastal links golf course" className="absolute inset-0 -z-10 h-[118%] w-full object-cover opacity-70" style={{ transform: `translate3d(0, ${storyShift}px, 0) scale(1.04)` }} />
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(5,8,10,.93)_0%,rgba(5,8,10,.62)_55%,rgba(5,8,10,.32)_100%)]" />
        <div className="mx-auto grid max-w-[1600px] gap-16 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <p className="text-xs font-semibold tracking-[0.14em] text-[#f0a9b7]">FORECAST ≠ FINAL CALL</p>
            <h2 className="mt-6 text-[clamp(3.7rem,9vw,9rem)] font-medium leading-[0.82] tracking-[-0.075em]">THE SKY<br />CAN MOVE.</h2>
            <p className="mt-8 max-w-md text-base leading-7 text-white/65">That is why this page keeps checking. The week gives families a useful signal; the school’s near-practice reading reflects the actual field.</p>
          </div>
          <div className="grid gap-4 self-end lg:col-span-4 lg:col-start-9">
            <div className="rounded-[1.5rem] border border-white/20 bg-black/40 p-6 backdrop-blur-xl"><Database className="h-6 w-6 text-[#f0a9b7]" /><p className="mt-10 text-[10px] font-bold tracking-[0.12em] text-white/45">THE PREDICTOR KNOWS</p><h3 className="mt-2 text-2xl font-medium">The planning risk</h3><ul className="mt-4 grid gap-2 text-sm leading-5 text-white/60"><li>• Exact-campus NWS WBGT</li><li>• A surrounding-grid cross-check</li><li>• Nearest live station versus model</li><li>• Conservative ceiling and UIL line</li></ul></div>
            <div className="rounded-[1.5rem] border border-white/20 bg-white/90 p-6 text-black backdrop-blur-xl"><ShieldCheck className="h-6 w-6 text-hawk" /><p className="mt-10 text-[10px] font-bold tracking-[0.12em] text-black/45">THE PREDICTOR CANNOT KNOW</p><h3 className="mt-2 text-2xl font-medium">The official status</h3><ul className="mt-4 grid gap-2 text-sm leading-5 text-black/60"><li>• The school’s exact field reading</li><li>• Lightning, air quality or field closures</li><li>• Athlete condition or cumulative workload</li><li>• Coach, trainer or campus decisions</li></ul></div>
          </div>
        </div>
        <p className="absolute bottom-5 right-5 text-[9px] font-semibold tracking-[0.1em] text-white/40">ILLUSTRATIVE GOLF WEATHER SCENE</p>
      </section>

      <section className="bg-[#f1efe9] px-4 py-24 text-[#101214] sm:px-8 lg:px-12 lg:py-32">
        <div className="mx-auto max-w-[1600px]">
          <div className="grid gap-10 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <p className="text-xs font-bold tracking-[0.14em] text-hawk">SOURCE CHECK</p>
              <h2 className="mt-5 text-[clamp(3.1rem,6.5vw,6.5rem)] font-medium leading-[0.86] tracking-[-0.07em]">YES, YOU’RE<br />IN THE RIGHT<br />PLACE.</h2>
            </div>
            <div className="lg:col-span-7">
              <div className="grid border-t border-black/20 sm:grid-cols-2">
                <div className="border-b border-black/15 py-6 sm:border-r sm:pr-6"><MapPin className="h-5 w-5 text-hawk" /><span className="mt-6 block text-[10px] font-bold tracking-[0.12em] text-black/45">PRACTICE LOCATION</span><strong className="mt-2 block text-xl">{PRACTICE_LOCATION_NAME}</strong><span className="mt-1 block text-xs text-black/50">{weather ? `${weather.coordinates.latitude.toFixed(4)}, ${weather.coordinates.longitude.toFixed(4)}` : 'Exact coordinates loading'}</span></div>
                <div className="border-b border-black/15 py-6 sm:pl-6"><Database className="h-5 w-5 text-hawk" /><span className="mt-6 block text-[10px] font-bold tracking-[0.12em] text-black/45">FORECAST SIGNALS</span><strong className="mt-2 block text-xl">Exact campus + surrounding Heath</strong><span className="mt-1 block text-xs text-black/50">NWS grids {weather?.gridId ?? 'loading'} + {weather?.nearbyGridId ?? 'loading'}</span></div>
                <div className="border-b border-black/15 py-6 sm:border-r sm:pr-6"><CheckCircle2 className="h-5 w-5 text-hawk" /><span className="mt-6 block text-[10px] font-bold tracking-[0.12em] text-black/45">NEAREST OBSERVATION</span><strong className="mt-2 block text-xl">{weather?.observation?.stationName ?? 'Loading station'}</strong><span className="mt-1 block text-xs text-black/50">{weather?.observation ? `${weather.observation.station} · ${observationTime} · ${weather.observation.temperature?.toFixed(0) ?? '—'}°F` : 'Live observation unavailable'}</span></div>
                <div className="border-b border-black/15 py-6 sm:pl-6"><RefreshCw className="h-5 w-5 text-hawk" /><span className="mt-6 block text-[10px] font-bold tracking-[0.12em] text-black/45">FRESHNESS</span><strong className="mt-2 block text-xl">NWS issued {sourceUpdated}</strong><span className="mt-1 block text-xs text-black/50">This browser checked at {updated}. NWS may not publish new forecast data every five minutes.</span></div>
              </div>
              <p className="mt-7 max-w-2xl text-sm leading-6 text-black/60">The predictor now anchors the forecast to the Rockwall-Heath campus, checks the surrounding Heath grid, and compares the nearest live station with what the model expected at that moment. The planning ceiling then adds a clearly labeled {INCIDENT_SAFETY_ALLOWANCE}°F safety allowance because the September 16 forecast missed the school’s cancellation reading by at least several degrees. One incident is not enough to call this a permanent correction.</p>
              <div className="mt-6 flex flex-wrap gap-6"><a href="https://www.weather.gov/news/211009-WBGT" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 border-b border-black pb-1 text-xs font-bold tracking-[0.08em]">HOW NWS CALCULATES WBGT <ExternalLink className="h-3.5 w-3.5" /></a><a href="https://convergence.unc.edu/tools/wbgt/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 border-b border-black pb-1 text-xs font-bold tracking-[0.08em]">WHY WBGT FORECASTS VARY <ExternalLink className="h-3.5 w-3.5" /></a></div>
            </div>
          </div>

          <div className="mt-28">
            <div className="flex flex-col justify-between gap-4 border-b border-black/25 pb-5 sm:flex-row sm:items-end"><div><p className="text-xs font-bold tracking-[0.14em] text-hawk">WHAT THE NUMBERS MEAN</p><h2 className="mt-3 text-3xl font-medium tracking-[-0.04em]">Plain language first. Color second.</h2></div><span className="text-xs text-black/45">UIL CLASS 3 · WBGT °F</span></div>
            <div className="grid md:grid-cols-5">
              {THRESHOLDS.map((item) => (
                <div key={item.flag} className="flex items-center gap-5 border-b border-black/15 py-5 md:block md:min-h-64 md:border-r md:p-5 md:last:border-r-0">
                  <span className="block h-4 w-4 shrink-0" style={{ backgroundColor: item.color }} />
                  <div className="md:mt-20"><strong className="block text-base">{item.flag}</strong><span className="mt-2 block text-xs font-bold">{item.range}F</span><span className="mt-3 block text-xs leading-5 text-black/50">{item.note}</span></div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </section>

      <section className="relative overflow-hidden bg-[#0a0d0f] px-4 py-24 text-white sm:px-8 lg:px-12 lg:py-32">
        <div className="absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(255,255,255,.16)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.16)_1px,transparent_1px)] [background-size:56px_56px]" />
        <div className="relative mx-auto max-w-[1600px]">
          <div className="grid gap-10 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-8">
              <p className="text-xs font-bold tracking-[0.14em] text-[#f0a9b7]">FOR THE GIRLS’ GOLF BAG</p>
              <h2 className="mt-5 text-[clamp(3.5rem,8vw,8rem)] font-medium leading-[0.84] tracking-[-0.075em]">PACK FOR<br />THE HEAT.</h2>
            </div>
            <div className="max-w-lg lg:col-span-4">
              <p className="text-xl font-medium leading-7">A planning checklist for hot practices—not a substitute for the team athletic trainer or your child’s clinician.</p>
              <p className="mt-4 text-sm leading-6 text-white/55">Needs vary by athlete, practice length, medical history and conditions on the course.</p>
            </div>
          </div>

          <div className="mt-16 grid border-l border-t border-white/15 sm:grid-cols-2 lg:grid-cols-5">
            <article className="min-h-72 border-b border-r border-white/15 p-6">
              <GlassWater className="h-6 w-6 text-[#f0a9b7]" />
              <p className="mt-12 text-[10px] font-bold tracking-[0.12em] text-white/45">01 · COLD WATER</p>
              <h3 className="mt-2 text-2xl font-medium">Plan the volume.</h3>
              <p className="mt-4 text-sm leading-6 text-white/60">AAP guidance says teens may need about 34–50 oz per hour during vigorous activity. Sip regularly; individual needs vary.</p>
            </article>
            <article className="min-h-72 border-b border-r border-white/15 p-6">
              <Snowflake className="h-6 w-6 text-[#f0a9b7]" />
              <p className="mt-12 text-[10px] font-bold tracking-[0.12em] text-white/45">02 · ELECTROLYTE BACKUP</p>
              <h3 className="mt-2 text-2xl font-medium">Longer than an hour?</h3>
              <p className="mt-4 text-sm leading-6 text-white/60">For long practices or heavy sweating, Liquid I.V. or another balanced electrolyte drink can be an option. Follow the label and trainer guidance; skip energy drinks.</p>
            </article>
            <article className="min-h-72 border-b border-r border-white/15 p-6">
              <Fan className="h-6 w-6 text-[#f0a9b7]" />
              <p className="mt-12 text-[10px] font-bold tracking-[0.12em] text-white/45">03 · COOLING KIT</p>
              <h3 className="mt-2 text-2xl font-medium">Bring your shade.</h3>
              <p className="mt-4 text-sm leading-6 text-white/60">Pack a golf umbrella, cooling towel and small mister or fan. Use every shaded break the team provides.</p>
            </article>
            <article className="min-h-72 border-b border-r border-white/15 p-6">
              <Shirt className="h-6 w-6 text-[#f0a9b7]" />
              <p className="mt-12 text-[10px] font-bold tracking-[0.12em] text-white/45">04 · WEAR LIGHT</p>
              <h3 className="mt-2 text-2xl font-medium">Help heat escape.</h3>
              <p className="mt-4 text-sm leading-6 text-white/60">Choose light-colored, breathable, loose-fitting golf clothes. Add a visor or hat and broad-spectrum sunscreen.</p>
            </article>
            <article className="min-h-72 border-b border-r border-white/15 p-6 sm:col-span-2 lg:col-span-1">
              <CircleAlert className="h-6 w-6 text-[#f0a9b7]" />
              <p className="mt-12 text-[10px] font-bold tracking-[0.12em] text-white/45">05 · STOP SIGNALS</p>
              <h3 className="mt-2 text-2xl font-medium">Do not push through.</h3>
              <p className="mt-4 text-sm leading-6 text-white/60">Feeling faint, weak, dizzy, confused or unusually ill means stop, get cool and tell an adult or trainer immediately.</p>
            </article>
          </div>

          <div className="mt-8 flex flex-col justify-between gap-6 border-b border-white/15 pb-8 text-xs leading-5 text-white/50 lg:flex-row lg:items-end">
            <p className="max-w-2xl">General preparation guidance for healthy teen athletes. Follow the team athletic trainer and your child’s clinician, especially for medical conditions or medications. Confusion, collapse or loss of consciousness can be an emergency: call 911 and begin rapid cooling.</p>
            <div className="flex flex-wrap gap-x-6 gap-y-3 font-semibold tracking-[0.05em] text-white/70">
              <a href="https://www.healthychildren.org/English/healthy-living/nutrition/Pages/Choose-Water-for-Healthy-Hydration.aspx" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 border-b border-white/40 pb-1">AAP HYDRATION <ExternalLink className="h-3 w-3" /></a>
              <a href="https://www.cdc.gov/heat-health/risk-factors/heat-and-athletes.html" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 border-b border-white/40 pb-1">CDC HEAT SAFETY <ExternalLink className="h-3 w-3" /></a>
              <a href="https://www.uiltexas.org/health/info/heat-stress-and-athletic-participation" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 border-b border-white/40 pb-1">UIL PLAN <ExternalLink className="h-3 w-3" /></a>
            </div>
          </div>

          <footer className="mt-6 flex flex-col justify-between gap-5 text-[10px] font-semibold tracking-[0.08em] text-white/40 sm:flex-row"><span>BUILT FOR ROCKWALL-HEATH GIRLS GOLF FAMILIES</span><span>HEAT PREDICTION ONLY · NOT AN OFFICIAL SCHOOL ANNOUNCEMENT</span></footer>
        </div>
      </section>
    </main>
  )
}
