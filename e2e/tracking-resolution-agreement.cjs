// Local-only agreement probe; prints aggregate landmark differences, never landmarks or video.
// Independent Pose VIDEO models process exactly the same paused, sought frames.
// Usage: node tracking-resolution-agreement.cjs <local-video-path>
const { chromium } = require('playwright');

(async () => {
  const videoPath = process.argv[2];
  if (!videoPath) throw new Error('Expected a local video path.');
  const baseUrl = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173';
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage();
    await page.route(`${baseUrl}/__tracking_agreement_fixture__`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<input type="file" id="file"><video id="v" muted playsinline></video>' }));
    await page.goto(`${baseUrl}/__tracking_agreement_fixture__`);
    await page.locator('#file').setInputFiles(videoPath);
    const result = await page.evaluate(async () => {
      const video = document.querySelector('#v');
      const url = URL.createObjectURL(document.querySelector('#file').files[0]);
      video.src = url;
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs');
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const makeModel = () => PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 });
      const models = { native: await makeModel(), 1280: await makeModel(), 640: await makeModel() };
      const canvases = {};
      for (const width of [1280, 640]) {
        const factor = Math.min(1, width / video.videoWidth), canvas = document.createElement('canvas');
        canvas.width = Math.round(video.videoWidth * factor); canvas.height = Math.round(video.videoHeight * factor);
        canvases[width] = canvas;
      }
      const joints = [['leftShoulder', 11], ['rightShoulder', 12], ['leftElbow', 13], ['rightElbow', 14], ['leftWrist', 15], ['rightWrist', 16]];
      const makeCounter = () => Object.fromEntries(joints.map(([name]) => [name, { referenceValid: 0, comparisonValid: 0, bothValid: 0, referenceOnly: 0, comparisonOnly: 0, neitherValid: 0, distance: [] }]));
      const counters = { 1280: makeCounter(), 640: makeCounter() };
      let samples = 0;
      const valid = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && (point.visibility ?? 1) >= .4;
      for (let time = .5; time < video.duration - .25; time += .5) {
        const seeked = new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject; });
        video.currentTime = time;
        await seeked;
        const timestamp = time * 1000;
        const reference = models.native.detectForVideo(video, timestamp).landmarks[0];
        const output = {};
        for (const width of [1280, 640]) {
          const canvas = canvases[width], context = canvas.getContext('2d');
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          output[width] = models[width].detectForVideo(canvas, timestamp).landmarks[0];
        }
        if (time < 3) continue; // identical warm-up sample times for all three trackers
        samples++;
        for (const width of [1280, 640]) for (const [name, index] of joints) {
          const entry = counters[width][name], a = reference?.[index], b = output[width]?.[index], av = Boolean(valid(a)), bv = Boolean(valid(b));
          if (av) entry.referenceValid++;
          if (bv) entry.comparisonValid++;
          if (av && bv) { entry.bothValid++; entry.distance.push(Math.hypot(a.x - b.x, a.y - b.y)); }
          else if (av) entry.referenceOnly++;
          else if (bv) entry.comparisonOnly++;
          else entry.neitherValid++;
        }
      }
      for (const model of Object.values(models)) model.close();
      video.pause(); URL.revokeObjectURL(url);
      const summary = {};
      for (const width of [1280, 640]) {
        summary[width] = {};
        for (const [name] of joints) {
          const { distance, ...counts } = counters[width][name];
          distance.sort((a, b) => a - b);
          summary[width][name] = { ...counts, meanDistance: distance.length ? distance.reduce((sum, value) => sum + value, 0) / distance.length : null,
            p95Distance: distance.length ? distance[Math.ceil(distance.length * .95) - 1] : null,
            countOverPoint05: distance.filter(value => value > .05).length };
        }
      }
      return { video: { width: video.videoWidth, height: video.videoHeight, duration: video.duration }, samples, sampleIntervalSeconds: .5,
        visibilityThreshold: .4, summary,
        limits: 'Independent trackers at 2 Hz with seeked frames; x and y normalized equally. Agreement with native is not ground-truth accuracy, clinical validity, or tracking lag.' };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
