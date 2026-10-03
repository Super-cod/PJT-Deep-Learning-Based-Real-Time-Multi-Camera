const $ = id => document.getElementById(id);

const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
const mapCanvas = $('floorMap'), mapCtx = mapCanvas.getContext('2d');

let intrinsics = null;
// subjectId → { data, receivedAt, tracked }. "tracked" entries come from the
// hub's multi-person `targets` packets; others are legacy single `target`s.
const targets = new Map();
let observerConnected = false;
const PERSON_COLORS = ['#bafa59', '#55dfcf', '#ff8452', '#c792ea', '#ffd166', '#ff6b9a'];
const TARGET_STALE_MS = 1500; // hide the overlay when the phone stops seeing the person
let stream = null;
let calibrated = true;

const laptopState = { x: 0.0, y: 0.0, z: 0.0, yawDeg: 0 };
const phoneState = { x: 1.0, y: 0.0, z: 1.0, yawDeg: 0 };

const socketURL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/viewer`;
let socket = null;

function fmt(n) {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
}

function send(msg) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

async function refreshIntrinsics() {
  try {
    const res = await fetch('/camera/intrinsics').then(r => r.json());
    if (res.intrinsics) {
      intrinsics = res.intrinsics;
      $('intrinsics').textContent = `${intrinsics.fx.toFixed(0)}px · ${intrinsics.width}×${intrinsics.height}`;
    } else {
      $('intrinsics').textContent = 'Estimated 65° FOV';
    }
  } catch {
    $('intrinsics').textContent = 'Estimated 65° FOV';
  }
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    $('empty').style.display = 'none';
    $('startCamera').textContent = 'Camera active';
    $('startCamera').disabled = true;
    resize();
    if (!intrinsics) {
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      intrinsics = { width: w, height: h, fx: w * 0.9, fy: w * 0.9, cx: w / 2, cy: h / 2 };
      $('intrinsics').textContent = `Webcam ${w}×${h}`;
    }
  } catch {
    $('targetReadout').textContent = 'Camera permission denied';
  }
}

function resize() {
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
}

// Transform world point [wx, wy, wz] into laptop observer camera frame [camX, camY, camZ]
function worldToLaptop(wx, wy, wz, lx, ly, lz, yawRad) {
  const dx = wx - lx;
  const dy = wy - ly;
  const dz = wz - lz;
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  // R = [[c, 0, s], [0, 1, 0], [-s, 0, c]]
  // local = R^T * [dx, dy, dz] = [c*dx - s*dz, dy, s*dx + c*dz]
  const camX = dx * c - dz * s;
  const camY = dy;
  const camZ = dx * s + dz * c;
  return [camX, camY, camZ];
}

// Pinhole projection of laptop-local point [camX, camY, camZ] onto canvas
function project(camX, camY, camZ) {
  if (camZ <= 0.05) return null; // Behind observer camera
  if (!intrinsics) return null;

  const sx = canvas.width / intrinsics.width;
  const sy = canvas.height / intrinsics.height;

  // u = fx * (camX / camZ) + cx
  // v = -fy * (camY / camZ) + cy  (up is +Y, image coords go down)
  const u = (intrinsics.fx * (camX / camZ)) + intrinsics.cx;
  const v = (-intrinsics.fy * (camY / camZ)) + intrinsics.cy;

  const px = u * sx;
  const py = v * sy;

  const inBounds = px >= 0 && px <= canvas.width && py >= 0 && py <= canvas.height;
  return { x: px, y: py, z: camZ, inBounds };
}

function liveTargets() {
  const now = performance.now();
  return [...targets.values()]
    .filter(t => t.data.positionWorld && now - t.receivedAt <= TARGET_STALE_MS)
    .map(t => t.data);
}

function personColor(subjectId) {
  const n = parseInt(String(subjectId).replace(/\D/g, ''), 10);
  return PERSON_COLORS[(Number.isFinite(n) ? n - 1 : 0) % PERSON_COLORS.length];
}

const SKELETON_LINKS = [
  ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
  // Older observers send no knees: connect hip → ankle directly.
  ['left_hip', 'left_ankle', 'left_knee'], ['right_hip', 'right_ankle', 'right_knee']
];

function toLaptop(w) {
  return worldToLaptop(w[0], w[1], w[2], laptopState.x, laptopState.y, laptopState.z,
    (laptopState.yawDeg * Math.PI) / 180);
}

// Classify a target against the laptop camera frustum.
function gate(t) {
  const [camX, camY, camZ] = toLaptop(t.positionWorld);
  if (camZ <= 0.05) return { state: 'behind', camX, camZ };
  const p = project(camX, camY, camZ);
  if (!p || !p.inBounds) return { state: 'outside', camX, camZ, side: camX < 0 ? 'LEFT' : 'RIGHT' };
  return { state: 'visible', camX, camZ, p };
}

function drawPerson(t, g) {
  const color = personColor(t.subjectId);
  ctx.strokeStyle = color;
  ctx.shadowColor = color;

  if (t.joints && t.joints.length > 0) {
    const pj = {};
    t.joints.forEach(j => {
      if (!j.positionWorld) return;
      const [jx, jy, jz] = toLaptop(j.positionWorld);
      const jp = project(jx, jy, jz);
      if (jp && jp.inBounds) pj[j.name] = jp;
    });
    ctx.shadowBlur = 8;
    ctx.lineWidth = 4;
    SKELETON_LINKS.forEach(([a, b, unless]) => {
      if (unless && pj[unless]) return;
      if (pj[a] && pj[b]) {
        ctx.beginPath();
        ctx.moveTo(pj[a].x, pj[a].y);
        ctx.lineTo(pj[b].x, pj[b].y);
        ctx.stroke();
      }
    });
  }

  const { p, camZ } = g;
  ctx.shadowBlur = 12;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 36, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.font = '700 13px DM Mono';
  ctx.fillStyle = color;
  ctx.fillText(`${(t.subjectId || 'person').toUpperCase()} · ${camZ.toFixed(1)}m`, p.x + 46, p.y + 4);
}

// Render AR Overlay onto webcam canvas
function drawOverlay() {
  requestAnimationFrame(drawOverlay);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const badge = $('targetStatusBadge');
  const readout = $('targetReadout');
  const people = liveTargets();

  if (people.length === 0) {
    readout.textContent = observerConnected ? 'NO PERSON DETECTED' : 'PHONE OFFLINE';
    readout.className = 'hud br';
    badge.textContent = 'AWAITING TARGET';
    badge.className = 'badge-state state-awaiting';
    $('targetWorld').textContent = 'X: — · Z: —';
    $('targetWorldSub').textContent = 'Waiting for detection';
    $('targetLaptop').textContent = 'x: — · z: —';
    $('viewGatingStatus').textContent = '—';
    return;
  }

  const gated = people.map(t => ({ t, g: gate(t) }));
  gated.filter(({ g }) => g.state === 'visible').forEach(({ t, g }) => drawPerson(t, g));

  // Telemetry shows the nearest person; badges summarise everyone.
  const nearest = gated.reduce((a, b) => (Math.hypot(b.g.camX, b.g.camZ) < Math.hypot(a.g.camX, a.g.camZ) ? b : a));
  const w = nearest.t.positionWorld;
  $('targetWorld').textContent = `X: ${fmt(w[0])} · Z: ${fmt(w[2])}`;
  $('targetWorldSub').textContent = `${nearest.t.subjectId} · height Y ${fmt(w[1])}m · ${people.length} tracked`;
  $('targetLaptop').textContent = `x: ${fmt(nearest.g.camX)} · z: ${fmt(nearest.g.camZ)}`;

  const counts = { visible: 0, outside: 0, behind: 0 };
  gated.forEach(({ g }) => counts[g.state]++);
  const ng = nearest.g;
  $('viewGatingStatus').textContent =
    ng.state === 'behind' ? `Behind observer camera (z = ${ng.camZ.toFixed(2)}m)`
      : ng.state === 'outside' ? `Outside screen (${ng.side} by ${Math.abs(ng.camX).toFixed(1)}m)`
        : `Visible on screen at [${Math.round(ng.p.x)}, ${Math.round(ng.p.y)}]`;

  if (counts.visible > 0) {
    badge.textContent = people.length > 1 ? `${counts.visible}/${people.length} IN SIGHT` : 'IN SIGHT';
    badge.className = 'badge-state state-visible';
    readout.textContent = `${counts.visible} PERSON${counts.visible > 1 ? 'S' : ''} IN SIGHT · ${people.length} TRACKED`;
    readout.className = 'hud br';
  } else if (counts.outside > 0) {
    badge.textContent = `OUTSIDE FOV (${people.length})`;
    badge.className = 'badge-state state-outside';
    readout.textContent = `${people.length} TRACKED · NONE IN FIELD OF VIEW`;
    readout.className = 'hud br alert-outside';
  } else {
    badge.textContent = 'BEHIND CAMERA';
    badge.className = 'badge-state state-behind';
    readout.textContent = `${people.length} TRACKED · ALL BEHIND OBSERVER CAMERA`;
    readout.className = 'hud br alert-behind';
  }
}

// 2D Top-Down Floor Map
function renderFloorMap() {
  const w = mapCanvas.width;
  const h = mapCanvas.height;
  mapCtx.clearRect(0, 0, w, h);

  // Map origin (laptop) located horizontally center, vertically lower-center
  const originX = w / 2;
  const originY = h * 0.72;
  const scale = 36; // 36 pixels = 1 metre

  // World (X, Z) to Canvas (cx, cy)
  // +X is Right (+pixels X), +Z is Forward (-pixels Y, up on screen)
  const toCanvas = (x, z) => [originX + (x * scale), originY - (z * scale)];

  // Draw Grid Lines & Metric Range Rings
  mapCtx.strokeStyle = '#183344';
  mapCtx.lineWidth = 1;

  for (let r = 1; r <= 6; r++) {
    mapCtx.beginPath();
    mapCtx.arc(originX, originY, r * scale, 0, Math.PI * 2);
    mapCtx.stroke();
  }

  // Draw Axes
  mapCtx.strokeStyle = '#285068';
  mapCtx.lineWidth = 1.5;
  mapCtx.beginPath();
  mapCtx.moveTo(20, originY);
  mapCtx.lineTo(w - 20, originY); // X Axis
  mapCtx.moveTo(originX, 20);
  mapCtx.lineTo(originX, h - 20); // Z Axis
  mapCtx.stroke();

  // Axis Labels
  mapCtx.font = '10px DM Mono';
  mapCtx.fillStyle = '#658694';
  mapCtx.fillText('+X (Right)', w - 75, originY - 6);
  mapCtx.fillText('−X (Left)', 25, originY - 6);
  mapCtx.fillText('+Z (Forward)', originX + 8, 30);
  mapCtx.fillText('−Z (Back)', originX + 8, h - 25);

  // Draw Laptop Viewing Cone (Frustum)
  const laptopYawRad = (laptopState.yawDeg * Math.PI) / 180;
  const fovRad = Math.PI / 3; // ~60 deg
  const coneDist = 5.2 * scale;

  mapCtx.fillStyle = 'rgba(85, 223, 207, 0.08)';
  mapCtx.strokeStyle = 'rgba(85, 223, 207, 0.45)';
  mapCtx.lineWidth = 1.5;
  mapCtx.beginPath();
  mapCtx.moveTo(originX, originY);

  const angle1 = (-Math.PI / 2) + laptopYawRad - (fovRad / 2);
  const angle2 = (-Math.PI / 2) + laptopYawRad + (fovRad / 2);
  mapCtx.lineTo(originX + Math.cos(angle1) * coneDist, originY + Math.sin(angle1) * coneDist);
  mapCtx.arc(originX, originY, coneDist, angle1, angle2);
  mapCtx.closePath();
  mapCtx.fill();
  mapCtx.stroke();

  // Draw Laptop Origin Marker
  mapCtx.fillStyle = '#55dfcf';
  mapCtx.beginPath();
  mapCtx.arc(originX, originY, 6, 0, Math.PI * 2);
  mapCtx.fill();
  mapCtx.fillStyle = '#fff';
  mapCtx.font = '700 10px DM Mono';
  mapCtx.fillText('LAPTOP (0,0)', originX - 35, originY + 18);

  // Draw Phone Position and Heading
  const [phoneCx, phoneCy] = toCanvas(phoneState.x, phoneState.z);
  const phoneYawRad = (phoneState.yawDeg * Math.PI) / 180;

  // Phone Heading Arrow
  const arrowLen = 24;
  const headingAngle = (-Math.PI / 2) + phoneYawRad;
  const arrowTipX = phoneCx + Math.cos(headingAngle) * arrowLen;
  const arrowTipY = phoneCy + Math.sin(headingAngle) * arrowLen;

  mapCtx.strokeStyle = '#ff8452';
  mapCtx.lineWidth = 2.5;
  mapCtx.beginPath();
  mapCtx.moveTo(phoneCx, phoneCy);
  mapCtx.lineTo(arrowTipX, arrowTipY);
  mapCtx.stroke();

  // Phone Marker Dot
  mapCtx.fillStyle = '#ff8452';
  mapCtx.beginPath();
  mapCtx.arc(phoneCx, phoneCy, 5, 0, Math.PI * 2);
  mapCtx.fill();
  mapCtx.font = '700 10px DM Mono';
  mapCtx.fillText('PHONE', phoneCx + 8, phoneCy - 4);

  // Draw every tracked person
  liveTargets().forEach(t => {
    const [tx, tz] = [t.positionWorld[0], t.positionWorld[2]];
    const [targetCx, targetCy] = toCanvas(tx, tz);
    const g = gate(t);
    const color = personColor(t.subjectId);

    // Sight line from laptop: solid in view, dashed outside FOV, red dashed behind
    mapCtx.beginPath();
    mapCtx.moveTo(originX, originY);
    mapCtx.lineTo(targetCx, targetCy);
    mapCtx.strokeStyle = g.state === 'behind' ? '#ff5252' : color;
    mapCtx.setLineDash(g.state === 'visible' ? [] : [5, 4]);
    mapCtx.lineWidth = 1.5;
    mapCtx.stroke();
    mapCtx.setLineDash([]);

    mapCtx.fillStyle = color;
    mapCtx.beginPath();
    mapCtx.arc(targetCx, targetCy, 6, 0, Math.PI * 2);
    mapCtx.fill();

    mapCtx.fillStyle = '#fff';
    mapCtx.font = '700 10px DM Mono';
    mapCtx.fillText(String(t.subjectId || 'PERSON').toUpperCase(), targetCx + 9, targetCy + 3);
  });
}

function updateLaptopYaw(deg) {
  laptopState.yawDeg = deg;
  $('laptopYawSlider').value = deg;
  $('laptopYawVal').textContent = `${deg >= 0 ? '+' : ''}${deg}° (${getHeadingDesc(deg)})`;

  document.querySelectorAll('.yaw-preset').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.yaw) === deg);
  });

  send({
    type: 'laptop_pose',
    position: [laptopState.x, laptopState.y, laptopState.z],
    yawDeg: deg,
    yawRad: (deg * Math.PI) / 180
  });

  renderFloorMap();
}

function getHeadingDesc(deg) {
  if (deg === 0) return 'Facing +Z Forward';
  if (deg > 0) return `Turned Right by +${deg}°`;
  return `Turned Left by ${deg}°`;
}

function setPhoneFromLaptop(x, z) {
  phoneState.x = x;
  phoneState.z = z;
  $('lpPhoneX').value = x.toFixed(2);
  $('lpPhoneZ').value = z.toFixed(2);

  $('phonePose').textContent = `X: ${fmt(x)} · Z: ${fmt(z)}`;

  send({
    type: 'set_phone_pose',
    position: [x, 0, z],
    yawDeg: phoneState.yawDeg,
    yawRad: (phoneState.yawDeg * Math.PI) / 180
  });

  renderFloorMap();
}

function setObserverStatus(connected) {
  observerConnected = connected;
  const pill = $('phoneConnection');
  pill.innerHTML = `<span class="dot"></span> ${connected ? 'PHONE LIVE' : 'PHONE OFFLINE'}`;
  pill.classList.toggle('live', connected);
}

function connect() {
  socket = new WebSocket(socketURL);

  socket.onopen = () => {
    $('connection').innerHTML = '<span class="dot"></span> HUB CONNECTED';
    $('connection').classList.add('live');
    updateLaptopYaw(laptopState.yawDeg);
  };

  function updatePhonePoseFromWorld(phoneWorld) {
    if (!phoneWorld || !phoneWorld.position) return;
    phoneState.x = phoneWorld.position[0];
    phoneState.z = phoneWorld.position[2];
    $('phonePose').textContent = `X: ${fmt(phoneState.x)} · Z: ${fmt(phoneState.z)}`;
    if (document.activeElement !== $('lpPhoneX')) {
      $('lpPhoneX').value = phoneState.x.toFixed(2);
    }
    if (document.activeElement !== $('lpPhoneZ')) {
      $('lpPhoneZ').value = phoneState.z.toFixed(2);
    }

    const q = phoneWorld.quaternionXyzw;
    if (q) {
      const yaw = Math.atan2(2 * (q[0] * q[2] + q[1] * q[3]), 1 - 2 * (q[0] * q[0] + q[1] * q[1]));
      phoneState.yawDeg = Math.round((yaw * 180) / Math.PI);
      $('phoneHeadingText').textContent = `Heading: ${phoneState.yawDeg}°`;
    }
  }

  socket.onmessage = e => {
    let p;
    try { p = JSON.parse(e.data); } catch { return; }

    if (p.type === 'observer_status') {
      setObserverStatus(p.connected);
    }

    if (p.type === 'debug_pose') {
      updatePhonePoseFromWorld(p.phoneWorld);
      renderFloorMap();
    }

    if (p.type === 'targets') {
      // Authoritative list of everyone the phone sees right now.
      const now = performance.now();
      for (const [id, entry] of targets) if (entry.tracked) targets.delete(id);
      p.targets.forEach(t => targets.set(t.subjectId, { data: t, receivedAt: now, tracked: true }));
      updatePhonePoseFromWorld(p.phoneWorld);
      renderFloorMap();
    }

    if (p.type === 'target') {
      targets.set(p.subjectId || 'target_01', { data: p, receivedAt: performance.now(), tracked: false });
      updatePhonePoseFromWorld(p.phoneWorld);
      renderFloorMap();
    }
  };

  socket.onclose = () => {
    $('connection').innerHTML = '<span class="dot"></span> RECONNECTING';
    $('connection').classList.remove('live');
    setObserverStatus(false);
    setTimeout(connect, 2000);
  };
}

// UI Event Handlers
$('startCamera').onclick = startCamera;
$('calibrate').onclick = () => {
  laptopState.x = 0;
  laptopState.y = 0;
  laptopState.z = 0;
  updateLaptopYaw(0);
  // Ask the phone to zero its own tracker (it must be held beside the webcam);
  // the hub falls back to placing it at (0,0) when the phone is offline.
  send({ type: 'request_phone_calibration' });
};

$('laptopYawSlider').oninput = e => {
  updateLaptopYaw(Number(e.target.value));
};

$('resetLaptopYaw').onclick = () => {
  updateLaptopYaw(0);
};

document.querySelectorAll('.yaw-preset').forEach(btn => {
  btn.onclick = () => {
    updateLaptopYaw(Number(btn.dataset.yaw));
  };
});

$('lpPhoneX').onchange = e => {
  const x = parseFloat(e.target.value);
  if (Number.isFinite(x)) setPhoneFromLaptop(x, phoneState.z);
};

$('lpPhoneZ').onchange = e => {
  const z = parseFloat(e.target.value);
  if (Number.isFinite(z)) setPhoneFromLaptop(phoneState.x, z);
};

// Preset Scenarios for testing
$('sceneFront').onclick = () => setPhoneFromLaptop(1.0, 2.0);
$('sceneBehind').onclick = () => setPhoneFromLaptop(0.0, -1.5);
$('sceneLeft').onclick = () => setPhoneFromLaptop(-2.0, 2.0);

video.onloadedmetadata = resize;
window.onresize = () => {
  resize();
  renderFloorMap();
};

// Initialization
refreshIntrinsics();
connect();
drawOverlay();
renderFloorMap();
setInterval(renderFloorMap, 200);
