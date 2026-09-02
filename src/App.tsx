import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Cloud, CloudLightning, CloudRain, CloudSun, Database, Droplets, ExternalLink, Gauge, MapPin, RefreshCw, ShieldCheck, Sun, Wind } from 'lucide-react'
import WeatherBackdrop from './WeatherBackdrop'
const ZIP_CODE = '75032'
const TIME_ZONE = 'America/Chicago'
const AUTO_REFRESH_MS = 5 * 60 * 1000
const FALLBACK_COORDINATES = { latitude: 32.835, longitude: -96.474 }

type Flag = 'green' | 'yellow' | 'orange' | 'red' | 'black'
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
  coordinates: { latitude: number; longitude: number }
  observation: Observation | null
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
    rules: ['2-hour maximum', 'Football: helmet, shoulder pads and shorts only', 'All sports: 4 breaks/hour · 4 minutes each', 'Onsite rapid-cooling zone required'],
  },
  red: {
    name: 'Strict limits', color: '#C8102E', verdict: 'YES.', instruction: 'Practice is heat-permitted only under strict limits.',
    rules: ['1-hour maximum', 'Football: no protective equipment or conditioning', 'All sports: 20 minutes of rest during the hour', 'Onsite rapid-cooling zone required'],
  },
  black: {
    name: 'No practice', color: '#111111', verdict: 'NO.', instruction: 'No outdoor workouts under the UIL heat plan.',
    rules: ['Delay outdoor practice until a cooler WBGT is reached'],
  },
}

const THRESHOLDS = [
  { flag: 'Normal practice', range: '< 82.0°', color: '#39A96B', note: '3 breaks/hour · 3 minutes each' },
  { flag: 'Heat watch', range: '82.0–86.9°', color: '#F3C74F', note: '3 breaks/hour · 4 minutes each · cooling zone' },
  { flag: 'More breaks', range: '87.0–90.0°', color: '#F47B35', note: '2-hour max · 4 breaks/hour · football gear limits' },
  { flag: 'Strict limits', range: '90.1–92.0°', color: '#C8102E', note: '1-hour max · 20 minutes rest · no football protective gear or conditioning' },
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

function getFlag(wbgt: number): Flag {
  if (wbgt < 82) return 'green'
  if (wbgt < 87) return 'yellow'
  if (wbgt <= 90) return 'orange'
  if (wbgt < 92.1) return 'red'
  return 'black'
}

function WeatherGlyph({ condition, className = 'h-6 w-6' }: { condition: string; className?: string }) {
  if (/thunder|storm/i.test(condition)) return <CloudLightning className={className} />
  if (/rain|shower/i.test(condition)) return <CloudRain className={className} />
  if (/partly|mostly sunny|mostly clear/i.test(condition)) return <CloudSun className={className} />
  if (/cloud|overcast|fog/i.test(condition)) return <Cloud className={className} />
  return <Sun className={className} />
}

function plainDecision(outlook: Outlook | null) {
  if (!outlook?.flag) return 'FORECAST PENDING'
  if (outlook.flag === 'black') return 'NO PRACTICE'
  if (outlook.flag === 'red') return 'YES · CLOSE CALL'
  if (outlook.flag === 'orange') return 'YES · MORE BREAKS'
  if (outlook.flag === 'yellow') return 'YES · HEAT WATCH'
  return 'YES · NORMAL PRACTICE'
}

function predictionReason(outlook: Outlook | null) {
  if (outlook?.wbgt === null || outlook?.wbgt === undefined) return 'Waiting for the predicted WBGT.'
  if (outlook.wbgt >= 92.1) return `NO — the predicted WBGT is ${outlook.wbgt.toFixed(1)}°F, at or above the 92.1°F UIL limit.`
  return `YES — the predicted WBGT is ${outlook.wbgt.toFixed(1)}°F, ${(92.1 - outlook.wbgt).toFixed(1)}° below the 92.1°F UIL limit.`
}

function DecisionMeter({ wbgt }: { wbgt: number | null }) {
  const minimum = 78
  const maximum = 96
  const cancellation = 92.1
  const value = wbgt ?? minimum
  const marker = Math.max(0, Math.min(100, ((value - minimum) / (maximum - minimum)) * 100))
  const line = ((cancellation - minimum) / (maximum - minimum)) * 100
  const margin = wbgt === null ? null : cancellation - wbgt
  const message = margin === null
    ? 'Waiting for the forecast'
    : margin <= 0
      ? `${Math.abs(margin).toFixed(1)}°F above the UIL WBGT limit`
      : margin <= 1.5
        ? `Close call — only ${margin.toFixed(1)}°F below the UIL WBGT limit`
        : margin <= 5
          ? `Keep watching — ${margin.toFixed(1)}°F below the UIL WBGT limit`
          : `${margin.toFixed(1)}°F below the UIL WBGT limit`

  return (
    <div className="mt-5 border-y border-white/15 py-4">
      <div className="flex items-end justify-between gap-5">
        <div>
          <div className="text-[9px] font-semibold tracking-[0.13em] text-white/45">HOW CLOSE IS THE WBGT?</div>
          <div className="mt-1 text-sm font-semibold">{message}</div>
        </div>
        <div className="max-w-[9rem] shrink-0 text-right text-[9px] leading-3 text-white/45">UIL NO-OUTDOOR LIMIT<br /><strong className="text-sm text-white">92.1°F WBGT</strong></div>
      </div>
      <div className="relative mt-5 h-2 bg-white/20">
        <div className="absolute inset-y-0 right-0 bg-hawk/80" style={{ left: `${line}%` }} />
        <div className="absolute -bottom-2 -top-2 w-px bg-white" style={{ left: `${line}%` }} />
        <div className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-hawk shadow-[0_0_18px_rgba(200,16,46,.8)]" style={{ left: `${marker}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-[9px] font-medium tracking-[0.08em] text-white/40">
        <span>HEAT-PERMITTED</span>
        <span>NO OUTDOOR PRACTICE</span>
      </div>
    </div>
  )
}

function HawksMark() {
  return (
    <div className="flex items-center gap-3" aria-label="Rockwall-Heath Hawks">
      <img src="/heath-hawks-logo-cropped.png" alt="Rockwall-Heath Hawks" className="h-14 w-auto object-contain sm:h-16" />
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
      let coordinates = FALLBACK_COORDINATES
      try {
        const zipResponse = await fetch(`https://api.zippopotam.us/us/${ZIP_CODE}`)
        if (!zipResponse.ok) throw new Error('ZIP lookup failed')
        const zipData = await zipResponse.json()
        coordinates = { latitude: Number(zipData.places[0].latitude), longitude: Number(zipData.places[0].longitude) }
      } catch { /* The Heath center fallback keeps the forecast usable. */ }

      const pointsResponse = await fetch(`https://api.weather.gov/points/${coordinates.latitude.toFixed(4)},${coordinates.longitude.toFixed(4)}`, { headers: { Accept: 'application/geo+json' } })
      if (!pointsResponse.ok) throw new Error('The National Weather Service location feed is unavailable.')
      const points = await pointsResponse.json()

      const [gridResponse, dailyResponse, observation] = await Promise.all([
        fetch(points.properties.forecastGridData, { headers: { Accept: 'application/geo+json' } }),
        fetch(points.properties.forecast, { headers: { Accept: 'application/geo+json' } }),
        fetchLatestObservation(points.properties.observationStations),
      ])
      if (!gridResponse.ok) throw new Error('The National Weather Service WBGT feed is unavailable.')
      const grid = await gridResponse.json()
      const daily = dailyResponse.ok ? await dailyResponse.json() : null
      const properties = grid.properties
      const periods: ForecastPeriod[] = daily?.properties?.periods ?? []

      const outlooks = Array.from({ length: 7 }, (_, index): Outlook => {
        const target = targetForOffset(index, 14, 45)
        const dayPeriod = periods.find((period) => period.isDaytime && dateKey(new Date(period.startTime)) === dateKey(target))
        const wbgt = toFahrenheit(gridValueAt(properties.wetBulbGlobeTemperature, target), properties.wetBulbGlobeTemperature?.uom)
        const gridTemp = toFahrenheit(gridValueAt(properties.temperature, target), properties.temperature?.uom)
        const rainChance = gridValueAt(properties.probabilityOfPrecipitation, target) ?? dayPeriod?.probabilityOfPrecipitation?.value ?? 0
        const humidity = gridValueAt(properties.relativeHumidity, target) ?? dayPeriod?.relativeHumidity?.value ?? 0
        const cloudCover = gridValueAt(properties.skyCover, target) ?? (/cloud/i.test(dayPeriod?.shortForecast ?? '') ? 70 : 18)
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
          flag: wbgt === null ? null : getFlag(wbgt),
        }
      })

      setWeather({
        outlooks,
        currentWbgt: toFahrenheit(gridValueAt(properties.wetBulbGlobeTemperature, new Date()), properties.wetBulbGlobeTemperature?.uom),
        office: points.properties.cwa ?? null,
        gridId: points.properties.forecastGridData.replace('https://api.weather.gov/gridpoints/', ''),
        coordinates,
        observation,
        updatedAt: new Date(),
      })
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
  const accent = status?.color ?? '#C8102E'
  const questionDay = selectedIndex === 0
    ? 'TODAY'
    : selected
      ? new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long' }).format(selected.date).toUpperCase()
      : 'TODAY'
  const updated = useMemo(() => weather ? new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(weather.updatedAt) : '—', [weather])
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
            <span className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5" /> HEATH, TEXAS · 75032</span>
            <span>NWS GRID {weather?.gridId ?? 'FWD / —'}</span>
            <span>UPDATED {updated}</span>
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

        <div className="relative z-10 mx-auto grid w-full max-w-[1600px] gap-7 pb-8 pt-8 sm:pt-10 lg:grid-cols-12 lg:pb-10">
          <div className="lg:col-span-8" style={{ transform: `translate3d(0, ${-heroShift * 0.26}px, 0)` }}>
            <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] font-semibold tracking-[0.1em] text-white/75 md:hidden">
              <span className="flex items-center gap-1.5"><MapPin className="h-3 w-3" /> HEATH · 75032</span>
              <span>NWS {weather?.office ?? 'FWD'} · UPDATED {updated}</span>
            </div>
            <div className="mb-4 flex items-center gap-3 text-[11px] font-semibold tracking-[0.12em]">
              <span className="h-2.5 w-2.5" style={{ backgroundColor: accent }} />
              HEAT PREDICTION · {plainDecision(selected)} · 2:45–3:00 PM
            </div>
            <h1 className="max-w-5xl text-[clamp(2.6rem,6.4vw,6.7rem)] font-medium leading-[0.86] tracking-[-0.072em] text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.38)]">
              IS OUTDOOR PRACTICE<br />LIKELY {questionDay}?
            </h1>
            <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-5">
              <div className="text-[clamp(7rem,15vw,13.5rem)] font-bold leading-[0.64] tracking-[-0.09em] text-white drop-shadow-[0_4px_25px_rgba(0,0,0,0.32)]">
                {loading ? '…' : error ? 'CHECK.' : status?.verdict ?? '—'}
              </div>
              <div className="max-w-sm border-l-2 pb-1 pl-4" style={{ borderColor: accent }}>
                <p className="text-base font-semibold leading-5">{error ?? predictionReason(selected)}</p>
                {status && <p className="mt-2 text-xs leading-4 text-white/70">{status.instruction}</p>}
                <p className="mt-2 text-[10px] font-medium tracking-[0.06em] text-white/55">PREDICTION ONLY · SCHOOL MAKES THE FINAL CALL</p>
              </div>
            </div>
            <div className="mt-7 inline-flex max-w-xl items-start gap-3 rounded-xl border border-white/25 bg-black/45 px-4 py-3 text-xs leading-5 backdrop-blur-md">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#f0a9b7]" />
              <p><strong className="text-white">Not an official practice status.</strong> This predicts the heat restriction from the NWS forecast. Confirm the actual decision with Rockwall-Heath athletics.</p>
            </div>
          </div>

          <aside className="overflow-hidden rounded-[1.75rem] border border-white/25 bg-black/45 p-5 shadow-2xl backdrop-blur-xl lg:col-span-4 lg:p-6" style={{ transform: `translate3d(0, ${heroShift * 0.16}px, 0)` }}>
            <div className="grid grid-cols-2 gap-5">
              <div className="border-r border-white/15 pr-4">
                <div className="text-[9px] font-semibold tracking-[0.1em] text-white/55">3 PM AIR TEMPERATURE</div>
                <div className="mt-3 flex items-center gap-3">
                  <WeatherGlyph condition={selected?.condition ?? 'Sunny'} className="h-9 w-9 text-[#ffd278]" />
                  <span className="text-5xl font-medium tracking-[-0.06em]">{selected?.temperature?.toFixed(0) ?? '—'}°</span>
                </div>
                <div className="mt-2 text-[9px] text-white/40">WEATHER FORECAST</div>
              </div>
              <div>
                <div className="text-[9px] font-semibold tracking-[0.1em] text-white/55">3 PM PREDICTED WBGT</div>
                <div className="mt-3 text-5xl font-medium tracking-[-0.06em]">{selected?.wbgt?.toFixed(1) ?? '—'}°</div>
                <div className="mt-2 text-[9px] font-semibold text-[#f0a9b7]">UIL USES THIS NUMBER</div>
              </div>
            </div>
            <div className="mt-5 rounded-xl border border-[#f0a9b7]/35 bg-[#c8102e]/10 px-4 py-3 text-xs leading-5 text-white/80">
              <strong className="text-white">These are different measurements.</strong> Air temperature describes the weather. WBGT combines heat, humidity, wind and sun—and WBGT is what UIL compares with 92.1°F.
            </div>
            <h2 className="mt-5 text-xl font-medium leading-6">{selected?.condition ?? 'Reading the sky'} · {selected?.day ?? 'Today'} at 3 PM</h2>
            <p className="mt-2 line-clamp-2 text-xs leading-5 text-white/65">{selected?.detail ?? 'Forecast details will appear when the weather service responds.'}</p>
            <DecisionMeter wbgt={selected?.wbgt ?? null} />
            {status && (
              <div className="mt-4 border-b border-white/15 pb-4">
                <p className="text-[9px] font-semibold tracking-[0.12em] text-white/45">PREDICTED UIL REQUIREMENTS</p>
                <ul className="mt-3 grid gap-1.5 text-[11px] leading-4 text-white/75">
                  {status.rules.map((rule) => <li key={rule} className="flex gap-2"><span aria-hidden="true" className="text-[#f0a9b7]">→</span><span>{rule}</span></li>)}
                </ul>
              </div>
            )}
            <div className="mt-4 grid grid-cols-3 text-xs">
              <div><Droplets className="mb-2 h-4 w-4 text-white/55" /><strong>{selected?.rainChance.toFixed(0) ?? '—'}%</strong><span className="block text-[10px] text-white/45">RAIN</span></div>
              <div><Gauge className="mb-2 h-4 w-4 text-white/55" /><strong>{selected?.humidity.toFixed(0) ?? '—'}%</strong><span className="block text-[10px] text-white/45">HUMIDITY</span></div>
              <div><Wind className="mb-2 h-4 w-4 text-white/55" /><strong>{selected?.wind ?? '—'}</strong><span className="block text-[10px] text-white/45">WIND</span></div>
            </div>
            <div className="mt-5 grid grid-cols-2 border-t border-white/15 pt-4 text-[10px]">
              <div>
                <span className="block tracking-[0.1em] text-white/45">WBGT NOW · GRID</span>
                <strong className="mt-1 block text-base">{weather?.currentWbgt?.toFixed(1) ?? '—'}°F</strong>
              </div>
              <div className="border-l border-white/15 pl-4">
                <span className="block tracking-[0.1em] text-white/45">AIR TEMP NOW · {weather?.observation?.station ?? '—'}</span>
                <strong className="mt-1 block text-base">{weather?.observation?.temperature?.toFixed(0) ?? '—'}° · {weather?.observation?.condition ?? '—'}</strong>
              </div>
            </div>
          </aside>
        </div>

        <div className="relative z-10 mx-auto mt-auto w-full max-w-[1600px] overflow-hidden rounded-[1.5rem] border border-white/15 bg-black/55 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <div className="text-[10px] font-semibold tracking-[0.12em]">SEVEN-DAY HEAT PRACTICE PREDICTION</div>
            <div className="text-[10px] text-white/45">SELECT A DAY · 3:00 PM</div>
          </div>
          <div className="flex snap-x overflow-x-auto sm:grid sm:grid-cols-7 sm:overflow-visible">
            {(weather?.outlooks ?? Array.from({ length: 7 }, (_, index) => ({ day: index === 0 ? 'Today' : '—', dateLabel: '', wbgt: null, condition: 'Sunny', flag: null } as Outlook))).map((outlook, index) => {
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
                  <span className="block text-xl font-medium tracking-[-0.05em]">{outlook.wbgt?.toFixed(1) ?? '—'}° <small className="text-[8px] font-semibold tracking-[0.08em] text-white/40">WBGT</small></span>
                  <span className="mt-1 block text-[10px] font-medium" style={{ color: meta?.color ?? 'rgba(255,255,255,.45)' }}>{plainDecision(outlook)}</span>
                  {outlook.wbgt !== null && <span className="mt-1 block text-[9px] text-white/45">{Math.max(0, 92.1 - outlook.wbgt).toFixed(1)}° TO NO</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="relative z-10 mx-auto mt-3 flex w-full max-w-[1600px] justify-between px-1 text-[9px] text-white/45">
          <span>{weather?.observation ? `${weather.observation.stationName.toUpperCase()} · ${observationTime}` : 'CURRENT STATION LOADING'}</span>
          <span>NWS FORECAST · UIL CLASS 3 GUIDANCE</span>
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
              <p className="mt-5 text-sm leading-6 text-black/60">It requires WBGT monitoring for outdoor activity. This page turns the NWS planning forecast into one immediate answer for Heath families. It is not the coach’s final call.</p>
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
        <img src="/weather/heath-storm.webp" alt="Illustrative storm approaching a Heath, Texas high-school field" className="absolute inset-0 -z-10 h-[118%] w-full object-cover opacity-70" style={{ transform: `translate3d(0, ${storyShift}px, 0) scale(1.04)` }} />
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(5,8,10,.93)_0%,rgba(5,8,10,.62)_55%,rgba(5,8,10,.32)_100%)]" />
        <div className="mx-auto grid max-w-[1600px] gap-16 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <p className="text-xs font-semibold tracking-[0.14em] text-[#f0a9b7]">FORECAST ≠ FINAL CALL</p>
            <h2 className="mt-6 text-[clamp(3.7rem,9vw,9rem)] font-medium leading-[0.82] tracking-[-0.075em]">THE SKY<br />CAN MOVE.</h2>
            <p className="mt-8 max-w-md text-base leading-7 text-white/65">That is why this page keeps checking. The week gives families a useful signal; the school’s near-practice reading reflects the actual field.</p>
          </div>
          <div className="grid gap-4 self-end lg:col-span-4 lg:col-start-9">
            <div className="rounded-[1.5rem] border border-white/20 bg-black/40 p-6 backdrop-blur-xl"><Database className="h-6 w-6 text-[#f0a9b7]" /><p className="mt-10 text-[10px] font-bold tracking-[0.12em] text-white/45">THE PREDICTOR KNOWS</p><h3 className="mt-2 text-2xl font-medium">The heat outlook</h3><ul className="mt-4 grid gap-2 text-sm leading-5 text-white/60"><li>• NWS forecast WBGT</li><li>• UIL Class 3 restriction bands</li><li>• Distance from the no-practice line</li><li>• Seven-day heat trend</li></ul></div>
            <div className="rounded-[1.5rem] border border-white/20 bg-white/90 p-6 text-black backdrop-blur-xl"><ShieldCheck className="h-6 w-6 text-hawk" /><p className="mt-10 text-[10px] font-bold tracking-[0.12em] text-black/45">THE PREDICTOR CANNOT KNOW</p><h3 className="mt-2 text-2xl font-medium">The official status</h3><ul className="mt-4 grid gap-2 text-sm leading-5 text-black/60"><li>• The school’s exact field reading</li><li>• Lightning, air quality or field closures</li><li>• Athlete condition or cumulative workload</li><li>• Coach, trainer or campus decisions</li></ul></div>
          </div>
        </div>
        <p className="absolute bottom-5 right-5 text-[9px] font-semibold tracking-[0.1em] text-white/40">ILLUSTRATIVE HEATH WEATHER SCENE</p>
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
                <div className="border-b border-black/15 py-6 sm:border-r sm:pr-6"><MapPin className="h-5 w-5 text-hawk" /><span className="mt-6 block text-[10px] font-bold tracking-[0.12em] text-black/45">LOCATION</span><strong className="mt-2 block text-xl">Heath / Rockwall · 75032</strong><span className="mt-1 block text-xs text-black/50">{weather ? `${weather.coordinates.latitude.toFixed(4)}, ${weather.coordinates.longitude.toFixed(4)}` : 'ZIP centroid loading'}</span></div>
                <div className="border-b border-black/15 py-6 sm:pl-6"><Database className="h-5 w-5 text-hawk" /><span className="mt-6 block text-[10px] font-bold tracking-[0.12em] text-black/45">FORECAST SOURCE</span><strong className="mt-2 block text-xl">National Weather Service</strong><span className="mt-1 block text-xs text-black/50">Office {weather?.office ?? 'FWD'} · grid {weather?.gridId ?? 'loading'}</span></div>
                <div className="border-b border-black/15 py-6 sm:border-r sm:pr-6"><CheckCircle2 className="h-5 w-5 text-hawk" /><span className="mt-6 block text-[10px] font-bold tracking-[0.12em] text-black/45">NEAREST OBSERVATION</span><strong className="mt-2 block text-xl">{weather?.observation?.stationName ?? 'Loading station'}</strong><span className="mt-1 block text-xs text-black/50">{weather?.observation ? `${weather.observation.station} · ${observationTime} · ${weather.observation.temperature?.toFixed(0) ?? '—'}°F` : 'Live observation unavailable'}</span></div>
                <div className="border-b border-black/15 py-6 sm:pl-6"><RefreshCw className="h-5 w-5 text-hawk" /><span className="mt-6 block text-[10px] font-bold tracking-[0.12em] text-black/45">FRESHNESS</span><strong className="mt-2 block text-xl">Automatic · every 5 minutes</strong><span className="mt-1 block text-xs text-black/50">Last checked {updated}</span></div>
              </div>
              <p className="mt-7 max-w-2xl text-sm leading-6 text-black/60">Different weather apps can disagree by a few degrees because they use different station locations, update times and forecast models. This page consistently uses the NWS grid for ZIP 75032 so the heat prediction and its threshold stay comparable. Rain and sky conditions are shown for context, but they do not change the heat-based YES/NO prediction.</p>
              <a href="https://www.weather.gov/news/211009-WBGT" target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-2 border-b border-black pb-1 text-xs font-bold tracking-[0.08em]">HOW NWS CALCULATES WBGT <ExternalLink className="h-3.5 w-3.5" /></a>
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

          <footer className="mt-20 flex flex-col justify-between gap-5 border-t border-black/20 pt-6 text-[10px] font-semibold tracking-[0.08em] text-black/50 sm:flex-row"><span>BUILT FOR ROCKWALL-HEATH HAWKS FAMILIES</span><span>HEAT PREDICTION ONLY · NOT AN OFFICIAL SCHOOL ANNOUNCEMENT</span></footer>
        </div>
      </section>
    </main>
  )
}
