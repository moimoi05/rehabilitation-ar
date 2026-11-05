/* Classic dedicated worker: MediaPipe's WASM loader is not compatible with module workers. */
let pose, hand, role = 'both', handInitializationError = null
let initialization = null
let poseInferenceError = null
const cleanupFailures = []
const errorText = error => error instanceof Error ? error.message : String(error)

async function initializeModel(Model, files, modelAssetPath, options, preferGpu, name, errors) {
  if (preferGpu) {
    try {
      const canvas = new OffscreenCanvas(1, 1)
      const model = await Model.createFromOptions(files, {
        baseOptions: { modelAssetPath, delegate: 'GPU' }, runningMode: 'VIDEO', ...options, canvas,
      })
      return { model, delegate: 'GPU' }
    } catch (error) {
      errors.push(`${name} GPU: ${errorText(error)}`)
    }
  }
  try {
    return { model: await Model.createFromOptions(files, {
      baseOptions: { modelAssetPath, delegate: 'CPU' }, runningMode: 'VIDEO', ...options,
    }), delegate: 'CPU' }
  } catch (error) {
    throw new Error(`${name} CPU: ${errorText(error)}${errors.length ? `; ${errors.join('; ')}` : ''}`)
  }
}

function closeModels() {
  const models = [pose, hand]
  pose = undefined; hand = undefined
  const errors = [...cleanupFailures]
  for (const model of models) {
    try { model?.close() } catch (error) {
      const message = errorText(error)
      errors.push(message); cleanupFailures.push(message)
    }
  }
  return errors
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    // Message handlers may overlap across await boundaries. Disposal must wait
    // for model creation, including an import/create already in progress.
    if (initialization) {
      self.postMessage({ type: 'error', message: 'Worker already initialized' })
      return
    }
    initialization = (async () => {
    const initializationErrors = [], delegates = { pose: null, hand: null }
    try {
      if (pose || hand) throw new Error('Worker already initialized')
      role = data.role ?? 'both'
      if (!['both', 'pose', 'hand'].includes(role)) throw new Error('Unknown tracking worker role')
      const { FilesetResolver, PoseLandmarker, HandLandmarker } = await import(data.moduleUrl)
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      if (role !== 'hand') {
        const created = await initializeModel(PoseLandmarker, files, '/models/pose_landmarker_lite.task', { numPoses: 1 }, data.preferGpu === true, 'Pose', initializationErrors)
        pose = created.model; delegates.pose = created.delegate
      }
      if (role === 'hand' || (role === 'both' && data.handEnabled)) {
        try {
          const created = await initializeModel(HandLandmarker, files, '/models/hand_landmarker.task', { numHands: 2 }, data.preferGpu === true, 'Hand', initializationErrors)
          hand = created.model; delegates.hand = created.delegate
        } catch (error) {
          if (!pose) throw error
          handInitializationError = errorText(error)
          initializationErrors.push(handInitializationError)
        }
      }
      self.postMessage({ type: 'ready', delegates, initializationErrors })
    } catch (error) {
      const cleanupErrors = closeModels()
      self.postMessage({ type: 'error', message: [errorText(error), ...cleanupErrors].join('; ') })
    }
    })()
    await initialization
  } else if (data.type === 'dispose') {
    await initialization
    const cleanupErrors = closeModels()
    handInitializationError = null
    poseInferenceError = null
    self.postMessage({ type: 'disposed', cleanupErrors })
  } else if (data.type === 'frame') {
    try {
      const frameIdentity = {
        requestId: data.requestId ?? data.id,
        sourceFrameId: data.sourceFrameId ?? null,
        sourceMediaTimeMs: data.sourceMediaTimeMs ?? null,
        sourcePerformanceMs: data.sourcePerformanceMs ?? data.timestamp,
        ...(data.sourceObservationId !== undefined ? { sourceObservationId: data.sourceObservationId } : {}),
        ...(data.captureScope !== undefined ? { captureScope: data.captureScope } : {}),
      }
      const started = performance.now()
      const timeOrigin = typeof performance.timeOrigin === 'number' ? performance.timeOrigin : 0
      const workerArrival = timeOrigin + started
      const transferAndDispatchMs = typeof data.submittedAt === 'number' && Number.isFinite(data.submittedAt) && Number.isFinite(workerArrival)
        ? Math.max(0, workerArrival - data.submittedAt)
        : null
      const captureResizeTotalMs = typeof data.captureResizeTotalMs === 'number' && Number.isFinite(data.captureResizeTotalMs)
        ? data.captureResizeTotalMs
        : typeof data.captureMs === 'number' && Number.isFinite(data.captureMs) ? data.captureMs : null
      const handFirst = data.handFirst !== false
      const doHand = (role === 'hand' || data.hand) && (hand || handInitializationError)
      const doPose = role !== 'hand' && data.pose !== false

      let hands = null, handWorldLandmarks = null, handedness = null, handInferenceMs = null, handProcessed = false
      let handFailed = false, handCleanupFailed = false, handError = null
      let handAttempted = false, poseAttempted = false

      const runHand = () => {
        if (!doHand) return
        if (!hand) {
          handFailed = true; handError = handInitializationError; hands = []
          self.postMessage({
            type: 'hand_result', id: data.id, ...frameIdentity, timestamp: data.timestamp, hands: [],
            handWorldLandmarks: [], handedness: [], handInferenceMs: 0, handProcessed: false, handAttempted: false,
            handFailed: true, handError, transferAndDispatchMs, transferMs: transferAndDispatchMs,
            captureResizeTotalMs, captureMs: captureResizeTotalMs,
          })
        } else {
          const beforeHand = performance.now()
          try {
            handAttempted = true
            const result = hand.detectForVideo(data.bitmap, data.timestamp)
            handInferenceMs = performance.now() - beforeHand; handProcessed = true
            hands = result.landmarks; handWorldLandmarks = result.worldLandmarks ?? []; handedness = result.handedness ?? []
            self.postMessage({
              type: 'hand_result', id: data.id, ...frameIdentity, timestamp: data.timestamp, hands,
              handWorldLandmarks, handedness, handInferenceMs, handProcessed: true, handAttempted,
              transferAndDispatchMs, transferMs: transferAndDispatchMs,
              captureResizeTotalMs, captureMs: captureResizeTotalMs,
            })
          } catch (error) {
            handInferenceMs = performance.now() - beforeHand
            if (role === 'hand') throw error
            const failedHand = hand; hand = undefined; hands = []; handFailed = true; handError = errorText(error)
            handInitializationError = handError
            try { failedHand.close() } catch (cleanupError) {
              handCleanupFailed = true
              const message = `Hand cleanup: ${errorText(cleanupError)}`
              cleanupFailures.push(message); handError += `; ${message}`
            }
            self.postMessage({
              type: 'hand_result', id: data.id, ...frameIdentity, timestamp: data.timestamp, hands: [],
              handWorldLandmarks: [], handedness: [], handInferenceMs, handProcessed: false, handAttempted,
              handFailed: true, handError, transferAndDispatchMs, transferMs: transferAndDispatchMs,
              captureResizeTotalMs, captureMs: captureResizeTotalMs, ...(handCleanupFailed ? { handCleanupFailed: true } : {}),
            })
          }
        }
      }

      let poseLandmarks = [], poseWorldLandmarks = [], poseInferenceMs = null, poseProcessed = false
      let poseFailed = false, poseCleanupFailed = false, poseError = null

      const runPose = () => {
        if (!doPose) return
        if (!pose) {
          poseFailed = true; poseError = poseInferenceError || 'Pose model not available'; poseLandmarks = []
          self.postMessage({
            type: 'pose_result', id: data.id, ...frameIdentity, timestamp: data.timestamp, pose: [],
            poseWorldLandmarks: [], poseInferenceMs: 0, poseProcessed: false, poseAttempted: false,
            poseFailed: true, poseError, transferAndDispatchMs, transferMs: transferAndDispatchMs,
            captureResizeTotalMs, captureMs: captureResizeTotalMs,
          })
        } else {
          const beforePose = performance.now()
          try {
            poseAttempted = true
            const result = pose.detectForVideo(data.bitmap, data.timestamp)
            poseInferenceMs = performance.now() - beforePose; poseProcessed = true
            poseLandmarks = result.landmarks[0] || []; poseWorldLandmarks = result.worldLandmarks?.[0] || []
            self.postMessage({
              type: 'pose_result', id: data.id, ...frameIdentity, timestamp: data.timestamp, pose: poseLandmarks,
              poseWorldLandmarks, poseInferenceMs, poseProcessed: true, poseAttempted,
              transferAndDispatchMs, transferMs: transferAndDispatchMs,
              captureResizeTotalMs, captureMs: captureResizeTotalMs,
            })
          } catch (error) {
            poseInferenceMs = performance.now() - beforePose
            if (role === 'pose' || !hand) throw error
            const failedPose = pose; pose = undefined; poseLandmarks = []; poseFailed = true; poseError = errorText(error)
            poseInferenceError = poseError
            try { failedPose.close() } catch (cleanupError) {
              poseCleanupFailed = true
              const message = `Pose cleanup: ${errorText(cleanupError)}`
              cleanupFailures.push(message); poseError += `; ${message}`
            }
            self.postMessage({
              type: 'pose_result', id: data.id, ...frameIdentity, timestamp: data.timestamp, pose: [],
              poseWorldLandmarks, poseInferenceMs, poseProcessed: false, poseAttempted,
              poseFailed: true, poseError, transferAndDispatchMs, transferMs: transferAndDispatchMs,
              captureResizeTotalMs, captureMs: captureResizeTotalMs, ...(poseCleanupFailed ? { poseCleanupFailed: true } : {}),
            })
          }
        }
      }

      if (handFirst) {
        runHand()
        runPose()
      } else {
        runPose()
        runHand()
      }

      // Summary and completion message (lightweight: avoids structured cloning duplicate landmark arrays)
      const totalInferenceMs = (poseInferenceMs ?? 0) + (handInferenceMs ?? 0)
      self.postMessage({
        type: 'frame_complete',
        id: data.id,
        ...frameIdentity,
        timestamp: data.timestamp,
        inferenceMs: totalInferenceMs,
        poseProcessed,
        handProcessed,
        poseAttempted,
        handAttempted,
        poseInferenceMs,
        handInferenceMs,
        transferAndDispatchMs,
        transferMs: transferAndDispatchMs,
        captureResizeTotalMs,
        captureMs: captureResizeTotalMs,
        ...(handFailed ? { handFailed: true, handError } : {}),
        ...(handCleanupFailed ? { handCleanupFailed: true } : {}),
        ...(poseFailed ? { poseFailed: true, poseError } : {}),
        ...(poseCleanupFailed ? { poseCleanupFailed: true } : {}),
      })
    } catch (error) { self.postMessage({ type: 'error', message: errorText(error) }) }
    finally { data.bitmap.close() }
  }
}
