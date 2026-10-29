// Local-only Pose CPU probe. It prints aggregates, never video or landmark samples.
// Usage: node tracking-resolution-probe.cjs <local-video-path> [native|1280|640]
const { chromium } = require('playwright');

(async () => {
  const videoPath = process.argv[2];
  const mode = process.argv[3] || 'native';
  if (!videoPath || !['native', '1280', '640'].includes(mode)) throw new Error('Expected a video path and native, 1280 or 640.');
  const baseUrl = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173';
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.route(`${baseUrl}/__tracking_resolution_fixture__`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<input type="file" id="file"><video id="v" muted playsinline></video>' }));
    await page.goto(`${baseUrl}/__tracking_resolution_fixture__`);
    await page.locator('#file').setInputFiles(videoPath);
    const result = await page.evaluate(async mode => {
      const video = document.querySelector('#v');
      const url = URL.createObjectURL(document.querySelector('#file').files[0]);
      video.src = url;
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
      if (!Number.isFinite(video.duration) || video.duration <= 3) throw new Error('Video must be longer than the warm-up.');
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs');
      const { startVideoFrameScheduler } = await import('/src/features/workspace/videoFrameScheduler.ts');
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const pose = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 });
      const factor = mode === 'native' ? 1 : Math.min(1, Number(mode) / video.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(video.videoWidth * factor); canvas.height = Math.round(video.videoHeight * factor);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable');
      const infer = [], resize = [], total = [];
      let start = 0, end = 0, valid = 0, upperBodyValid = 0, count = 0, skipped = 0, rendered = 0, active = true;
      await video.play();
      const stop = startVideoFrameScheduler(video, ({ inferenceTimestamp }) => {
        const before = performance.now();
        if (mode !== 'native') ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const afterResize = performance.now();
        const result = pose.detectForVideo(mode === 'native' ? video : canvas, inferenceTimestamp);
        const endInference = performance.now();
        if (start) {
          count++; resize.push(afterResize - before); infer.push(endInference - afterResize); total.push(endInference - before);
          const points = result.landmarks[0];
          if (points?.length) valid++;
          if ([11, 12, 13, 14, 15, 16].every(index => points?.[index] && (points[index].visibility ?? 1) >= .4)) upperBodyValid++;
        }
      }, { maxFps: 24, onSkip: () => { if (start) skipped++; } });
      await new Promise(resolve => {
        const tick = now => {
          if (video.ended) { end = performance.now(); active = false; resolve(); return; }
          if (video.currentTime >= 3 && !start) start = now;
          if (start) rendered++;
          if (active) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      stop(); pose.close(); video.pause(); URL.revokeObjectURL(url);
      const stats = list => {
        const sorted = [...list].sort((a, b) => a - b);
        return { mean: sorted.length ? sorted.reduce((sum, x) => sum + x, 0) / sorted.length : null,
          p50: sorted.length ? sorted[Math.ceil(sorted.length * .5) - 1] : null,
          p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
      };
      const seconds = (end - start) / 1000;
      return { mode, video: { width: video.videoWidth, height: video.videoHeight, duration: video.duration }, inferenceResolution: { width: canvas.width, height: canvas.height },
        measurementSeconds: seconds, count, inferenceFps: count / seconds, renderRafFps: rendered / seconds,
        inferenceMs: stats(infer), resizeMs: stats(resize), combinedMs: stats(total), poseFraction: count ? valid / count : null,
        allUpperLimbVisibleFraction: count ? upperBodyValid / count : null, skippedCallbacks: skipped, browser: navigator.userAgent };
    }, mode);
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
