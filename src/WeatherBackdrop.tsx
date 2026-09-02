type WeatherBackdropProps = {
  cloudCover: number
  rainChance: number
  condition: string
  progress: number
  reduceMotion: boolean
}

const WEATHER_PHOTOS = [
  { id: 'clear', src: '/weather/heath-clear.webp', alt: 'A sunny high-school football practice field in Heath, Texas' },
  { id: 'clouds', src: '/weather/heath-building-clouds.webp', alt: 'Clouds building above a high-school football practice field in Heath, Texas' },
  { id: 'storm', src: '/weather/heath-storm.webp', alt: 'A thunderstorm approaching a high-school football practice field in Heath, Texas' },
] as const

function selectPhoto(condition: string, cloudCover: number, rainChance: number) {
  if (rainChance >= 40 || (rainChance >= 30 && /thunder|storm|rain|shower/i.test(condition))) return 'storm'
  if (cloudCover >= 60 || rainChance >= 25 || /overcast|mostly cloudy/i.test(condition)) return 'clouds'
  return 'clear'
}

export default function WeatherBackdrop({ condition, cloudCover, rainChance, progress, reduceMotion }: WeatherBackdropProps) {
  const activePhoto = selectPhoto(condition, cloudCover, rainChance)
  const parallax = reduceMotion ? 0 : Math.min(progress * 100, 64)

  return (
    <div className="absolute inset-0 overflow-hidden" aria-live="polite">
      {WEATHER_PHOTOS.map((photo, index) => (
        <img
          key={photo.id}
          src={photo.src}
          alt={photo.id === activePhoto ? photo.alt : ''}
          aria-hidden={photo.id !== activePhoto}
          className={`absolute inset-0 h-[112%] w-full object-cover saturate-[1.08] brightness-[1.06] transition-opacity duration-1000 ease-out ${photo.id === activePhoto ? 'opacity-100' : 'opacity-0'}`}
          style={{
            objectPosition: 'center center',
            transform: `translate3d(0, ${parallax * (0.4 + index * 0.08)}px, 0) scale(1.035)`,
          }}
          decoding="async"
        />
      ))}
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(3,7,9,0.52)_0%,rgba(3,7,9,0.2)_55%,rgba(3,7,9,0.04)_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(2,6,8,0.06)_0%,rgba(2,6,8,0.01)_40%,rgba(2,6,8,0.72)_100%)]" />
      <div className="absolute inset-0 opacity-[0.11] [background-image:url('data:image/svg+xml,%3Csvg_viewBox=%220_0_180_180%22_xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter_id=%22n%22%3E%3CfeTurbulence_type=%22fractalNoise%22_baseFrequency=%22.9%22_numOctaves=%224%22_stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect_width=%22100%25%22_height=%22100%25%22_filter=%22url(%23n)%22_opacity=%22.32%22/%3E%3C/svg%3E')]" />
    </div>
  )
}
