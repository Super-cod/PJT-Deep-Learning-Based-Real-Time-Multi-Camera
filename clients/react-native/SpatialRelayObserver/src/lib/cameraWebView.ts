/**
 * Self-contained Camera + MediaPipe HTML for the React Native WebView.
 *
 * Runs inside WebView with baseUrl: 'https://localhost' so the page is a secure
 * context (required for getUserMedia in WKWebView). MediaPipe JS, WASM and the
 * model are fetched over HTTPS from public CDNs on first use.
 *
 * Coordinates sent to React Native are normalised to the *camera frame*
 * (0–1, origin top-left), not to the on-screen view, because the video is
 * displayed with object-fit: cover and may be cropped.
 */
export const MEDIAPIPE_VERSION = '0.10.14';

export const CAMERA_VIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Camera Observer</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body {
      width:100%; height:100%;
      background:#000; overflow:hidden;
      font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      color:#fff;
      -webkit-user-select:none; user-select:none;
      -webkit-touch-callout:none;
    }
    #video {
      position:absolute; inset:0;
      width:100%; height:100%;
      object-fit:cover;
    }
    #canvas {
      position:absolute; inset:0;
      width:100%; height:100%;
    }
    #status {
      position:absolute; bottom:14px; left:50%;
      transform:translateX(-50%);
      background:rgba(10,10,10,0.85);
      color:#bafa59;
      border:1px solid rgba(186,250,89,0.3);
      padding:6px 16px;
      border-radius:18px;
      font-size:12px;
      pointer-events:none;
      white-space:nowrap;
      max-width:92vw;
      overflow:hidden;
      text-overflow:ellipsis;
      text-align:center;
      z-index:10;
    }
  </style>
</head>
<body>
  <video id="video" autoplay playsinline muted></video>
  <canvas id="canvas"></canvas>
  <div id="status">Starting camera…</div>

  <script type="module">
    const MP_VERSION = '${MEDIAPIPE_VERSION}';
    const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MP_VERSION;
    const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
    const POST_INTERVAL_MS = 50; // ≤ 20 detection packets per second
    const MAX_PEOPLE = 4;
    const COLORS = ['#bafa59', '#55dfcf', '#ff8452', '#c792ea'];

    // ── Elements & PostMessage ──────────────────────────────────────────────
    const video = document.getElementById('video');
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('status');

    function post(obj) {
      try {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify(obj));
        }
      } catch (err) {}
    }

    function setStatus(msg, color) {
      statusEl.textContent = msg;
      statusEl.style.color = color || '#bafa59';
    }

    // Surface unexpected script errors to React Native instead of failing silently.
    window.addEventListener('error', e => post({ type: 'log', message: 'JS error: ' + e.message }));
    window.addEventListener('unhandledrejection', e => post({ type: 'log', message: 'Unhandled: ' + (e.reason && e.reason.message || e.reason) }));

    // ── State ───────────────────────────────────────────────────────────────
    let visionModule = null;
    let landmarker = null;
    let loadingModel = false;
    let detecting = false;
    let target = { x: 0.5, y: 0.5 }; // camera-frame normalised (tap / reticle)
    let skeletons = []; // one joint list per detected person
    let depth = 2.0;
    let lastVideoTime = -1;
    let lastPost = 0;
    let cameraStarting = false;

    const JOINTS = [
      ['nose', 0],
      ['left_shoulder', 11], ['right_shoulder', 12],
      ['left_elbow', 13], ['right_elbow', 14],
      ['left_wrist', 15], ['right_wrist', 16],
      ['left_hip', 23], ['right_hip', 24],
      ['left_knee', 25], ['right_knee', 26],
      ['left_ankle', 27], ['right_ankle', 28],
    ];

    const LINKS = [
      ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
      ['left_shoulder', 'right_shoulder'],
      ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
      ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
      ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
      ['left_hip', 'right_hip'],
      ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
      ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
    ];

    // ── View ↔ camera-frame mapping (object-fit: cover) ─────────────────────
    function coverTransform() {
      const vw = video.videoWidth || 9, vh = video.videoHeight || 16;
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      const scale = Math.max(cw / vw, ch / vh);
      const dw = vw * scale, dh = vh * scale;
      return { ox: (cw - dw) / 2, oy: (ch - dh) / 2, dw, dh };
    }
    function toView(nx, ny) {
      const t = coverTransform();
      return [t.ox + nx * t.dw, t.oy + ny * t.dh];
    }
    function toFrame(px, py) {
      const t = coverTransform();
      return { x: (px - t.ox) / t.dw, y: (py - t.oy) / t.dh };
    }

    function resizeCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener('resize', resizeCanvas);

    // ── Camera initialization ───────────────────────────────────────────────
    async function initCamera() {
      if (cameraStarting) return;
      cameraStarting = true;
      setStatus('Requesting camera…');
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('getUserMedia unavailable (iOS 14.3+ required)');
        }
        if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        video.srcObject = stream;
        // iOS stops the track when the app is backgrounded — restart on return.
        stream.getVideoTracks().forEach(track => {
          track.addEventListener('ended', () => setTimeout(initCamera, 500));
        });

        await video.play();
        resizeCanvas();
        setStatus(detecting ? 'Detection active' : 'Camera ready — tap Enable Detection');
        post({ type: 'camera_ready', width: video.videoWidth, height: video.videoHeight });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        setStatus('Camera error: ' + msg, '#ff4d4d');
        post({ type: 'camera_error', message: msg });
      } finally {
        cameraStarting = false;
      }
    }

    // ── MediaPipe initialization ────────────────────────────────────────────
    async function createLandmarker(files, delegate) {
      return visionModule.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numPoses: MAX_PEOPLE,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }

    async function initMediaPipe() {
      if (detecting || loadingModel) return;
      loadingModel = true;
      setStatus('Loading MediaPipe module…', '#f4b942');
      post({ type: 'mediapipe_loading' });

      try {
        if (!visionModule) {
          // jsdelivr serves the ES module bundle at the package root.
          visionModule = await import(MP_BASE);
        }
        setStatus('Loading wasm runtime…', '#f4b942');
        const files = await visionModule.FilesetResolver.forVisionTasks(MP_BASE + '/wasm');

        setStatus('Loading pose model…', '#f4b942');
        try {
          landmarker = await createLandmarker(files, 'GPU');
        } catch (gpuErr) {
          // WKWebView WebGL can be unavailable (low power mode, older iOS) — fall back to CPU.
          post({ type: 'log', message: 'GPU delegate failed, using CPU: ' + (gpuErr && gpuErr.message) });
          landmarker = await createLandmarker(files, 'CPU');
        }

        detecting = true;
        setStatus('Detection active', '#bafa59');
        post({ type: 'mediapipe_ready' });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        setStatus('ML error: ' + msg, '#ff4d4d');
        post({ type: 'mediapipe_error', message: msg });
      } finally {
        loadingModel = false;
      }
    }

    // ── Detection ───────────────────────────────────────────────────────────
    function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }; }

    // One detected pose → joints in camera-frame coords, hip-centre target, torso size.
    function describePerson(pts, world) {
      const joints = JOINTS.map(([name, idx]) => ({
        name,
        x: pts[idx].x,
        y: pts[idx].y,
        confidence: pts[idx].visibility ?? 0.8,
      })).filter(j => j.confidence > 0.35);

      const lh = pts[23], rh = pts[24];
      const hip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };

      // Torso length (shoulder-mid → hip-mid): metric from world landmarks,
      // pixels from image landmarks. RN turns this into a depth estimate.
      let torso = null;
      if (world) {
        const ws = mid(world[11], world[12]), wh = mid(world[23], world[24]);
        const is = mid(pts[11], pts[12]), ih = mid(pts[23], pts[24]);
        const metres = Math.hypot(ws.x - wh.x, ws.y - wh.y, ws.z - wh.z);
        const pixels = Math.hypot((is.x - ih.x) * video.videoWidth, (is.y - ih.y) * video.videoHeight);
        const vis = Math.min(pts[11].visibility, pts[12].visibility, pts[23].visibility, pts[24].visibility);
        if (metres > 0.2 && pixels > 10 && vis > 0.5) torso = { metres, pixels };
      }
      return { joints, target: hip, torso };
    }

    function detect() {
      if (!detecting || !landmarker || video.readyState < 2) return;
      if (video.currentTime === lastVideoTime) return; // no new frame
      lastVideoTime = video.currentTime;

      let result;
      try {
        result = landmarker.detectForVideo(video, performance.now());
      } catch (e) {
        return;
      }
      const poses = result.landmarks || [];
      const worlds = result.worldLandmarks || [];
      const people = poses.map((pts, i) => describePerson(pts, worlds[i]));
      skeletons = people.map(p => p.joints);
      if (people.length) target = people[0].target;

      const now = performance.now();
      if (now - lastPost >= POST_INTERVAL_MS) {
        lastPost = now;
        // Posted even when empty so the hub drops people who left the frame.
        post({ type: 'people', people, width: video.videoWidth, height: video.videoHeight });
      }
    }

    // ── Render loop (always running) ────────────────────────────────────────
    function frame() {
      detect();
      resizeCanvas();
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      skeletons.forEach((joints, i) => drawSkeleton(joints, COLORS[i % COLORS.length]));
      if (!skeletons.length) drawReticle();
      requestAnimationFrame(frame);
    }

    // ── Visual Drawing ──────────────────────────────────────────────────────
    function drawSkeleton(joints, color) {
      const m = Object.fromEntries(joints.map(j => [j.name, toView(j.x, j.y)]));
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      LINKS.forEach(([a, b]) => {
        if (!m[a] || !m[b]) return;
        ctx.beginPath();
        ctx.moveTo(m[a][0], m[a][1]);
        ctx.lineTo(m[b][0], m[b][1]);
        ctx.stroke();
      });
      ctx.fillStyle = color;
      Object.values(m).forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    function drawReticle() {
      const [x, y] = toView(target.x, target.y);
      ctx.strokeStyle = '#bafa59';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10);
      ctx.stroke();
      ctx.fillStyle = '#bafa59';
      ctx.font = '13px monospace';
      ctx.fillText(depth.toFixed(1) + ' m', x + 32, y + 5);
    }

    // ── Tap to set manual target ────────────────────────────────────────────
    canvas.addEventListener('click', e => {
      const r = canvas.getBoundingClientRect();
      const p = toFrame(e.clientX - r.left, e.clientY - r.top);
      target = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
      post({ type: 'tap', x: target.x, y: target.y, width: video.videoWidth, height: video.videoHeight });
    });

    // ── Messages from React Native ──────────────────────────────────────────
    // iOS dispatches on window, Android on document.
    function onRNMessage(e) {
      let msg;
      try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
      if (!msg) return;
      if (msg.type === 'start_detection') initMediaPipe();
      else if (msg.type === 'restart_camera') initCamera();
      else if (msg.type === 'set_depth' && Number.isFinite(msg.value)) depth = msg.value;
    }
    window.addEventListener('message', onRNMessage);
    document.addEventListener('message', onRNMessage);

    // ── Boot ────────────────────────────────────────────────────────────────
    initCamera();
    requestAnimationFrame(frame);
  </script>
</body>
</html>`;
