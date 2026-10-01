/**
 * MediaPipe detection + drawing logic served as a real JS module from the hub.
 *
 * WHY this file exists here instead of in the inline HTML:
 *   iOS WKWebView blocks dynamic import() from null-origin pages (inline HTML).
 *   By loading this as <script type="module" src="http://HUB/rn-mediapipe.js">,
 *   the module runs with the hub's origin (http://HUB_IP:8000) and can freely
 *   import from CDN. Camera getUserMedia still works because the inline HTML
 *   page uses baseUrl: 'https://localhost' which is a secure origin.
 *
 * Communication:
 *   → Sends: landmarks, tap, camera_ready, camera_error,
 *            mediapipe_loading, mediapipe_ready, mediapipe_error
 *   ← Receives: start_detection, set_depth
 */

import { PoseLandmarker, FilesetResolver }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function post(obj) {
  try { window.ReactNativeWebView?.postMessage(JSON.stringify(obj)); } catch(e) {}
}
function setStatus(msg, color) {
  const el = document.getElementById('status');
  if (el) { el.textContent = msg; el.style.color = color || '#bafa59'; }
}

// ── State ─────────────────────────────────────────────────────────────────────
let landmarker   = null;
let detecting    = false;
let target       = { x: 0.5, y: 0.5 };
let screenJoints = [];
let depth        = 2.0;

const JOINTS = [
  ['nose',0],['left_shoulder',11],['right_shoulder',12],
  ['left_hip',23],['right_hip',24],['left_ankle',27],['right_ankle',28],
];
const LINKS = [
  ['nose','left_shoulder'],['nose','right_shoulder'],
  ['left_shoulder','right_shoulder'],['left_shoulder','left_hip'],
  ['right_shoulder','right_hip'],['left_hip','right_hip'],
  ['left_hip','left_ankle'],['right_hip','right_ankle'],
];

// ── DOM (elements created by inline HTML) ─────────────────────────────────────
const video  = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

// ── Camera ────────────────────────────────────────────────────────────────────
async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => {
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;
    });
    await video.play();
    setStatus('Camera ready — tap Enable Detection');
    post({ type: 'camera_ready' });
    renderLoop();
  } catch(e) {
    setStatus('Camera error: ' + e.message, '#ff4d4d');
    post({ type: 'camera_error', message: e.message });
  }
}

// ── MediaPipe ─────────────────────────────────────────────────────────────────
async function initMediaPipe() {
  setStatus('Loading pose model…');
  post({ type: 'mediapipe_loading' });
  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
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
  } catch(e) {
    const msg = String(e).slice(0, 160);
    setStatus('Model error: ' + msg, '#ff4d4d');
    post({ type: 'mediapipe_error', message: msg });
  }
}

// ── Loops ─────────────────────────────────────────────────────────────────────
function detectLoop() {
  if (!detecting || !landmarker) return;
  if (video.readyState < 2) { requestAnimationFrame(detectLoop); return; }
  const result = landmarker.detectForVideo(video, performance.now());
  const pts    = result.landmarks?.[0];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (pts) {
    screenJoints = JOINTS.map(([name, idx]) => ({
      name, x: pts[idx].x, y: pts[idx].y, confidence: pts[idx].visibility ?? 0.8,
    })).filter(j => j.confidence > 0.35);
    const lh = pts[23], rh = pts[24];
    if (lh && rh) target = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
    drawSkeleton();
    post({ type: 'landmarks', joints: screenJoints, target, depth });
  } else {
    screenJoints = [];
    drawReticle();
  }
  requestAnimationFrame(detectLoop);
}

function renderLoop() {
  if (detecting) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawReticle();
  requestAnimationFrame(renderLoop);
}

// ── Drawing ───────────────────────────────────────────────────────────────────
function drawSkeleton() {
  const m = Object.fromEntries(screenJoints.map(j => [j.name, j]));
  ctx.strokeStyle = '#bafa59'; ctx.lineWidth = 3;
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
  ctx.strokeStyle = '#bafa59'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y);
  ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10);
  ctx.stroke();
  ctx.fillStyle = '#bafa59'; ctx.font = '13px monospace';
  ctx.fillText(depth.toFixed(1) + ' m', x + 32, y + 5);
}

// ── Tap ───────────────────────────────────────────────────────────────────────
canvas.addEventListener('click', e => {
  const r = canvas.getBoundingClientRect();
  target = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  post({ type: 'tap', x: target.x, y: target.y });
  if (!detecting) { ctx.clearRect(0, 0, canvas.width, canvas.height); drawReticle(); }
});

// ── RN → WebView messages ─────────────────────────────────────────────────────
window.addEventListener('message', e => {
  try {
    const msg = JSON.parse(e.data);
    if (msg.type === 'start_detection') initMediaPipe();
    if (msg.type === 'set_depth') { depth = msg.value; }
  } catch(_) {}
});

// ── Boot ──────────────────────────────────────────────────────────────────────
initCamera();
