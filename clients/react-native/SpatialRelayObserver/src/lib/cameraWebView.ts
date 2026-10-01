/**
 * Self-contained Camera + MediaPipe HTML for the React Native WebView.
 *
 * Runs inside WebView with baseUrl: 'https://localhost'.
 * All external resources (MediaPipe JS, WASM, Model) are loaded via HTTPS,
 * ensuring no mixed-content blocks and full getUserMedia camera access on iOS.
 */
export const CAMERA_VIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Camera Observer</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body {
      width:100%; height:100%;
      background:#000; overflow:hidden;
      font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      color:#fff;
    }
    #video {
      position:absolute; top:0; left:0;
      width:100%; height:100%;
      object-fit:cover;
    }
    #canvas {
      position:absolute; top:0; left:0;
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
      if (statusEl) {
        statusEl.textContent = msg;
        statusEl.style.color = color || '#bafa59';
      }
    }

    // ── State ───────────────────────────────────────────────────────────────
    let visionModule = null;
    let landmarker = null;
    let detecting = false;
    let target = { x: 0.5, y: 0.5 };
    let screenJoints = [];
    let depth = 2.0;

    const JOINTS = [
      ['nose', 0],
      ['left_shoulder', 11], ['right_shoulder', 12],
      ['left_hip', 23], ['right_hip', 24],
      ['left_ankle', 27], ['right_ankle', 28],
    ];

    const LINKS = [
      ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
      ['left_shoulder', 'right_shoulder'],
      ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
      ['left_hip', 'right_hip'],
      ['left_hip', 'left_ankle'], ['right_hip', 'right_ankle'],
    ];

    // ── Camera initialization ───────────────────────────────────────────────
    async function initCamera() {
      setStatus('Requesting camera permission…');
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('navigator.mediaDevices.getUserMedia is unavailable');
        }

        const constraints = {
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;

        video.addEventListener('loadedmetadata', () => {
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
        });

        await video.play();
        setStatus('Camera ready — tap Enable Detection');
        post({ type: 'camera_ready' });
        renderLoop();
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        setStatus('Camera error: ' + msg, '#ff4d4d');
        post({ type: 'camera_error', message: msg });
        renderLoop();
      }
    }

    // ── MediaPipe initialization ────────────────────────────────────────────
    async function initMediaPipe() {
      setStatus('Loading MediaPipe module…', '#f4b942');
      post({ type: 'mediapipe_loading' });

      try {
        // NOTE: The URL must NOT have /index.js — jsdelivr serves the ES module at package root
        if (!visionModule) {
          visionModule = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
        }

        setStatus('Loading wasm runtime…', '#f4b942');
        const { PoseLandmarker, FilesetResolver } = visionModule;

        const files = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        );

        setStatus('Loading pose model (5MB)…', '#f4b942');
        landmarker = await PoseLandmarker.createFromOptions(files, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        detecting = true;
        setStatus('Detection active', '#bafa59');
        post({ type: 'mediapipe_ready' });
        detectLoop();
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        setStatus('ML error: ' + msg, '#ff4d4d');
        post({ type: 'mediapipe_error', message: msg });
      }
    }

    // ── Detection & Render Loops ────────────────────────────────────────────
    function detectLoop() {
      if (!detecting || !landmarker) return;

      if (video.readyState >= 2) {
        try {
          const result = landmarker.detectForVideo(video, performance.now());
          const pts = result.landmarks?.[0];

          ctx.clearRect(0, 0, canvas.width, canvas.height);

          if (pts) {
            screenJoints = JOINTS.map(([name, idx]) => ({
              name,
              x: pts[idx].x,
              y: pts[idx].y,
              confidence: pts[idx].visibility ?? 0.8,
            })).filter(j => j.confidence > 0.35);

            const lh = pts[23], rh = pts[24];
            if (lh && rh) {
              target = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
            }

            drawSkeleton();
            post({
              type: 'landmarks',
              joints: screenJoints,
              target,
              depth,
            });
          } else {
            screenJoints = [];
            drawReticle();
          }
        } catch (e) {}
      }

      requestAnimationFrame(detectLoop);
    }

    function renderLoop() {
      if (detecting) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawReticle();
      requestAnimationFrame(renderLoop);
    }

    // ── Visual Drawing ──────────────────────────────────────────────────────
    function drawSkeleton() {
      const m = Object.fromEntries(screenJoints.map(j => [j.name, j]));
      ctx.strokeStyle = '#bafa59';
      ctx.lineWidth = 3;

      LINKS.forEach(([a, b]) => {
        if (!m[a] || !m[b]) return;
        ctx.beginPath();
        ctx.moveTo(m[a].x * canvas.width, m[a].y * canvas.height);
        ctx.lineTo(m[b].x * canvas.width, m[b].y * canvas.height);
        ctx.stroke();
      });

      screenJoints.forEach(j => {
        ctx.fillStyle = '#bafa59';
        ctx.beginPath();
        ctx.arc(j.x * canvas.width, j.y * canvas.height, 5, 0, Math.PI * 2);
        ctx.fill();
      });

      drawReticle();
    }

    function drawReticle() {
      const x = target.x * canvas.width;
      const y = target.y * canvas.height;
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
      target = {
        x: (e.clientX - r.left) / r.width,
        y: (e.clientY - r.top) / r.height,
      };
      post({ type: 'tap', x: target.x, y: target.y });
      if (!detecting) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawReticle();
      }
    });

    // ── Listen to React Native messages ─────────────────────────────────────
    window.addEventListener('message', e => {
      try {
        const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (msg.type === 'start_detection') {
          initMediaPipe();
        } else if (msg.type === 'set_depth') {
          depth = msg.value;
          if (!detecting) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            drawReticle();
          }
        }
      } catch (err) {}
    });

    // ── Boot ────────────────────────────────────────────────────────────────
    initCamera();
  </script>
</body>
</html>`;
