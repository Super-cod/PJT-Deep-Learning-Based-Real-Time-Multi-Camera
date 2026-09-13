const $ = id => document.getElementById(id);

const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
const mapCanvas = $('floorMap'), mapCtx = mapCanvas.getContext('2d');

let intrinsics = null;
let target = null;
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

// Render AR Overlay onto webcam canvas
function drawOverlay() {
  requestAnimationFrame(drawOverlay);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!target) return;

  const yawRad = (laptopState.yawDeg * Math.PI) / 180;
  const worldPos = target.positionWorld;
  if (!worldPos) return;

  // Compute laptop-local coordinates with current laptop yaw
  const [camX, camY, camZ] = worldToLaptop(
    worldPos[0], worldPos[1], worldPos[2],
    laptopState.x, laptopState.y, laptopState.z,
    yawRad
  );

  // Update Telemetry Displays
  $('targetWorld').textContent = `X: ${fmt(worldPos[0])} · Z: ${fmt(worldPos[2])}`;
  $('targetWorldSub').textContent = `Height Y: ${fmt(worldPos[1])}m`;
  $('targetLaptop').textContent = `x: ${fmt(camX)} · z: ${fmt(camZ)}`;

  const badge = $('targetStatusBadge');
  const readout = $('targetReadout');

  // Gating Check: Is target in front of observer camera?
  if (camZ <= 0.05) {
    // BEHIND CAMERA
    readout.textContent = `TARGET BEHIND OBSERVER CAMERA · z = ${camZ.toFixed(2)}m`;
    readout.className = 'hud br alert-behind';
    badge.textContent = 'BEHIND CAMERA';
    badge.className = 'badge-state state-behind';
    $('viewGatingStatus').textContent = `Behind observer camera (z = ${camZ.toFixed(2)}m)`;
    return;
  }

  // Target is in front: Project to 2D screen
  const p = project(camX, camY, camZ);
  if (!p) return;

  if (!p.inBounds) {
    // OUTSIDE FOV
    const side = camX < 0 ? 'LEFT' : 'RIGHT';
    readout.textContent = `TARGET OUTSIDE FOV (${side}) · ${camZ.toFixed(1)}m`;
    readout.className = 'hud br alert-outside';
    badge.textContent = `OUTSIDE FOV (${side})`;
    badge.className = 'badge-state state-outside';
    $('viewGatingStatus').textContent = `Outside screen (${side} by ${Math.abs(camX).toFixed(1)}m)`;
    return;
  }

  // TARGET IS IN SIGHT: Render AR Visuals
  readout.textContent = `REMOTE TARGET IN SIGHT · ${camZ.toFixed(1)}m`;
  readout.className = 'hud br';
  badge.textContent = 'IN SIGHT';
  badge.className = 'badge-state state-visible';
  $('viewGatingStatus').textContent = `Visible on screen at [${Math.round(p.x)}, ${Math.round(p.y)}]`;

  // Draw Skeleton joints if available
  if (target.joints && target.joints.length > 0) {
    const projectedJoints = {};
    target.joints.forEach(j => {
      const jWorld = j.positionWorld;
      if (jWorld) {
        const [jx, jy, jz] = worldToLaptop(
          jWorld[0], jWorld[1], jWorld[2],
          laptopState.x, laptopState.y, laptopState.z,
          yawRad
        );
        const jp = project(jx, jy, jz);
        if (jp && jp.inBounds) {
          projectedJoints[j.name] = jp;
        }
      }
    });

    const links = [
      ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
      ['left_shoulder', 'right_shoulder'],
      ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
      ['left_hip', 'right_hip'],
      ['left_hip', 'left_ankle'], ['right_hip', 'right_ankle']
    ];

    ctx.strokeStyle = '#bafa59';
    ctx.shadowColor = '#bafa59';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 4;
    links.forEach(([a, b]) => {
      if (projectedJoints[a] && projectedJoints[b]) {
        ctx.beginPath();
        ctx.moveTo(projectedJoints[a].x, projectedJoints[a].y);
        ctx.lineTo(projectedJoints[b].x, projectedJoints[b].y);
        ctx.stroke();
      }
    });
    ctx.shadowBlur = 0;
  }

  // Draw Target Reticle & Glowing Rings
  ctx.strokeStyle = '#bafa59';
  ctx.shadowColor = '#bafa59';
  ctx.shadowBlur = 12;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 36, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(186, 250, 89, 0.18)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, 36, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.font = '700 13px DM Mono';
  ctx.fillStyle = '#bafa59';
  ctx.fillText(`${target.subjectId || 'PERSON_01'} · ${camZ.toFixed(1)}m`, p.x + 46, p.y + 4);
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

  // Draw Target / Person
  if (target && target.positionWorld) {
    const [tx, tz] = [target.positionWorld[0], target.positionWorld[2]];
    const [targetCx, targetCy] = toCanvas(tx, tz);

    const [camX, , camZ] = worldToLaptop(
      tx, 0, tz,
      laptopState.x, laptopState.y, laptopState.z,
      laptopYawRad
    );

    // Sight Line from Laptop to Target
    mapCtx.beginPath();
    mapCtx.moveTo(originX, originY);
    mapCtx.lineTo(targetCx, targetCy);

    if (camZ <= 0.05) {
      // Behind camera: Red dashed
      mapCtx.strokeStyle = '#ff5252';
      mapCtx.setLineDash([5, 4]);
    } else {
      // In front: Solid lime if in FOV, orange dashed if outside FOV
      const proj = project(camX, 0, camZ);
      if (proj && proj.inBounds) {
        mapCtx.strokeStyle = '#bafa59';
        mapCtx.setLineDash([]);
      } else {
        mapCtx.strokeStyle = '#ff8452';
        mapCtx.setLineDash([4, 4]);
      }
    }
    mapCtx.lineWidth = 1.5;
    mapCtx.stroke();
    mapCtx.setLineDash([]);

    // Target Marker
    mapCtx.fillStyle = camZ > 0.05 ? '#bafa59' : '#ff5252';
    mapCtx.beginPath();
    mapCtx.arc(targetCx, targetCy, 6, 0, Math.PI * 2);
    mapCtx.fill();

    mapCtx.fillStyle = '#fff';
    mapCtx.font = '700 10px DM Mono';
    mapCtx.fillText('PERSON', targetCx + 9, targetCy + 3);
  }
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

function connect() {
  socket = new WebSocket(socketURL);

  socket.onopen = () => {
    $('connection').innerHTML = '<span class="dot"></span> HUB CONNECTED';
    $('connection').classList.add('live');
    updateLaptopYaw(laptopState.yawDeg);
  };

  socket.onmessage = e => {
    const p = JSON.parse(e.data);

    if (p.type === 'debug_pose') {
      if (p.phoneWorld) {
        phoneState.x = p.phoneWorld.position[0];
        phoneState.z = p.phoneWorld.position[2];
        $('phonePose').textContent = `X: ${fmt(phoneState.x)} · Z: ${fmt(phoneState.z)}`;
        if (document.activeElement !== $('lpPhoneX')) {
          $('lpPhoneX').value = phoneState.x.toFixed(2);
        }
        if (document.activeElement !== $('lpPhoneZ')) {
          $('lpPhoneZ').value = phoneState.z.toFixed(2);
        }

        // Extract yaw from quaternion if present
        const q = p.phoneWorld.quaternionXyzw;
        if (q) {
          const yaw = Math.atan2(2 * (q[0] * q[2] + q[1] * q[3]), 1 - 2 * (q[0] * q[0] + q[1] * q[1]));
          phoneState.yawDeg = Math.round((yaw * 180) / Math.PI);
          $('phoneHeadingText').textContent = `Heading: ${phoneState.yawDeg}°`;
        }
      }
      renderFloorMap();
    }

    if (p.type === 'target') {
      target = p;
      if (p.phoneWorld) {
        phoneState.x = p.phoneWorld.position[0];
        phoneState.z = p.phoneWorld.position[2];
        $('phonePose').textContent = `X: ${fmt(phoneState.x)} · Z: ${fmt(phoneState.z)}`;
      }
      renderFloorMap();
    }
  };

  socket.onclose = () => {
    $('connection').innerHTML = '<span class="dot"></span> RECONNECTING';
    $('connection').classList.remove('live');
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
