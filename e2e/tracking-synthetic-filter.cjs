// Deterministic synthetic signal probe; this does not read or represent a patient video.
// Usage from e2e: node tracking-synthetic-filter.cjs
// The actual application TypeScript is transpiled in memory, without modifying it.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const ts = require('../frontend/node_modules/typescript')

function seededNoise(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return ((state >>> 0) / 0x100000000 * 2 - 1) * 0.01
  }
}

function irregularSamples(truth, seed) {
  const noise = seededNoise(seed), intervalsMs = [20, 35, 50, 27, 42, 25]
  const observations = []
  let time = 0, index = 0
  while (time <= 8000) {
    const actual = truth(time / 1000)
    observations.push({ time, truth: actual, raw: actual + noise() })
    time += intervalsMs[index++ % intervalsMs.length]
  }
  return observations
}

function rms(values) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
}

function sinusoidAmplitude(points, key) {
  // Least-squares fit with intercept to account for irregular sample spacing.
  const angular = 2 * Math.PI * 0.35
  const means = points.reduce((s, p) => ({
    value: s.value + p[key] / points.length,
    sin: s.sin + Math.sin(angular * p.time / 1000) / points.length,
    cos: s.cos + Math.cos(angular * p.time / 1000) / points.length,
  }), { value: 0, sin: 0, cos: 0 })
  let ss = 0, cc = 0, sc = 0, sy = 0, cy = 0
  for (const p of points) {
    const s = Math.sin(angular * p.time / 1000) - means.sin
    const c = Math.cos(angular * p.time / 1000) - means.cos
    const y = p[key] - means.value
    ss += s * s; cc += c * c; sc += s * c; sy += s * y; cy += c * y
  }
  const det = ss * cc - sc * sc
  return Math.hypot((sy * cc - cy * sc) / det, (cy * ss - sy * sc) / det)
}

async function main() {
  const source = readFileSync(join(__dirname, '../frontend/src/features/workspace/landmarkSmoothing.ts'), 'utf8')
  const transpiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { LandmarkSmoother, DEFAULT_SMOOTHING_CONFIG, SMOOTHING_VERSION, POSE_SMOOTHING_POLICY } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
  const variants = {
    raw: null,
    default: {},
    beta2: { beta: 2 },
    minCutoff2: { minCutoff: 2 },
    both: { minCutoff: 2, beta: 2 },
  }
  const cases = {
    stationary: { seed: 123, truth: () => .5, window: [1500, 8000] },
    smallSine: { seed: 234, truth: t => .5 + .008 * Math.sin(2 * Math.PI * .35 * t), window: [1500, 8000] },
    ramp: { seed: 345, truth: t => .3 + .4 * Math.max(0, Math.min(1, (t - 2) / 3)), window: [2000, 5000] },
    reversal: { seed: 456, truth: t => .3 + .4 * (t < 2 ? 0 : t < 4 ? (t - 2) / 2 : t < 6 ? (6 - t) / 2 : 0), window: [4000, 6000] },
    step: { seed: 567, truth: t => t < 2 ? .3 : .7, window: [2000, 4000] },
  }
  const results = {}
  for (const [name, config] of Object.entries(cases)) {
    const samples = irregularSamples(config.truth, config.seed)
    const pointsByVariant = {}
    for (const [variant, override] of Object.entries(variants)) {
      const filter = override && new LandmarkSmoother(override)
      pointsByVariant[variant] = samples.map(p => ({
        ...p,
        output: filter ? filter.filter('pose', [{ x: p.raw, y: .5, visibility: 1 }], p.time, POSE_SMOOTHING_POLICY)[0].x : p.raw,
      }))
    }
    results[name] = {}
    for (const [variant, points] of Object.entries(pointsByVariant)) {
      const eligible = points.filter(p => p.time >= config.window[0] && p.time < config.window[1])
      const errors = eligible.map(p => p.output - p.truth)
      const summary = { count: eligible.length, rmsError: rms(errors), maxAbsoluteError: Math.max(...errors.map(Math.abs)) }
      if (name === 'smallSine') summary.amplitudeRatioToTruth = sinusoidAmplitude(eligible, 'output') / sinusoidAmplitude(eligible, 'truth')
      if (name === 'step') {
        const crossing = eligible.find(p => p.output >= .3 + .9 * .4)
        summary.first90PercentCrossingMs = crossing ? crossing.time - 2000 : null
      }
      results[name][variant] = summary
    }
  }
  console.log(JSON.stringify({
    synthetic: true, version: SMOOTHING_VERSION, defaultConfig: DEFAULT_SMOOTHING_CONFIG, variants,
    method: 'Same seeded uniform noise ±0.01 and irregular 20/35/50/27/42/25 ms intervals for all variants within each case; normalized coordinates. Small sine amplitude 0.008 at 0.35 Hz. Ramp, reversal and step are ideal synthetic trajectories. RMS/max errors use known truth, not model output. First threshold crossing is quantized to observation time and is not a clinical latency.',
    limitations: 'Synthetic noise and trajectories are not a patient, MediaPipe output or clinical validation. They do not prove accuracy or real-world responsiveness; a single seed per case is illustrative.',
    results,
  }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
