// Experimental local Worker compatibility probe; does not modify or upload the input video.
// Usage: node tracking-worker-probe.cjs <video> [CPU|GPU] [classic|module]
const { chromium } = require('playwright');
(async () => {
  const videoPath = process.argv[2];
  const delegate = process.argv[3] || 'CPU';
  const workerType = process.argv[4] || 'classic';
  if (!videoPath || !['CPU', 'GPU'].includes(delegate) || !['classic', 'module'].includes(workerType)) throw new Error('Usage: node tracking-worker-probe.cjs <video> [CPU|GPU] [classic|module]');
  const baseUrl = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173';
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.route(`${baseUrl}/__tracking_worker_fixture__`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<input type="file" id="file"><video id="v" muted playsinline></video>' }));
    await page.goto(`${baseUrl}/__tracking_worker_fixture__`);
    await page.locator('#file').setInputFiles(videoPath);
    const result = await page.evaluate(async ({ delegate, workerType }) => {
      const v = document.querySelector('#v');
      const videoUrl = URL.createObjectURL(document.querySelector('#file').files[0]);
      v.src = videoUrl;
      await new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = reject; });
      if (!Number.isFinite(v.duration) || v.duration <= 3) throw new Error('Video must be longer than the 3-second warm-up.');
      const moduleUrl = `${location.origin}/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs`;
      const wasmUrl = `${location.origin}/mediapipe/wasm`;
      const modelUrl = `${location.origin}/models/pose_landmarker_lite.task`;
      const source = `
        let pose;
        self.onmessage = async ({ data }) => {
          if (data.type === 'init') {
            try {
              const { FilesetResolver, PoseLandmarker } = await import(data.moduleUrl);
              const files = await FilesetResolver.forVisionTasks(data.wasmUrl);
              pose = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: data.modelUrl, delegate: data.delegate }, runningMode: 'VIDEO', numPoses: 1 });
              self.postMessage({ type: 'ready' });
            } catch (error) { self.postMessage({ type: 'error', stage: 'init', message: String(error && error.stack || error) }); }
          } else if (data.type === 'frame') {
            try {
              const start = performance.now();
              const result = pose.detectForVideo(data.bitmap, data.timestamp);
              self.postMessage({ type: 'result', id: data.id, inferenceMs: performance.now() - start, valid: !!result.landmarks[0]?.length });
            } catch (error) { self.postMessage({ type: 'error', stage: 'inference', message: String(error && error.stack || error) }); }
            finally { data.bitmap.close(); }
          } else if (data.type === 'close') { pose?.close(); self.close(); }
        };`;
      const workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(workerUrl, { type: workerType });
      const initial = await new Promise(resolve => {
        const timer = setTimeout(() => resolve({ type: 'error', stage: 'timeout', message: 'Worker initialization timed out' }), 30000);
        worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
        worker.onerror = event => { clearTimeout(timer); resolve({ type: 'error', stage: 'worker', message: event.message }); };
        worker.postMessage({ type: 'init', moduleUrl, wasmUrl, modelUrl, delegate });
      });
      if (initial.type !== 'ready') { worker.terminate(); URL.revokeObjectURL(workerUrl); URL.revokeObjectURL(videoUrl); return { delegate, workerType, browser: navigator.userAgent, initialization: initial }; }
      let active = true, busy = false, measurementStart = 0, end = 0, lastRun = -Infinity, cost = 0, sequence = 0, calls = 0, valid = 0;
      let frames = 0, busySkipped = 0, throttled = 0, renders = 0, presentedStart = 0, presentedEnd = 0, submittedAt = 0, failure = null;
      const durations = [], roundTrips = [], copyDurations = [], longTasks = [];
      let observer;
      try { observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().filter(e => measurementStart && e.startTime >= measurementStart).map(e => e.duration))); observer.observe({ entryTypes: ['longtask'] }); } catch { /* unavailable */ }
      worker.onmessage = ({ data }) => {
        if (data.type === 'error') { failure = data; active = false; busy = false; return; }
        if (data.type !== 'result') return;
        const roundTrip = performance.now() - submittedAt;
        cost = cost ? .75 * cost + .25 * roundTrip : roundTrip;
        if (measurementStart && submittedAt >= measurementStart) { calls++; if (data.valid) valid++; durations.push(data.inferenceMs); roundTrips.push(roundTrip); }
        busy = false;
      };
      worker.onerror = event => { failure = { stage: 'worker', message: event.message }; active = false; busy = false; };
      await v.play();
      const observe = async (now, metadata) => {
        if (!active) return;
        if (measurementStart) { frames++; if (!presentedStart) presentedStart = metadata.presentedFrames; presentedEnd = metadata.presentedFrames; }
        const interval = Math.max(1000 / 24, Math.min(200, cost + Math.min(50, cost * .2)));
        if (busy) { if (measurementStart) busySkipped++; }
        else if (now - lastRun < interval) { if (measurementStart) throttled++; }
        else {
          busy = true; lastRun = now;
          try {
            const copyStarted = performance.now();
            const bitmap = await createImageBitmap(v);
            if (!active) { bitmap.close(); busy = false; return; }
            submittedAt = copyStarted;
            if (measurementStart) copyDurations.push(performance.now() - copyStarted);
            worker.postMessage({ type: 'frame', bitmap, timestamp: now, id: ++sequence }, [bitmap]);
          } catch (error) { failure = { stage: 'copy', message: String(error) }; active = false; busy = false; }
        }
        if (active) v.requestVideoFrameCallback(observe);
      };
      if (!v.requestVideoFrameCallback) throw new Error('requestVideoFrameCallback unavailable');
      v.requestVideoFrameCallback(observe);
      await new Promise(resolve => {
        const loop = now => {
          if (!active || v.ended || (measurementStart && now - measurementStart >= 12000)) { end = performance.now(); active = false; resolve(); return; }
          if (v.currentTime >= 3 && !measurementStart) measurementStart = now;
          if (measurementStart) renders++;
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      // Allow the in-flight frame to finish and close its ImageBitmap before closing the model.
      observer?.disconnect();
      const cleanupDeadline = performance.now() + 5000;
      while (busy && performance.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      worker.postMessage({ type: 'close' });
      await new Promise(resolve => setTimeout(resolve, 50)); worker.terminate();
      v.pause(); URL.revokeObjectURL(workerUrl); URL.revokeObjectURL(videoUrl);
      const percentile = (arr, p) => { const sorted = [...arr].sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null; };
      const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
      const seconds = (end - measurementStart) / 1000;
      return { delegate, workerType, initialization: 'ready', failure, metadata: { width: v.videoWidth, height: v.videoHeight, duration: v.duration }, measurementSeconds: seconds,
        calls, inferenceFps: calls / seconds, inferenceMeanMs: mean(durations), inferenceP50Ms: percentile(durations, .5), inferenceP95Ms: percentile(durations, .95),
        roundTripMeanMs: mean(roundTrips), roundTripP95Ms: percentile(roundTrips, .95), bitmapCreateMeanMs: mean(copyDurations), bitmapCreateP95Ms: percentile(copyDurations, .95),
        validFrames: valid, observedVideoCallbacks: frames, presentedFrameDelta: presentedEnd - presentedStart, busySkipped, throttled,
        rafFps: renders / seconds, longTaskCount: longTasks.length, longTaskMaxMs: Math.max(0, ...longTasks), browser: navigator.userAgent };
    }, { delegate, workerType });
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
