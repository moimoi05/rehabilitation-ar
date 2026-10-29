// Local-only analysis: all observations are held in browser memory and only aggregate metrics are printed.
// Usage: node tracking-filter-sweep.cjs <local-video-path>
const { chromium } = require('playwright');
(async () => {
  const videoPath = process.argv[2];
  if (!videoPath) throw new Error('Usage: node tracking-filter-sweep.cjs <local-video-path>');
  const baseUrl = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173';
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.route(`${baseUrl}/__tracking_filter_fixture__`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<input type="file" id="file"><video id="v" muted playsinline></video>' }));
    await page.goto(`${baseUrl}/__tracking_filter_fixture__`);
    await page.locator('#file').setInputFiles(videoPath);
    const result = await page.evaluate(async () => {
      const v = document.querySelector('#v');
      const url = URL.createObjectURL(document.querySelector('#file').files[0]);
      v.src = url;
      await new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = reject; });
      if (!Number.isFinite(v.duration) || v.duration <= 5) throw new Error('Video must be longer than five seconds.');
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs');
      const { LandmarkSmoother, DEFAULT_SMOOTHING_CONFIG, POSE_SMOOTHING_POLICY, SMOOTHING_VERSION } = await import('/src/features/workspace/landmarkSmoothing.ts');
      const { startVideoFrameScheduler } = await import('/src/features/workspace/videoFrameScheduler.ts');
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const pose = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 });
      const configs = { default: { minCutoff: 1, beta: .5 }, strong: { minCutoff: .5, beta: .5 }, responsive: { minCutoff: 1, beta: 2 }, light: { minCutoff: 2, beta: .5 } };
      const smoothers = Object.fromEntries(Object.entries(configs).map(([key, config]) => [key, new LandmarkSmoother(config)]));
      const ema = new Map(), samples = [], tauMs = 100, resetAfterMs = 500;
      let active = true, missing = 0, total = 0;
      await v.play();
      const stop = startVideoFrameScheduler(v, ({ now, mediaTime, inferenceTimestamp }) => {
        const landmarks = pose.detectForVideo(v, inferenceTimestamp).landmarks[0] || [];
        const filtered = Object.fromEntries(Object.entries(smoothers).map(([key, smoother]) => [key, smoother.filter('pose', landmarks, now, POSE_SMOOTHING_POLICY)]));
        total++;
        let any = false;
        for (const [side, index] of [['left', 15], ['right', 16]]) {
          const point = landmarks[index];
          if (!point || (point.visibility ?? 1) < .5 || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) { ema.delete(side); continue; }
          any = true;
          const prior = ema.get(side), dt = prior ? now - prior.time : 0;
          const alpha = prior && dt > 0 && dt <= resetAfterMs ? 1 - Math.exp(-dt / tauMs) : 1;
          const e = { x: prior && alpha < 1 ? prior.x + alpha * (point.x - prior.x) : point.x,
            y: prior && alpha < 1 ? prior.y + alpha * (point.y - prior.y) : point.y, time: now };
          ema.set(side, e);
          samples.push({ side, mediaTime, time: now, raw: { x: point.x, y: point.y }, ema: { x: e.x, y: e.y }, ...Object.fromEntries(Object.keys(configs).map(key => [key, { x: filtered[key][index].x, y: filtered[key][index].y }])) });
        }
        if (!any) missing++;
      }, { maxFps: 24 });
      await new Promise(resolve => {
        const tick = () => { if (v.ended || !active) resolve(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      active = false; stop(); pose.close(); v.pause(); URL.revokeObjectURL(url);
      const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const std = (items, key) => {
        const x = items.reduce((sum, p) => sum + p[key].x, 0) / items.length;
        const y = items.reduce((sum, p) => sum + p[key].y, 0) / items.length;
        return Math.sqrt(items.reduce((sum, p) => sum + (p[key].x - x) ** 2 + (p[key].y - y) ** 2, 0) / items.length);
      };
      const diameter = items => Math.max(...items.map(a => Math.max(...items.map(b => distance(a.raw, b.raw)))));
      const windows = [];
      for (const side of ['left', 'right']) {
        const track = samples.filter(p => p.side === side && p.mediaTime >= 1);
        for (let i = 0; i < track.length; i++) {
          const items = track.filter(p => p.mediaTime >= track[i].mediaTime && p.mediaTime <= track[i].mediaTime + 2);
          // Require close to the full window and no large missing-sample gap.
          if (items.length < 10 || items.at(-1).mediaTime - items[0].mediaTime < 1.8 || items.some((p, j) => j && p.time - items[j - 1].time > 500)) continue;
          windows.push({ side, items, dispersion: std(items, 'raw'), diameter: diameter(items) });
        }
      }
      const quiet = windows.filter(w => w.dispersion <= .015 && w.diameter <= .04).sort((a, b) => a.dispersion - b.dispersion)[0];
      const motion = windows.filter(w => w.diameter >= .06 && w.diameter <= .4).sort((a, b) => b.diameter - a.diameter)[0];
      const summarize = (window, withLag) => {
        if (!window) return null;
        const { items } = window;
        const info = { side: window.side, startSeconds: items[0].mediaTime, endSeconds: items.at(-1).mediaTime, observations: items.length,
          rawDiameter: window.diameter, positionDispersion: { raw: std(items, 'raw'), ema: std(items, 'ema'), ...Object.fromEntries(Object.keys(configs).map(key => [key, std(items, key)])) } };
        if (!withLag) return info;
        // Compare filter at t+shift to raw at t. Equal sample subset for all shifts.
        const base = items.filter(p => p.time <= items.at(-1).time - 500);
        const interpolate = (t, key) => {
          const j = items.findIndex(p => p.time >= t);
          if (j <= 0) return j === 0 ? items[0][key] : null;
          const before = items[j - 1], after = items[j], f = (t - before.time) / (after.time - before.time);
          return { x: before[key].x + f * (after[key].x - before[key].x), y: before[key].y + f * (after[key].y - before[key].y) };
        };
        const compare = key => {
          const scores = [];
          for (let shift = 0; shift <= 500; shift += 10) {
            const squared = base.map(p => { const value = interpolate(p.time + shift, key); return value ? distance(p.raw, value) ** 2 : NaN; });
            if (squared.length >= 5 && squared.every(Number.isFinite)) scores.push({ shiftMs: shift, rmsDistance: Math.sqrt(squared.reduce((a, b) => a + b, 0) / squared.length) });
          }
          if (!scores.length) return null;
          return { rmsAtZeroShift: scores[0].rmsDistance, bestShiftMs: scores.reduce((best, item) => item.rmsDistance < best.rmsDistance ? item : best).shiftMs };
        };
        info.relativeMotion = { ema: compare('ema'), ...Object.fromEntries(Object.keys(configs).map(key => [key, compare(key)])) };
        return info;
      };
      return { metadata: { durationSeconds: v.duration, width: v.videoWidth, height: v.videoHeight }, totalInferences: total, neitherWristVisible: missing,
        configs: { emaTauMs: tauMs, defaults: DEFAULT_SMOOTHING_CONFIG, alternatives: configs, oneEuroVersion: SMOOTHING_VERSION }, quietCandidate: summarize(quiet, false), motionCandidate: summarize(motion, true),
        selection: '2 second windows after first second; >=10 visible observations, no >500 ms gap. Low-motion: raw dispersion <=0.015 and diameter <=0.04 normalized; motion: diameter 0.06..0.4. Lowest dispersion / largest diameter selected.',
        limits: 'No ground truth; all candidate parameters are exploratory, low-motion may include real movement. Shift is alignment against raw estimates, not physical or clinical latency. Normalized x and y treated equally despite frame aspect ratio.' };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
