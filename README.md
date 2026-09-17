# Hawks Golf Practice Predictor

A parent-friendly, heat-based golf practice predictor for Rockwall-Heath girls golf families.

**Live site:** [hawks-practice-predictor.netlify.app](https://hawks-practice-predictor.netlify.app)

The site combines the National Weather Service forecast WBGT for ZIP code `75032` with the Texas UIL Class 3 activity bands. Near practice time it recalculates an estimated WBGT from the nearest live observation's temperature, humidity, wind, pressure, and cloud layers. It answers four practical questions:

1. Is outdoor practice heat-permitted today?
2. How close is the forecast to the no-practice line?
3. What does the next week look like?
4. Which location, forecast grid, and observation station produced the prediction?

## Important limitation

This is a prediction, not an official Rockwall-Heath practice announcement. It does not have access to the school's practice-surface sensor, staff decisions, athlete condition, lightning status, field closures, or the required readings during practice.

## Data sources

- [Zippopotam.us](https://api.zippopotam.us/) for the ZIP-code centroid
- [National Weather Service API](https://www.weather.gov/documentation/services-web-api) for forecast grid, WBGT, and nearby observations
- [National Weather Service WBGT calculator method](https://www.weather.gov/ict/WBGT) for the live weather-derived estimate
- [UIL required heat plan](https://www.uiltexas.org/health/info/heat-stress-and-athletic-participation) for Class 3 activity guidance

## Local development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run build
npm run lint
npm test
```
