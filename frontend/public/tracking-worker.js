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
  } else if (data.type === 'frame') {
    try {
      const started = performance.now()
      let poseLandmarks = [], poseWorldLandmarks = [], poseInferenceMs = null, poseProcessed = false
      if (role !== 'hand' && data.pose !== false) {
        const beforePose = performance.now()
        const result = pose.detectForVideo(data.bitmap, data.timestamp)
        poseInferenceMs = performance.now() - beforePose; poseProcessed = true
        poseLandmarks = result.landmarks[0] || []; poseWorldLandmarks = result.worldLandmarks?.[0] || []
      }
      let hands = null, handWorldLandmarks = null, handedness = null, handInferenceMs = null, handProcessed = false
      let handFailed = false, handCleanupFailed = false, handError = null
      if ((role === 'hand' || data.hand) && (hand || handInitializationError)) {
        if (!hand) { handFailed = true; handError = handInitializationError; hands = [] }
        else {
          try {
            const beforeHand = performance.now()
            const result = hand.detectForVideo(data.bitmap, data.timestamp)
            handInferenceMs = performance.now() - beforeHand; handProcessed = true
            hands = result.landmarks; handWorldLandmarks = result.worldLandmarks ?? []; handedness = result.handedness ?? []
          } catch (error) {
            if (role === 'hand') throw error
            const failedHand = hand; hand = undefined; hands = []; handFailed = true; handError = errorText(error)
            handInitializationError = handError
            try { failedHand.close() } catch (cleanupError) { handCleanupFailed = true; handError += `; cleanup: ${errorText(cleanupError)}` }
          }
        }
      }
      self.postMessage({ type: 'result', id: data.id, pose: poseLandmarks, hands, inferenceMs: performance.now() - started,
        poseProcessed, handProcessed, poseInferenceMs, handInferenceMs, poseWorldLandmarks, handWorldLandmarks, handedness,
        ...(handFailed ? { handFailed: true, handError } : {}), ...(handCleanupFailed ? { handCleanupFailed: true } : {}),
      })
    } catch (error) { self.postMessage({ type: 'error', message: errorText(error) }) }
    finally { data.bitmap.close() }
  }
}
