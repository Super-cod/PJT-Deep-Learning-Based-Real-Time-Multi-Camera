const $ = id => document.getElementById(id);
const video = $('camera'), canvas = $('reticle'), ctx = canvas.getContext('2d');

let socket = null;
let active = false;
let motionEnabled = false;
let yaw0 = null;
let lastAlpha = null;
let yawDeg = 0; // 0 = facing +Z forward, 90 = facing +X right, 180 = -Z, -90 = -X
let target = { x: 0.5, y: 0.5 };
let landmarker = null;
let detecting = false;
let screenJoints = [];

const pose = { x: 1.0, y: 0.0, z: 1.0 };
const wsURL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/observer`;

const JOINTS = [
  ['nose', 0],
  ['left_shoulder', 11],
  ['right_shoulder', 12],
  ['left_hip', 23],
  ['right_hip', 24],
  ['left_ankle', 27],
  ['right_ankle', 28]
];

const LINKS = [
  ['nose', 'left_shoulder'],
  ['nose', 'right_shoulder'],
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_ankle'],
  ['right_hip', 'right_ankle']
];

function fmt(n) {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
}

function send(packet) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(packet));
  }
}

function getYawRad() {
  return (yawDeg * Math.PI) / 180;
}

function posePacket() {
  const yawRad = getYawRad();
  return {
    position: [pose.x, pose.y, pose.z],
    quaternionXyzw: [0, Math.sin(yawRad / 2), 0, Math.cos(yawRad / 2)],
    timestampNs: Date.now() * 1e6
  };
}

// Camera-local point where +z is depth in front of the camera, +x is right, +y is up
function toPhonePoint(normX, normY, d) {
  const fov = Math.PI / 3; // 60 deg
  const x = (normX - 0.5) * 2 * d * Math.tan(fov / 2);
  const y = -(normY - 0.5) * 2 * d * Math.tan(fov / 2);
  const z = d; // depth in front is positive
  return [x, y, z];
}

// Transform phone-local vector [lx, ly, lz] into shared room world coordinates
function localToWorld(phoneX, phoneY, phoneZ, yawRad, lx, ly, lz) {
  const c = Math.cos(yawRad), s = Math.sin(yawRad);
  const wx = phoneX + (lx * c + lz * s);
  const wy = phoneY + ly;
  const wz = phoneZ + (-lx * s + lz * c);
  return [wx, wy, wz];
}

function updateTelemetry() {
  const yawRad = getYawRad();
  const d = Number($('range').value);
  const localPt = toPhonePoint(target.x, target.y, d);
  const worldPt = localToWorld(pose.x, pose.y, pose.z, yawRad, localPt[0], localPt[1], localPt[2]);

  $('phoneWorldDisplay').textContent = `X: ${fmt(pose.x)} · Z: ${fmt(pose.z)}`;
  $('phoneHeadingDisplay').textContent = `Facing: ${yawDeg.toFixed(0)}° (${getHeadingDesc(yawDeg)})`;

  $('targetWorldDisplay').textContent = `X: ${fmt(worldPt[0])} · Z: ${fmt(worldPt[2])}`;
  $('targetStatusDisplay').textContent = `In front of phone: ${d.toFixed(1)}m (local X:${fmt(localPt[0])}m)`;

  $('orientation').textContent = `${yawDeg.toFixed(0)}° (${getHeadingDesc(yawDeg)})`;
}

function getHeadingDesc(deg) {
  const norm = ((deg % 360) + 360) % 360;
  if (norm >= 337.5 || norm < 22.5) return '+Z Forward';
  if (norm >= 22.5 && norm < 67.5) return '+X/+Z (Forward-Right)';
  if (norm >= 67.5 && norm < 112.5) return '+X Right';
  if (norm >= 112.5 && norm < 157.5) return '+X/−Z (Back-Right)';
  if (norm >= 157.5 && norm < 202.5) return '−Z Back';
  if (norm >= 202.5 && norm < 247.5) return '−X/−Z (Back-Left)';
  if (norm >= 247.5 && norm < 292.5) return '−X Left';
  return '−X/+Z (Forward-Left)';
}

function sendPose() {
  updateTelemetry();
  const p = posePacket();
  send({
    type: 'manual_pose',
    sequence: Date.now(),
    position: [pose.x, pose.y, pose.z],
    yawRad: getYawRad(),
    yawDeg: yawDeg
  });
  send({
    type: 'pose',
    sequence: Date.now(),
    localPose: p
  });
  if (target) {
    sendDetection();
  }
}

function sendDetection() {
  const d = Number($('range').value);
  const point = toPhonePoint(target.x, target.y, d);
  const jointsPhone = screenJoints.map(j => ({
    name: j.name,
    position: toPhonePoint(j.x, j.y, d),
    confidence: j.confidence
  }));

  send({
    type: 'detection',
    sequence: Date.now(),
    subjectId: detecting ? 'person_01' : 'target_01',
    timestampNs: Date.now() * 1e6,
    positionPhone: point,
    jointsPhone,
    confidence: detecting ? 0.85 : 0.7
  });

  updateTelemetry();
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const mapped = Object.fromEntries(screenJoints.map(j => [j.name, j]));

  // Draw skeleton connections
  ctx.strokeStyle = '#bafa59';
  ctx.lineWidth = 3;
  LINKS.forEach(([a, b]) => {
    if (mapped[a] && mapped[b]) {
      ctx.beginPath();
      ctx.moveTo(mapped[a].x * canvas.width, mapped[a].y * canvas.height);
      ctx.lineTo(mapped[b].x * canvas.width, mapped[b].y * canvas.height);
      ctx.stroke();
    }
  });

  // Draw target reticle
  if (target) {
    const x = target.x * canvas.width;
    const y = target.y * canvas.height;
    ctx.strokeStyle = '#bafa59';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(186, 250, 89, 0.15)';
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '12px DM Mono';
    ctx.fillStyle = '#bafa59';
    ctx.fillText(`${$('range').value}m`, x + 30, y + 4);
  }
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    $('cameraPrompt').style.display = 'none';
    $('motionButton').disabled = false;
    $('detectButton').disabled = false;
    $('cameraButton').disabled = true;
    $('cameraButton').textContent = 'Camera active';
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    active = true;
  } catch (e) {
    $('cameraPrompt').innerHTML = `<b>Camera unavailable</b><span>${
      location.protocol === 'https:'
        ? 'Allow camera permission and retry.'
        : 'Rear camera requires HTTPS. Open via trusted HTTPS certificate or localhost.'
    }</span>`;
  }
}

async function enableDetection() {
  try {
    $('detectButton').disabled = true;
    $('detectButton').textContent = 'Loading pose model…';
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest');
    const files = await vision.FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    );
    landmarker = await vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task'
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    detecting = true;
    $('detectButton').textContent = 'Person detection active';
    detectLoop();
  } catch (e) {
    $('detectButton').disabled = false;
    $('detectButton').textContent = 'Detection fallback — tap target';
    console.error(e);
  }
}

function detectLoop() {
  if (!detecting || !landmarker) return;
  const result = landmarker.detectForVideo(video, performance.now());
  const points = result.landmarks?.[0];
  if (points) {
    screenJoints = JOINTS.map(([name, index]) => ({
      name,
      x: points[index].x,
      y: points[index].y,
      confidence: points[index].visibility ?? 0.8
    })).filter(j => j.confidence > 0.35);

    const a = points[23], b = points[24]; // hips
    if (a && b) {
      target = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    render();
    sendDetection();
  } else {
    screenJoints = [];
    render();
  }
  setTimeout(detectLoop, 100);
}

async function toggleMotion() {
  if (motionEnabled) {
    motionEnabled = false;
    $('motionButton').textContent = 'Enable compass / gyro';
    return;
  }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') throw Error('Permission denied');
    }
    window.addEventListener('deviceorientation', e => {
      if (!motionEnabled || e.alpha == null) return;
      lastAlpha = e.alpha;
      if (yaw0 === null) yaw0 = lastAlpha;
      // In W3C spec, alpha decreases as device rotates clockwise
      // We want clockwise (turning right) to be positive yaw:
      yawDeg = Math.round(-(lastAlpha - yaw0));
      while (yawDeg > 180) yawDeg -= 360;
      while (yawDeg < -180) yawDeg += 360;
      $('yawSlider').value = yawDeg;
      updatePresetHighlight();
      sendPose();
    });
    motionEnabled = true;
    $('motionButton').textContent = 'Motion active (tap to disable)';
  } catch (e) {
    $('motionButton').textContent = 'Motion permission denied';
  }
}

function setYaw(deg) {
  yawDeg = Number(deg);
  $('yawSlider').value = yawDeg;
  updatePresetHighlight();
  sendPose();
}

function updatePresetHighlight() {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    const bYaw = Number(btn.dataset.yaw);
    const diff = Math.abs((((yawDeg - bYaw) % 360) + 540) % 360 - 180);
    btn.classList.toggle('active', diff < 15);
  });
}

function syncInputsFromPose() {
  $('inputX').value = pose.x.toFixed(2);
  $('inputZ').value = pose.z.toFixed(2);
  sendPose();
}

// UI Event Listeners
$('cameraButton').onclick = startCamera;
$('detectButton').onclick = enableDetection;
$('motionButton').onclick = toggleMotion;

$('range').oninput = () => {
  $('rangeOutput').textContent = `${Number($('range').value).toFixed(1)} m`;
  if (target) sendDetection();
};

$('inputX').oninput = e => {
  pose.x = parseFloat(e.target.value) || 0.0;
  sendPose();
};

$('inputZ').oninput = e => {
  pose.z = parseFloat(e.target.value) || 0.0;
  sendPose();
};

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.onclick = () => {
    const input = $(btn.dataset.input);
    const delta = parseFloat(btn.dataset.delta);
    const cur = parseFloat(input.value) || 0.0;
    input.value = (cur + delta).toFixed(2);
    input.dispatchEvent(new Event('input'));
  };
});

document.querySelectorAll('.dpad-btn[data-axis]').forEach(btn => {
  btn.onclick = () => {
    const axis = btn.dataset.axis;
    const step = parseFloat(btn.dataset.step);
    pose[axis] = Math.round((pose[axis] + step) * 100) / 100;
    syncInputsFromPose();
  };
});

$('resetPosition').onclick = () => {
  pose.x = 0.0;
  pose.y = 0.0;
  pose.z = 0.0;
  syncInputsFromPose();
};

$('yawSlider').oninput = e => {
  setYaw(parseFloat(e.target.value));
};

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.onclick = () => {
    setYaw(parseFloat(btn.dataset.yaw));
  };
});

canvas.onclick = e => {
  const r = canvas.getBoundingClientRect();
  target = {
    x: (e.clientX - r.left) / r.width,
    y: (e.clientY - r.top) / r.height
  };
  screenJoints = [];
  render();
  sendDetection();
};

function connect() {
  socket = new WebSocket(wsURL);
  socket.onopen = () => {
    $('hub').textContent = 'CONNECTED';
    $('hub').classList.add('live');
    sendPose();
  };
  socket.onclose = () => {
    $('hub').textContent = 'RECONNECTING';
    $('hub').classList.remove('live');
    setTimeout(connect, 2000);
  };
}

// Initial setup
syncInputsFromPose();
setYaw(0);
connect();
setInterval(render, 100);
