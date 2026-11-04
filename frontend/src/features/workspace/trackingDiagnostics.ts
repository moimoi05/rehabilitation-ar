const WINDOW_MS = 10000
const MAX_SAMPLES = 300
const FRESH_MS = 150
const RENDER_BUDGET_MS = 100
const MAX_COUNT = 1000000000

type Sample = { at: number; inferenceMs: number | null }
type HandTimingSample = Sample & { captureResizeTotalMs: number | null; transferAndDispatchMs: number | null }
type SourceVisibility = 'visible' | 'hidden' | 'prerender' | 'unknown'
type HandSample = {
  timestamp: number; receivedAt: number; handCount: number; validHandCount: number
  requestId?: number | null; frameId?: number | null; inferenceMs?: number | null
  captureResizeTotalMs?: number | null; transferAndDispatchMs?: number | null
  handednessLabels?: string[]
}
export type DrawingDiagnostic = {
  reason: string | null; selected: boolean; armed: boolean; gestureActive: boolean | null
  penDown: boolean; observationTimestamp: number | null
  completedStrokes?: number
}
const emptyDrawing = (): DrawingDiagnostic => ({ reason: 'DRAWING_PAUSED', selected: false, armed: false, gestureActive: null, penDown: false, observationTimestamp: null })
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const age = (now: number, then: number | null) => then === null ? null : Math.max(0, now - then)
const percentile = (values: number[], fraction: number) => {
  const sorted = values.filter(finite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null
}
const distribution = (values: number[]) => ({ p50: percentile(values, .5), p95: percentile(values, .95) })
const rate = (samples: Sample[], now: number) => samples.length > 1 && now > samples[0].at
  ? (samples.length - 1) * 1000 / (now - samples[0].at) : 0
const reasonCode = (value: string) => /^[A-Z_]{1,40}$/.test(value) ? value : 'OTHER'
const duration = (value: unknown) => finite(value) && value >= 0 ? value : null
const sourceVisibility = (value: unknown): SourceVisibility => value === 'visible' || value === 'hidden' || value === 'prerender' ? value : 'unknown'
const canonicalReason = (value: string | null) => value === null ? null : ({
  WORKER_RESULT_DELAYED: 'HAND_RESULT_DELAYED', STALE_HAND: 'HAND_STALE',
  SIDE_AMBIGUOUS: 'HAND_IDENTITY_AMBIGUOUS', ACQUIRING: 'AFFECTED_HAND_NOT_SELECTED',
  GESTURE_INACTIVE: 'GESTURE_NOT_RECOGNIZED',
}[value] || reasonCode(value))

/** Fixed bins keep full-run timing statistics bounded. Percentiles are bin upper
 * bounds, not exact samples; mean/min/max and counts cover every callback. */
const timingBounds = [0, 1, 2, 3, 4, 5, 8, 12, 16, 20, 25, 33, 40, 50, 66, 80, 100, 125, 150, 200, 250, 333, 500, 750, 1000, 1500, 2500, 5000, 10000, 30000, 60000, Infinity]
function timingTotals() {
  let count = 0, sum = 0, min = Infinity, max = 0
  const bins = timingBounds.map(() => 0)
  return {
    add(value: unknown) {
      if (!finite(value) || value < 0) return
      count += 1; sum += value; min = Math.min(min, value); max = Math.max(max, value)
      bins[timingBounds.findIndex(bound => value <= bound)] += 1
    },
    snapshot() {
      const quantile = (fraction: number) => {
        if (!count) return null
        let total = 0
        for (let index = 0; index < bins.length; index++) {
          total += bins[index]
          if (total >= Math.ceil(count * fraction)) return Math.min(max, timingBounds[index])
        }
        return max
      }
      return { count, mean: count ? sum / count : null, min: count ? min : null, max: count ? max : null, p50UpperBound: quantile(.5), p95UpperBound: quantile(.95) }
    },
  }
}

function replayTotals(startedAt: number) {
  let counts = { submittedFrames: 0, submittedHandFrames: 0, handInferenceCalls: 0, handResultsReceived: 0, rawMissingResults: 0, validHandResults: 0,
    invalidHandResults: 0, rejectedHandObservations: 0, affectedHandSelections: 0, affectedHandSelectionFailures: 0, affectedHandAcquisitionObservations: 0, associationChanges: 0,
    gestureActivations: 0, penDownEvents: 0, completedStrokes: 0 }
  const inference = timingTotals(), arrival = timingTotals(), ageTotals = timingTotals(), capture = timingTotals(), transfer = timingTotals()
  let previousArrival: number | null = null, firstArrival: number | null = null, labels: string | null = null
  let lastObservation: number | null = null, selected = false, hadSelected = false, gesture = false, pen = false
  let gapStart: number | null = startedAt, interruptionCount = 0, longestGap = 0, totalGap = 0
  let intervals: { startMs: number; durationMs: number }[] = []
  let rawGapStart: number | null = null, rawInterruptionCount = 0, rawLongestGap = 0, rawTotalGap = 0
  let rawIntervals: { startMs: number; durationMs: number }[] = []
  let blocked: Record<string, number> = {}, blockedDurations: Record<string, number> = {}, rejections: Record<string, number> = {}, frontendRejectionReasons: Record<string, number> = {}
  let lastReason: string | null = null, reasonSince = startedAt
  const add = (values: Record<string, number>, key: string, value = 1) => {
    const boundedKey = Object.hasOwn(values, key) || Object.keys(values).length < 40 ? key : 'OTHER'
    return { ...values, [boundedKey]: (values[boundedKey] || 0) + value }
  }
  return {
    submit(hand: boolean) { counts = { ...counts, submittedFrames: counts.submittedFrames + 1, submittedHandFrames: counts.submittedHandFrames + Number(hand) } },
    hand(sample: HandSample) {
      if (previousArrival !== null) arrival.add(sample.receivedAt - previousArrival)
      previousArrival = sample.receivedAt; firstArrival ??= sample.receivedAt
      inference.add(sample.inferenceMs); capture.add(sample.captureResizeTotalMs); transfer.add(sample.transferAndDispatchMs)
      ageTotals.add(sample.receivedAt - sample.timestamp)
      if (sample.handCount === 0 && rawGapStart === null) { rawGapStart = sample.receivedAt; rawInterruptionCount += 1 }
      else if (sample.handCount > 0 && rawGapStart !== null) {
        const durationMs = Math.max(0, sample.receivedAt - rawGapStart)
        rawLongestGap = Math.max(rawLongestGap, durationMs); rawTotalGap += durationMs
        rawIntervals = [...rawIntervals, { startMs: Math.max(0, rawGapStart - startedAt), durationMs }].slice(-100)
        rawGapStart = null
      }
      counts = { ...counts, handInferenceCalls: counts.handInferenceCalls + 1, handResultsReceived: counts.handResultsReceived + 1,
        rawMissingResults: counts.rawMissingResults + Number(sample.handCount === 0), validHandResults: counts.validHandResults + Number(sample.validHandCount > 0),
        invalidHandResults: counts.invalidHandResults + Number(sample.handCount > 0 && sample.validHandCount === 0) }
      const currentLabels = sample.handednessLabels?.filter(label => label === 'Left' || label === 'Right').sort().join(',')
      if (currentLabels) {
        if (labels !== null && labels !== currentLabels) counts = { ...counts, associationChanges: counts.associationChanges + 1 }
        labels = currentLabels
      }
    },
    reject(reason: string, rejectedObservation: boolean) {
      const key = canonicalReason(reason) || 'OTHER'
      rejections = add(rejections, key)
      if (rejectedObservation) {
        counts = { ...counts, rejectedHandObservations: counts.rejectedHandObservations + 1 }
        frontendRejectionReasons = add(frontendRejectionReasons, key)
      }
    },
    drawing(value: DrawingDiagnostic, now: number) {
      const reason = canonicalReason(value.reason) || (value.penDown ? 'PEN_DOWN' : 'DRAWING_READY')
      const freshObservation = finite(value.observationTimestamp) && value.observationTimestamp > 0 && value.observationTimestamp !== lastObservation
      if (freshObservation) {
        lastObservation = value.observationTimestamp
        counts = { ...counts, affectedHandSelections: counts.affectedHandSelections + Number(value.selected),
          affectedHandSelectionFailures: counts.affectedHandSelectionFailures + Number(!value.selected && reason === 'HAND_IDENTITY_AMBIGUOUS'),
          affectedHandAcquisitionObservations: counts.affectedHandAcquisitionObservations + Number(!value.selected && reason === 'AFFECTED_HAND_NOT_SELECTED') }
        if (!['PEN_DOWN', 'DRAWING_READY'].includes(reason)) blocked = add(blocked, reason)
      } else if (reason !== lastReason && !['PEN_DOWN', 'DRAWING_READY'].includes(reason)) blocked = add(blocked, reason)
      if (value.gestureActive === true && !gesture) counts = { ...counts, gestureActivations: counts.gestureActivations + 1 }
      if (value.penDown && !pen) counts = { ...counts, penDownEvents: counts.penDownEvents + 1 }
      gesture = value.gestureActive === true; pen = value.penDown
      if (value.completedStrokes !== undefined && finite(value.completedStrokes)) counts = { ...counts, completedStrokes: Math.max(0, Math.floor(value.completedStrokes)) }
      if (value.selected && gapStart !== null) {
        const durationMs = Math.max(0, now - gapStart)
        longestGap = Math.max(longestGap, durationMs); totalGap += durationMs
        if (hadSelected) intervals = [...intervals, { startMs: Math.max(0, gapStart - startedAt), durationMs }].slice(-100)
        gapStart = null
      } else if (!value.selected && selected) { gapStart = now; interruptionCount += 1 }
      selected = value.selected; hadSelected ||= selected
      if (reason !== lastReason) {
        if (lastReason !== null) blockedDurations = add(blockedDurations, lastReason, Math.max(0, now - reasonSince))
        lastReason = reason; reasonSince = now
      }
    },
    snapshot(now: number, completedStrokes?: number) {
      const ongoingGap = gapStart === null ? 0 : Math.max(0, now - gapStart)
      const rawOngoingGap = rawGapStart === null ? 0 : Math.max(0, now - rawGapStart)
      return {
        durationMs: Math.max(0, now - startedAt),
        counts: { ...counts, ...(finite(completedStrokes) ? { completedStrokes: Math.max(0, Math.floor(completedStrokes)) } : {}) },
        handResultFps: firstArrival !== null && now > firstArrival ? Math.max(0, counts.handResultsReceived - 1) * 1000 / (now - firstArrival) : 0,
        handInferenceMs: inference.snapshot(), handArrivalIntervalMs: arrival.snapshot(), handObservationAgeMs: ageTotals.snapshot(),
        captureResizeTotalMs: capture.snapshot(), transferAndDispatchMs: transfer.snapshot(),
        missingSelectedHand: { interruptionCount, longestMs: Math.max(longestGap, ongoingGap), totalMs: totalGap + ongoingGap,
          ongoingMs: ongoingGap, intervals: intervals.map(interval => ({ ...interval })), retainedIntervalLimit: 100 },
        rawMissingHand: { interruptionCount: rawInterruptionCount, longestMs: Math.max(rawLongestGap, rawOngoingGap), totalMs: rawTotalGap + rawOngoingGap,
          ongoingMs: rawOngoingGap, intervals: rawIntervals.map(interval => ({ ...interval })), retainedIntervalLimit: 100 },
        blockedReasons: { ...blocked }, blockedDurationMs: lastReason === null ? { ...blockedDurations } : add(blockedDurations, lastReason, Math.max(0, now - reasonSince)),
        rejections: { ...rejections }, frontendRejectionReasons: { ...frontendRejectionReasons },
        timingPercentiles: 'Fixed-bin upper bounds; mean, min, max and counts include every callback.',
      }
    },
  }
}

/** Opt-in, aggregate-only diagnostics. No landmarks, frames or patient identifiers enter this collector. */
export function createTrackingDiagnostics() {
  let startedAt = performance.now()
  let active = false
  let hands: HandTimingSample[] = [], poses: Sample[] = [], renders: Sample[] = [], sources: Sample[] = []
  let latestSourceAt: number | null = null, visibility: SourceVisibility = 'unknown'
  let latestHand: HandSample | null = null
  let lastDetectionAt: number | null = null, longestGap = 0
  let pendingRenderAt: number | null = null, renderedTimestamp: number | null = null
  let drawing = emptyDrawing(), lastRejection: string | null = null
  let rejections: Record<string, number> = {}, skipped: Record<string, number> = {}
  let counts = { handCallbacks: 0, poseCallbacks: 0, rawMissing: 0, invalidHands: 0 }
  let totals = replayTotals(startedAt)
  const increment = (value: number, count = 1) => Math.min(MAX_COUNT, value + Math.max(0, Math.floor(finite(count) ? count : 0)))
  const addCount = (values: Record<string, number>, reason: string, count = 1) => {
    const key = reason in values || Object.keys(values).length < 32 ? reason : 'OTHER'
    return { ...values, [key]: increment(values[key] || 0, count) }
  }
  const prune = <T extends Sample>(samples: T[], now: number): T[] => samples.filter(sample => sample.at >= now - WINDOW_MS).slice(-MAX_SAMPLES)
  const addSample = (samples: Sample[], receivedAt: number, inferenceMs?: number | null) => [...prune(samples, receivedAt), { at: receivedAt, inferenceMs: finite(inferenceMs) && inferenceMs >= 0 ? inferenceMs : null }].slice(-MAX_SAMPLES)
  const collector = {
    setActive(value: boolean, now = performance.now()) {
      if (active === value) return
      active = value
      pendingRenderAt = null
      drawing = emptyDrawing()
      if (active) startedAt = now
    },
    reset(now = performance.now()) {
      startedAt = now; hands = []; poses = []; renders = []; sources = []; latestHand = null
      latestSourceAt = null; visibility = 'unknown'
      lastDetectionAt = null; longestGap = 0; pendingRenderAt = null; renderedTimestamp = null
      drawing = emptyDrawing(); lastRejection = null; rejections = {}; skipped = {}
      counts = { handCallbacks: 0, poseCallbacks: 0, rawMissing: 0, invalidHands: 0 }
      totals = replayTotals(now)
    },
    recordSubmit(sample: { timestamp: number; hand: boolean; pose?: boolean }) {
      if (finite(sample.timestamp)) totals.submit(sample.hand)
    },
    recordSource(sample: { timestamp: number; visibility: SourceVisibility }) {
      if (!finite(sample.timestamp)) return
      sources = addSample(sources, sample.timestamp)
      latestSourceAt = sample.timestamp
      visibility = sourceVisibility(sample.visibility)
    },
    recordHand(sample: HandSample) {
      if (!finite(sample.receivedAt) || !finite(sample.timestamp)) return
      totals.hand(sample)
      if (latestHand && latestHand.receivedAt >= startedAt) longestGap = Math.max(longestGap, sample.receivedAt - latestHand.receivedAt)
      hands = [...prune(hands, sample.receivedAt), {
        at: sample.receivedAt, inferenceMs: duration(sample.inferenceMs),
        captureResizeTotalMs: duration(sample.captureResizeTotalMs), transferAndDispatchMs: duration(sample.transferAndDispatchMs),
      }].slice(-MAX_SAMPLES)
      // Whitelist primitive fields, so callers cannot accidentally export clinical observations.
      latestHand = {
        timestamp: sample.timestamp, receivedAt: sample.receivedAt,
        handCount: sample.handCount, validHandCount: sample.validHandCount,
        requestId: finite(sample.requestId) ? sample.requestId : null,
        frameId: finite(sample.frameId) ? sample.frameId : null,
      }
      if (sample.validHandCount > 0) lastDetectionAt = sample.receivedAt
      counts = {
        ...counts, handCallbacks: increment(counts.handCallbacks),
        rawMissing: increment(counts.rawMissing, sample.handCount === 0 ? 1 : 0),
        invalidHands: increment(counts.invalidHands, sample.handCount > 0 && sample.validHandCount === 0 ? 1 : 0),
      }
    },
    recordPose(sample: { receivedAt: number; inferenceMs?: number | null }) {
      if (!finite(sample.receivedAt)) return
      poses = addSample(poses, sample.receivedAt, sample.inferenceMs)
      counts = { ...counts, poseCallbacks: increment(counts.poseCallbacks) }
    },
    recordSkip(reason: string, count = 1) {
      const key = ['busy', 'duplicate', 'throttled', 'source', 'budget'].includes(reason) ? reason : 'other'
      skipped = addCount(skipped, key, count)
    },
    reject(reason: string, rejectedObservation = false) {
      lastRejection = reasonCode(reason)
      rejections = addCount(rejections, lastRejection)
      totals.reject(lastRejection, rejectedObservation)
    },
    recordDrawing(value: DrawingDiagnostic, now = performance.now()) {
      totals.drawing(value, now)
      drawing = {
        reason: value.reason === null ? null : reasonCode(value.reason), selected: value.selected,
        armed: value.armed, gestureActive: value.gestureActive, penDown: value.penDown,
        observationTimestamp: finite(value.observationTimestamp) ? value.observationTimestamp : null,
      }
      if (!active || !drawing.selected || drawing.observationTimestamp === null) pendingRenderAt = null
      else if (drawing.observationTimestamp !== renderedTimestamp && pendingRenderAt === null) pendingRenderAt = latestHand?.receivedAt ?? performance.now()
    },
    recordRender(observationTimestamp: number) {
      if (!finite(observationTimestamp)) return
      renderedTimestamp = observationTimestamp
      if (drawing.observationTimestamp === observationTimestamp) pendingRenderAt = null
      renders = addSample(renders, performance.now())
    },
    report(now = performance.now(), completedStrokes?: number) { return totals.snapshot(now, completedStrokes) },
    snapshot(now: number, delegate: string, currentVisibility?: SourceVisibility) {
      hands = prune(hands, now); poses = prune(poses, now); renders = prune(renders, now); sources = prune(sources, now)
      const currentHand = latestHand && (!active || latestHand.receivedAt >= startedAt) ? latestHand : null
      const callbackAgeMs = age(now, currentHand?.receivedAt ?? null)
      const observationAgeMs = age(now, currentHand?.timestamp ?? null)
      const intervals = hands.slice(1).map((sample, index) => sample.at - hands[index].at)
      const sourceIntervals = sources.slice(1).map((sample, index) => sample.at - sources[index].at)
      let trackingReason: string | null = null
      if (active) {
        if ((callbackAgeMs ?? now - startedAt) > FRESH_MS) trackingReason = 'WORKER_RESULT_DELAYED'
        else if (currentHand?.handCount === 0) trackingReason = 'RAW_HAND_MISSING'
        else if (currentHand && currentHand.validHandCount === 0) trackingReason = 'HAND_INVALID'
        else if (observationAgeMs !== null && observationAgeMs > FRESH_MS) trackingReason = 'STALE_HAND'
        else if (!drawing.selected && ['HAND_INVALID', 'SIDE_AMBIGUOUS', 'ACQUIRING'].includes(drawing.reason || '')) trackingReason = drawing.reason
        else if (pendingRenderAt !== null && now - pendingRenderAt > RENDER_BUDGET_MS) trackingReason = 'RENDER_NOT_UPDATED'
      }
      const currentDrawing = active ? drawing : emptyDrawing()
      return {
        active,
        windowMs: WINDOW_MS, handFps: rate(hands, now), poseFps: rate(poses, now), overlayUpdateFps: rate(renders, now),
        handSampleCount: hands.length, poseSampleCount: poses.length,
        sourceCallbackFps: rate(sources, now), sourceSampleCount: sources.length,
        sourceIntervalMs: distribution(sourceIntervals), sourceCallbackAgeMs: age(now, latestSourceAt),
        visibility: sourceVisibility(currentVisibility ?? visibility),
        handInferenceMs: distribution(hands.flatMap(sample => sample.inferenceMs === null ? [] : [sample.inferenceMs])),
        captureResizeTotalMs: distribution(hands.flatMap(sample => sample.captureResizeTotalMs === null ? [] : [sample.captureResizeTotalMs])),
        transferAndDispatchMs: distribution(hands.flatMap(sample => sample.transferAndDispatchMs === null ? [] : [sample.transferAndDispatchMs])),
        poseInferenceMs: distribution(poses.flatMap(sample => sample.inferenceMs === null ? [] : [sample.inferenceMs])),
        handIntervalMs: distribution(intervals), longestHandGapMs: Math.max(longestGap, callbackAgeMs ?? 0),
        callbackAgeMs, detectionAgeMs: age(now, lastDetectionAt), observationAgeMs,
        handCount: latestHand?.handCount ?? null, validHandCount: latestHand?.validHandCount ?? null,
        requestId: latestHand?.requestId ?? null, frameId: latestHand?.frameId ?? null,
        selected: currentDrawing.selected, lastRejection, trackingReason, canonicalTrackingReason: canonicalReason(trackingReason),
        canonicalDrawingReason: canonicalReason(currentDrawing.reason) || (currentDrawing.penDown ? 'PEN_DOWN' : 'DRAWING_READY'), drawing: { ...currentDrawing },
        renderedTimestamp, delegate, counts: { ...counts }, rejections: { ...rejections }, skipped: { ...skipped },
      }
    },
  }
  return collector
}

export type TrackingDiagnostics = ReturnType<typeof createTrackingDiagnostics>
