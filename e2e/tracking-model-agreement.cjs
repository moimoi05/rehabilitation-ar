// Local-only paired model probe. Outputs aggregate counts/timing, never frames or landmarks.
// node tracking-model-agreement.cjs <local-video> <local-full-model>
const { chromium } = require('playwright');
const fs = require('node:fs');

(async () => {
  const [videoPath, fullModelPath] = process.argv.slice(2);
  if (!videoPath || !fullModelPath) throw new Error('Provide local video and Full model paths.');
  const baseUrl = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173';
  const fullModel = fs.readFileSync(fullModelPath);
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url === `${baseUrl}/__model_fixture__`) return route.fulfill({ contentType: 'text/html', body: '<input type="file" id="file"><video id="v" muted playsinline></video>' });
      if (url === `${baseUrl}/__pose_full__`) return route.fulfill({ contentType: 'application/octet-stream', body: fullModel });
      if (url.startsWith(`${baseUrl}/`) || url.startsWith('blob:')) return route.continue();
      return route.abort();
    });
    await page.goto(`${baseUrl}/__model_fixture__`);
    await page.locator('#file').setInputFiles(videoPath);
    const result = await page.evaluate(async () => {
      const video = document.querySelector('#v'), objectUrl = URL.createObjectURL(document.querySelector('#file').files[0]);
      video.src = objectUrl;
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs');
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const make = modelAssetPath => PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath, delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 });
      const models = { lite: await make('/models/pose_landmarker_lite.task'), full: await make('/__pose_full__') };
      const joints = [['shoulderL',11], ['shoulderR',12], ['elbowL',13], ['elbowR',14], ['wristL',15], ['wristR',16]];
      const counts = Object.fromEntries(joints.map(([name]) => [name, { liteEligible: 0, fullEligible: 0, both: 0, liteOnly: 0, fullOnly: 0, neither: 0, distance: [] }]));
      const timings = { lite: [], full: [] }, poses = { lite: 0, full: 0 };
      const eligible = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && (p.visibility ?? 0) >= .4;
      let samples = 0, ordinal = 0;
      for (let time = .5; time < video.duration - .25; time += .5) {
        const seek = new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject; });
        video.currentTime = time; await seek;
        const output = {};
        const order = ordinal++ % 2 ? ['full', 'lite'] : ['lite', 'full'];
        for (const name of order) {
          const before = performance.now();
          output[name] = models[name].detectForVideo(video, time * 1000).landmarks[0];
          if (time >= 3) timings[name].push(performance.now() - before);
        }
        if (time < 3) continue;
        samples++;
        for (const name of ['lite', 'full']) if (output[name]?.length) poses[name]++;
        for (const [name,index] of joints) {
          const entry = counts[name], a = output.lite?.[index], b = output.full?.[index];
          const av = Boolean(eligible(a)), bv = Boolean(eligible(b));
          if (av) entry.liteEligible++;
          if (bv) entry.fullEligible++;
          if (av && bv) { entry.both++; entry.distance.push(Math.hypot(a.x-b.x, a.y-b.y)); }
          else if (av) entry.liteOnly++;
          else if (bv) entry.fullOnly++;
          else entry.neither++;
        }
      }
      for (const model of Object.values(models)) model.close();
      URL.revokeObjectURL(objectUrl);
      const stats = values => {
        const sorted = [...values].sort((a,b) => a-b);
        return { mean: sorted.length ? sorted.reduce((sum,x) => sum+x,0)/sorted.length : null,
          p95: sorted.length ? sorted[Math.ceil(.95*sorted.length)-1] : null };
      };
      const summary = Object.fromEntries(Object.entries(counts).map(([name,{distance,...rest}]) => [name,{...rest, distance: stats(distance), overPoint05: distance.filter(x => x > .05).length}]));
      return { video: { width: video.videoWidth, height: video.videoHeight, duration: video.duration }, samples, poses,
        timingMs: { lite: stats(timings.lite), full: stats(timings.full) }, joints: summary, userAgent: navigator.userAgent };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
