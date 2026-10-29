// Reproduces the original pose-only loop or runs the current scheduler against a local video.
// No video bytes are copied into the project or uploaded. Run with <video> [baseline|optimized].
const { chromium } = require('playwright');

(async () => {
  const videoPath = process.argv[2];
  const mode = process.argv[3] || 'baseline';
  if (!videoPath || !['baseline', 'optimized'].includes(mode)) {
    throw new Error('Usage: node tracking-baseline.cjs <local-video-path> [baseline|optimized]');
  }
  const baseUrl = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173';
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('PAGE ERROR:', error.message));
    await page.route(`${baseUrl}/__tracking_benchmark_fixture__`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<input type="file" id="file"><video id="v" muted playsinline></video>' }));
    await page.goto(`${baseUrl}/__tracking_benchmark_fixture__`);
    await page.locator('#file').setInputFiles(videoPath);
    const result = await page.evaluate(async mode => {
      const v = document.querySelector('#v');
      const url = URL.createObjectURL(document.querySelector('#file').files[0]);
      v.src = url;
      await new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = reject; });
      const metadata = { width: v.videoWidth, height: v.videoHeight, duration: v.duration };
      if (!Number.isFinite(v.duration) || v.duration <= 3) throw new Error('Video must be longer than the 3-second warm-up.');
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs');
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const pose = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 });
      const scheduler = mode === 'optimized' ? await import('/src/features/workspace/videoFrameScheduler.ts') : null;
      let measurementStart = 0, end = 0, calls = 0, valid = 0, duplicate = 0, throttled = 0, render = 0;
      let frameObservations = 0, presentedStart = 0, presentedEnd = 0, active = true, lastRun = 0, lastVideoTime = -1;
      const latencies = [], longTasks = [];
      let observer;
      try {
        observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().filter(e => measurementStart && e.startTime >= measurementStart).map(e => e.duration)));
        observer.observe({ entryTypes: ['longtask'] });
      } catch { /* unavailable */ }
      const infer = timestamp => {
        const started = performance.now();
        const result = pose.detectForVideo(v, timestamp);
        const elapsed = performance.now() - started;
        if (measurementStart) { calls++; latencies.push(elapsed); if (result.landmarks[0]?.length) valid++; }
      };
      await v.play();
      if (v.requestVideoFrameCallback) {
        const observe = (_, metadata) => {
          if (!active) return;
          if (measurementStart) { frameObservations++; if (!presentedStart) presentedStart = metadata.presentedFrames; presentedEnd = metadata.presentedFrames; }
          v.requestVideoFrameCallback(observe);
        };
        v.requestVideoFrameCallback(observe);
      }
      const stopScheduler = scheduler?.startVideoFrameScheduler(v, frame => infer(frame.inferenceTimestamp), {
        maxFps: 24, onSkip: reason => { if (measurementStart) { if (reason === 'duplicate') duplicate++; else throttled++; } },
      });
      await new Promise(resolve => {
        const loop = now => {
          if (v.ended || (measurementStart && now - measurementStart >= 12000)) { end = performance.now(); active = false; resolve(); return; }
          if (v.currentTime >= 3 && !measurementStart) { measurementStart = now; lastRun = 0; lastVideoTime = -1; }
          if (measurementStart) render++;
          if (mode === 'baseline') {
            if (v.readyState >= 2 && v.currentTime !== lastVideoTime && now - lastRun >= 100) {
              lastVideoTime = v.currentTime; lastRun = now; infer(now);
            } else if (measurementStart) { if (v.currentTime === lastVideoTime) duplicate++; else throttled++; }
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      stopScheduler?.(); observer?.disconnect(); pose.close(); v.pause(); URL.revokeObjectURL(url);
      latencies.sort((a, b) => a - b);
      const pct = p => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null;
      const seconds = (end - measurementStart) / 1000;
      return { mode, metadata, measurementSeconds: seconds, calls, inferenceFps: calls / seconds, rafFps: render / seconds,
        inferenceMeanMs: latencies.reduce((a, b) => a + b, 0) / latencies.length, p50Ms: pct(.5), p95Ms: pct(.95),
        validFrames: valid, validRatio: valid / calls, duplicateChecks: duplicate, throttledChecks: throttled,
        observedVideoCallbacks: frameObservations, presentedFrameDelta: presentedEnd - presentedStart,
        longTaskCount: longTasks.length, longTaskMaxMs: Math.max(0, ...longTasks), browser: navigator.userAgent };
    }, mode);
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
