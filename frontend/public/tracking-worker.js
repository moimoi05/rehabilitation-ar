/* Classic dedicated worker: MediaPipe's WASM loader is not compatible with module workers. */
let pose, hand, role = 'both'
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      role = data.role ?? 'both'
      if (!['both', 'pose', 'hand'].includes(role)) throw new Error('Unknown tracking worker role')
      const { FilesetResolver, PoseLandmarker, HandLandmarker } = await import(data.moduleUrl)
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      if (role !== 'hand') pose = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 })
      if (role === 'hand' || (role === 'both' && data.handEnabled)) hand = await HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2 })
      self.postMessage({ type: 'ready' })
    } catch (error) { self.postMessage({ type: 'error', message: String(error) }) }
  } else if (data.type === 'frame') {
    try {
      const started = performance.now()
      const poseLandmarks = role === 'hand' ? [] : pose.detectForVideo(data.bitmap, data.timestamp).landmarks[0] || []
      let hands = null, handFailed = false, handCleanupFailed = false
      if ((role === 'hand' || data.hand) && hand) {
        try { hands = hand.detectForVideo(data.bitmap, data.timestamp).landmarks }
        catch (error) {
          if (role === 'hand') throw error
          const failedHand = hand; hand = null; hands = []; handFailed = true
          // A cleanup failure must not prevent the Pose result and Hand failure
          // notification from reaching the main thread.
          try { failedHand.close() } catch { handCleanupFailed = true }
        }
      }
      const inferenceMs = performance.now() - started
      self.postMessage({ type: 'result', id: data.id, pose: poseLandmarks, hands, inferenceMs, ...(handFailed ? { handFailed: true } : {}), ...(handCleanupFailed ? { handCleanupFailed: true } : {}) })
    } catch (error) { self.postMessage({ type: 'error', message: String(error) }) }
    finally { data.bitmap.close() }
  }
}
