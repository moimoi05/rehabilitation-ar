/* Classic dedicated worker: MediaPipe's WASM loader is not compatible with module workers. */
let pose, hand, role = 'both', handInitializationError = null
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
  const errors = []
  for (const model of models) {
    try { model?.close() } catch (error) { errors.push(errorText(error)) }
  }
  return errors
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
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
  } else if (data.type === 'dispose') {
    const cleanupErrors = closeModels()
    handInitializationError = null
    self.postMessage({ type: 'disposed', cleanupErrors })
  } else if (data.type === 'frame') {
    try {
      const started = performance.now()
      const transferMs = typeof data.submittedAt === 'number' ? Math.max(0, started - data.submittedAt) : 0
      const captureMs = typeof data.captureMs === 'number' ? data.captureMs : null
      const doHand = (role === 'hand' || data.hand) && (hand || handInitializationError)
      const doPose = role !== 'hand' && data.pose !== false

      let hands = null, handWorldLandmarks = null, handedness = null, handInferenceMs = null, handProcessed = false
      let handFailed = false, handCleanupFailed = false, handError = null

      // Hand inference executed first so hand results reach main thread immediately
      if (doHand) {
        if (!hand) {
          handFailed = true; handError = handInitializationError; hands = []
          self.postMessage({
            type: 'hand_result', id: data.id, timestamp: data.timestamp, hands: [],
            handWorldLandmarks: [], handedness: [], handInferenceMs: 0, handProcessed: false,
            handFailed: true, handError, transferMs, captureMs,
          })
        } else {
          const beforeHand = performance.now()
          try {
            const result = hand.detectForVideo(data.bitmap, data.timestamp)
            handInferenceMs = performance.now() - beforeHand; handProcessed = true
            hands = result.landmarks; handWorldLandmarks = result.worldLandmarks ?? []; handedness = result.handedness ?? []
            self.postMessage({
              type: 'hand_result', id: data.id, timestamp: data.timestamp, hands,
              handWorldLandmarks, handedness, handInferenceMs, handProcessed: true,
              transferMs, captureMs,
            })
          } catch (error) {
            handInferenceMs = performance.now() - beforeHand
            if (role === 'hand') throw error
            const failedHand = hand; hand = undefined; hands = []; handFailed = true; handError = errorText(error)
            handInitializationError = handError
            try { failedHand.close() } catch (cleanupError) { handCleanupFailed = true; handError += `; cleanup: ${errorText(cleanupError)}` }
            self.postMessage({
              type: 'hand_result', id: data.id, timestamp: data.timestamp, hands: [],
              handWorldLandmarks: [], handedness: [], handInferenceMs, handProcessed: false,
              handFailed: true, handError, transferMs, captureMs, ...(handCleanupFailed ? { handCleanupFailed: true } : {}),
            })
          }
        }
      }

      // Pose inference executed second, only when independently scheduled
      let poseLandmarks = [], poseWorldLandmarks = [], poseInferenceMs = null, poseProcessed = false
      let poseFailed = false, poseCleanupFailed = false, poseError = null
      if (doPose && (pose || role === 'pose')) {
        if (!pose) {
          poseFailed = true; poseError = 'Pose model not available'; poseLandmarks = []
          self.postMessage({
            type: 'pose_result', id: data.id, timestamp: data.timestamp, pose: [],
            poseWorldLandmarks: [], poseInferenceMs: 0, poseProcessed: false,
            poseFailed: true, poseError, transferMs, captureMs,
          })
        } else {
          const beforePose = performance.now()
          try {
            const result = pose.detectForVideo(data.bitmap, data.timestamp)
            poseInferenceMs = performance.now() - beforePose; poseProcessed = true
            poseLandmarks = result.landmarks[0] || []; poseWorldLandmarks = result.worldLandmarks?.[0] || []
            self.postMessage({
              type: 'pose_result', id: data.id, timestamp: data.timestamp, pose: poseLandmarks,
              poseWorldLandmarks, poseInferenceMs, poseProcessed: true,
              transferMs, captureMs,
            })
          } catch (error) {
            poseInferenceMs = performance.now() - beforePose
            if (role === 'pose' || !hand) throw error
            const failedPose = pose; pose = undefined; poseLandmarks = []; poseFailed = true; poseError = errorText(error)
            try { failedPose.close() } catch (cleanupError) { poseCleanupFailed = true; poseError += `; cleanup: ${errorText(cleanupError)}` }
            self.postMessage({
              type: 'pose_result', id: data.id, timestamp: data.timestamp, pose: [],
              poseWorldLandmarks: [], poseInferenceMs, poseProcessed: false,
              poseFailed: true, poseError, transferMs, captureMs, ...(poseCleanupFailed ? { poseCleanupFailed: true } : {}),
            })
          }
        }
      }

      // Summary and completion messages
      const totalInferenceMs = performance.now() - started
      const framePayload = {
        id: data.id, timestamp: data.timestamp, pose: poseLandmarks, hands,
        inferenceMs: totalInferenceMs, poseProcessed, handProcessed,
        poseInferenceMs, handInferenceMs, poseWorldLandmarks, handWorldLandmarks, handedness,
        transferMs, captureMs,
        ...(handFailed ? { handFailed: true, handError } : {}),
        ...(handCleanupFailed ? { handCleanupFailed: true } : {}),
        ...(poseFailed ? { poseFailed: true, poseError } : {}),
        ...(poseCleanupFailed ? { poseCleanupFailed: true } : {}),
      }
      self.postMessage({ type: 'frame_complete', ...framePayload })
      self.postMessage({ type: 'result', ...framePayload })
    } catch (error) { self.postMessage({ type: 'error', message: errorText(error) }) }
    finally { data.bitmap.close() }
  }
}
