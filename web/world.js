// Global 3D "god view": scanned rooms, every phone, every fused person, and
// which phones see each person directly vs. only through a wall.
//
// Frame: the shared ARWorldMap frame (right-handed, +Y up, metres) — the same
// convention as three.js. Phone poses are ARKit camera transforms, so a phone
// looks down its local −Z axis, exactly like a three.js camera.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = id => document.getElementById(id);

const SKELETON_LINKS = [
  ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
];
const PERSON_COLORS = [0xbafa59, 0x55dfcf, 0xff8452, 0xc792ea, 0xffd166, 0xff6b9a];
const DEVICE_COLORS = [0x4fc3f7, 0xf06292, 0xffb74d, 0x81c784, 0x9575cd];
// iPhone wide camera field of view (degrees) along the image's long / short side.
const PHONE_FOV_LONG = 69;
const PHONE_FOV_SHORT = 54;
// ARKit camera poses are landscape (local +X = bottom of a portrait phone); a
// +90° roll about the viewing axis turns them into an upright portrait view.
const PORTRAIT_ROLL = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const ORBIT_FOV = 60;
const SURFACE_COLORS = { wall: 0x9fb8c8, door: 0xff8452, window: 0x55dfcf, opening: 0x55dfcf };

function colorFor(palette, key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const n = parseInt(String(key).replace(/\D/g, ''), 10);
  return palette[(Number.isFinite(n) ? n - 1 : h) % palette.length];
}

// ── Renderer / scene ─────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
$('scene').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05090e);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x0b1218, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(4, 10, 6);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, 1, 0.02, 200); // fov reset to ORBIT_FOV outside helmet view
camera.position.set(6, 7, 8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const grid = new THREE.GridHelper(30, 30, 0x1f3442, 0x13212c);
scene.add(grid);
scene.add(new THREE.AxesHelper(0.5));

const roomGroup = new THREE.Group();
const objectGroup = new THREE.Group();
const deviceGroup = new THREE.Group();
const peopleGroup = new THREE.Group();
const sightGroup = new THREE.Group();
scene.add(roomGroup, objectGroup, deviceGroup, peopleGroup, sightGroup);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ── Text labels (sprites) ────────────────────────────────────────────────────
const LABEL_HEIGHT = 0.032; // fraction of the viewport height
function makeLabel(text, color = '#e3edf2') {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '600 28px ui-monospace, Menlo, monospace';
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 24;
  canvas.height = 44;
  ctx.font = font;
  ctx.fillStyle = 'rgba(5, 9, 14, 0.75)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.fillText(text, 12, 31);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Constant on-screen size, so labels stay readable in orbit and helmet views alike.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, depthTest: false, transparent: true, sizeAttenuation: false,
  }));
  sprite.scale.set(canvas.width / canvas.height * LABEL_HEIGHT, LABEL_HEIGHT, 1);
  sprite.renderOrder = 20;
  sprite.userData.text = text;
  return sprite;
}

function setLabel(holder, text, color) {
  if (holder.userData.label?.userData.text === text) return;
  if (holder.userData.label) {
    holder.remove(holder.userData.label);
    holder.userData.label.material.map.dispose();
    holder.userData.label.material.dispose();
  }
  const label = makeLabel(text, color);
  holder.userData.label = label;
  holder.add(label);
}

function disposeTree(obj) {
  obj.traverse(o => {
    // Body parts share unit geometries; never free those.
    if (![UNIT_CYLINDER, UNIT_SPHERE, UNIT_BOX].includes(o.geometry)) o.geometry?.dispose();
    if (o.material) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}

// ── Room model ───────────────────────────────────────────────────────────────
let wallMeshes = [];
const wallMaterials = [];
let roomVersion = -1;
let roomLoading = false;

function matrixFrom(arr) {
  return new THREE.Matrix4().fromArray(arr);
}

function addSurface(s) {
  const color = SURFACE_COLORS[s.category] ?? 0x9fb8c8;
  const [w, h, t] = s.dimensions;
  const thickness = s.category === 'wall' ? Math.max(t, 0.1) : Math.max(t, 0.12);
  const geometry = new THREE.BoxGeometry(Math.max(w, 0.01), Math.max(h, 0.01), thickness);
  const material = new THREE.MeshStandardMaterial({
    color, transparent: true, opacity: Number($('wallOpacity').value),
    depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrixFrom(s.transform));
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }),
  );
  mesh.add(edges);
  roomGroup.add(mesh);
  if (s.category === 'wall') {
    wallMeshes.push(mesh);
    wallMaterials.push(material);
  } else {
    material.opacity = Math.min(0.9, Number($('wallOpacity').value) + 0.25);
  }
}

function addFloor(s) {
  let geometry;
  if (s.polygon && s.polygon.length >= 3) {
    const shape = new THREE.Shape(s.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
    geometry = new THREE.ShapeGeometry(shape);
  } else {
    geometry = new THREE.PlaneGeometry(s.dimensions[0], s.dimensions[1]);
  }
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0x1b2d3a, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
  }));
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrixFrom(s.transform));
  roomGroup.add(mesh);
}

function addObject(o) {
  const geometry = new THREE.BoxGeometry(...o.dimensions.map(d => Math.max(d, 0.02)));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0x51606b, transparent: true, opacity: 0.35, depthWrite: false,
  }));
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrixFrom(o.transform));
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x7d93a1 })));
  const label = makeLabel(o.category, '#9fb0bb');
  label.position.set(0, o.dimensions[1] / 2 + 0.12, 0);
  label.scale.multiplyScalar(0.7);
  mesh.add(label);
  objectGroup.add(mesh);
}

async function loadRoom(version) {
  if (roomLoading) return;
  roomLoading = true;
  try {
    const res = await fetch('/api/room');
    if (!res.ok) {
      roomVersion = version;
      return;
    }
    const { room } = await res.json();
    [roomGroup, objectGroup].forEach(g => { g.children.slice().forEach(c => { g.remove(c); disposeTree(c); }); });
    wallMeshes = [];
    wallMaterials.length = 0;
    (room.floors || []).forEach(addFloor);
    (room.walls || []).forEach(addSurface);
    [...(room.doors || []), ...(room.windows || []), ...(room.openings || [])].forEach(addSurface);
    (room.objects || []).forEach(addObject);
    scene.updateMatrixWorld(true);

    // Put the grid on the floor and frame the camera on the scanned area.
    const box = new THREE.Box3().setFromObject(roomGroup);
    if (!box.isEmpty()) {
      grid.position.y = box.min.y;
      if (viewMode !== 'follow') fitView(box);
    }
    roomVersion = version;
    $('roomInfo').innerHTML =
      `${room.rooms ?? 1} room(s) · ${(room.walls || []).length} walls · ${(room.doors || []).length} doors · ` +
      `${(room.windows || []).length} windows · ${(room.objects || []).length} objects`;
  } catch (err) {
    console.warn('room load failed', err);
  } finally {
    roomLoading = false;
  }
}

$('wallOpacity').oninput = e => wallMaterials.forEach(m => { m.opacity = Number(e.target.value); });
$('showObjects').onchange = e => { objectGroup.visible = e.target.checked; };
$('showSight').onchange = e => { sightGroup.visible = e.target.checked; };

// ── Phones ───────────────────────────────────────────────────────────────────
const deviceNodes = new Map();

function makeDevice(id) {
  const color = colorFor(DEVICE_COLORS, id);
  const node = new THREE.Group();
  const body = new THREE.Mesh(
    // ARKit's camera frame is the landscape sensor frame: local X runs along the
    // phone's long side, so the body is wide in X.
    new THREE.BoxGeometry(0.15, 0.075, 0.012),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35 }),
  );
  node.add(body);
  // View frustum: the camera looks down local −Z.
  // Wide camera: ~69° along the long (local X) side, ~54° along the short side.
  const d = 1.2, hw = Math.tan(THREE.MathUtils.degToRad(PHONE_FOV_LONG / 2)) * d, hh = Math.tan(THREE.MathUtils.degToRad(PHONE_FOV_SHORT / 2)) * d;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => new THREE.Vector3(x, y, -d));
  const pts = [];
  corners.forEach((c, i) => { pts.push(new THREE.Vector3(), c, c, corners[(i + 1) % 4]); });
  node.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }),
  ));
  const labelHolder = new THREE.Group();
  labelHolder.position.set(0, 0.17, 0);
  node.add(labelHolder);
  node.userData = { color, labelHolder };
  deviceGroup.add(node);
  return node;
}

function updateDevices(devices) {
  const seen = new Set();
  devices.forEach(dev => {
    seen.add(dev.id);
    const node = deviceNodes.get(dev.id) ?? makeDevice(dev.id);
    deviceNodes.set(dev.id, node);
    node.position.fromArray(dev.position);
    node.quaternion.fromArray(dev.quaternionXyzw);
    node.visible = dev.online;
    setLabel(node.userData.labelHolder, `${dev.name}${dev.hasLidar ? '' : ' (no LiDAR)'}`,
      '#' + node.userData.color.toString(16).padStart(6, '0'));
  });
  for (const [id, node] of deviceNodes) {
    if (!seen.has(id)) {
      deviceGroup.remove(node);
      disposeTree(node);
      deviceNodes.delete(id);
    }
  }
}

// ── People ───────────────────────────────────────────────────────────────────
const personNodes = new Map();
const raycaster = new THREE.Raycaster();

// Mannequin body: limb capsules (cylinder + joint spheres), a torso block and a head.
// [parent, child, radius m]
const BODY_BONES = [
  ['left_shoulder', 'left_elbow', 0.05], ['left_elbow', 'left_wrist', 0.04],
  ['right_shoulder', 'right_elbow', 0.05], ['right_elbow', 'right_wrist', 0.04],
  ['left_hip', 'left_knee', 0.07], ['left_knee', 'left_ankle', 0.055],
  ['right_hip', 'right_knee', 0.07], ['right_knee', 'right_ankle', 0.055],
];
const HEAD_JOINTS = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];
const UNIT_CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 14);
const UNIT_SPHERE = new THREE.SphereGeometry(1, 18, 12);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function makePerson(id) {
  const color = colorFor(PERSON_COLORS, id);
  const node = new THREE.Group();
  // Walls, floors and furniture don't write depth, so bodies stay visible behind
  // them while still occluding their own limbs correctly.
  const material = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.35, roughness: 0.6, transparent: true, opacity: 0.92,
  });
  const pool = name => {
    const mesh = new THREE.Mesh(name === 'torso' ? UNIT_BOX : name.startsWith('j:') || name === 'head' ? UNIT_SPHERE : UNIT_CYLINDER, material);
    mesh.renderOrder = 10;
    node.add(mesh);
    return mesh;
  };
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.26, 32),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
  );
  ring.rotation.x = -Math.PI / 2;
  const labelHolder = new THREE.Group();
  node.add(ring, labelHolder);
  node.userData = { color, ring, labelHolder, material, parts: new Map(), pool };
  peopleGroup.add(node);
  return node;
}

function part(node, name) {
  const { parts, pool } = node.userData;
  if (!parts.has(name)) parts.set(name, pool(name));
  const mesh = parts.get(name);
  mesh.visible = true;
  return mesh;
}

function placeBone(mesh, a, b, radius) {
  const dir = b.clone().sub(a);
  const length = dir.length();
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(Y_AXIS, dir.divideScalar(length || 1));
  mesh.scale.set(radius, length, radius);
}

const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);

function updatePerson(node, person) {
  const { ring, labelHolder, parts } = node.userData;
  parts.forEach(m => { m.visible = false; });
  const J = Object.fromEntries(person.joints.map(j => [j.name, new THREE.Vector3(...j.position)]));

  // Limbs: cylinder per bone + a sphere on each joint (reads as capsules).
  for (const [a, b, r] of BODY_BONES) {
    if (!J[a] || !J[b]) continue;
    placeBone(part(node, `${a}|${b}`), J[a], J[b], r);
    for (const [name, p] of [[a, J[a]], [b, J[b]]]) {
      const sphere = part(node, `j:${name}`);
      sphere.position.copy(p);
      sphere.scale.setScalar(r * 1.05);
    }
  }

  // Torso: a box spanning shoulders → hips, oriented by the shoulder line.
  const ls = J.left_shoulder, rs = J.right_shoulder, lh = J.left_hip, rh = J.right_hip;
  const shoulders = ls && rs ? mid(ls, rs) : J.neck;
  const hips = lh && rh ? mid(lh, rh) : J.root;
  if (shoulders && hips) {
    const up = shoulders.clone().sub(hips);
    const height = up.length();
    up.normalize();
    const across = ls && rs ? ls.clone().sub(rs) : new THREE.Vector3(1, 0, 0);
    const width = Math.max(ls && rs ? across.length() : 0.36, 0.2);
    across.sub(up.clone().multiplyScalar(across.dot(up))).normalize();
    const forward = new THREE.Vector3().crossVectors(across, up).normalize();
    const torso = part(node, 'torso');
    torso.position.copy(mid(shoulders, hips));
    torso.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, up, forward));
    torso.scale.set(width, height, 0.2);
  }

  // Head: sphere at the centre of the face/ear landmarks, else above the neck.
  const head = HEAD_JOINTS.map(n => J[n]).filter(Boolean);
  let headCentre = null;
  if (head.length) {
    headCentre = head.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(head.length);
    if (head.length === 1) headCentre.y += 0.03;
  } else if (shoulders) {
    headCentre = shoulders.clone().add(new THREE.Vector3(0, 0.22, 0));
  }
  if (headCentre) {
    const sphere = part(node, 'head');
    sphere.position.copy(headCentre);
    sphere.scale.set(0.1, 0.12, 0.1);
    const neckBase = J.neck ?? shoulders;
    if (neckBase) placeBone(part(node, 'neck'), neckBase, headCentre, 0.045);
  }

  const root = new THREE.Vector3(...person.position);
  ring.position.set(root.x, grid.position.y + 0.01, root.z);
  const top = headCentre ?? root.clone().add(new THREE.Vector3(0, 0.8, 0));
  labelHolder.position.set(top.x, top.y + 0.28, top.z);
}

// Does a scanned wall block the straight line from `from` to `to`?
function wallBetween(from, to) {
  if (!wallMeshes.length) return false;
  const dir = to.clone().sub(from);
  const dist = dir.length();
  raycaster.set(from, dir.normalize());
  raycaster.far = Math.max(0, dist - 0.2); // ignore the person's own surroundings
  return raycaster.intersectObjects(wallMeshes, false).length > 0;
}

function updatePeople(people, devices) {
  sightGroup.children.slice().forEach(c => { sightGroup.remove(c); disposeTree(c); });
  const online = devices.filter(d => d.online);
  const seen = new Set();
  const rows = [];

  people.forEach(person => {
    seen.add(person.id);
    const node = personNodes.get(person.id) ?? makePerson(person.id);
    personNodes.set(person.id, node);
    updatePerson(node, person);

    // Aim sight lines at the chest, not the hips.
    const target = new THREE.Vector3(...person.position).add(new THREE.Vector3(0, 0.35, 0));
    const hiddenFrom = [];
    online.forEach(dev => {
      const from = new THREE.Vector3(...dev.position);
      const sees = person.seenBy.includes(dev.id);
      const blocked = !sees && wallBetween(from, target);
      if (blocked) hiddenFrom.push(dev.name);
      if (!sees && !blocked) return;
      const color = sees ? node.userData.color : 0xff8452;  // dashed orange = through a wall
      const material = sees
        ? new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })
        : new THREE.LineDashedMaterial({ color, dashSize: 0.15, gapSize: 0.1, depthTest: false, transparent: true });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, target]), material);
      if (!sees) line.computeLineDistances();
      line.renderOrder = 9;
      sightGroup.add(line);
    });

    const hex = '#' + node.userData.color.toString(16).padStart(6, '0');
    setLabel(node.userData.labelHolder,
      hiddenFrom.length ? `${person.id} · behind wall from ${hiddenFrom.join(', ')}` : person.id,
      hiddenFrom.length ? '#ff8452' : hex);
    rows.push({ person, hex, hiddenFrom, devices });
  });

  for (const [id, node] of personNodes) {
    if (!seen.has(id)) {
      peopleGroup.remove(node);
      disposeTree(node);
      personNodes.delete(id);
    }
  }
  renderPeopleList(rows);
}

// ── Side panel ───────────────────────────────────────────────────────────────
// World packets arrive at 15 Hz; only touch the DOM when the markup changed so
// buttons stay clickable and text stays selectable.
function setHtml(id, html) {
  const el = $(id);
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}
let lastPeopleRender = 0;
const nameOf = (devices, id) => devices.find(d => d.id === id)?.name ?? id;
const fmt = v => v.map(n => (n >= 0 ? '+' : '') + n.toFixed(2)).join(' ');

function renderPeopleList(rows) {
  const now = performance.now();
  if (now - lastPeopleRender < 250 && Number($('peopleCount').textContent) === rows.length) return;
  lastPeopleRender = now;
  $('peopleCount').textContent = rows.length;
  setHtml('people', rows.length ? rows.map(({ person, hex, hiddenFrom, devices }) => `
    <li>
      <span class="dot" style="background:${hex}"></span><span class="name">${person.id}</span>
      <div class="sub">X Y Z ${fmt(person.position)}</div>
      <div class="sub">seen by ${person.seenBy.map(id => nameOf(devices, id)).join(', ')}</div>
      ${hiddenFrom.length ? `<div class="warn">behind a wall from ${hiddenFrom.join(', ')}</div>` : ''}
    </li>`).join('') : '<li class="empty">Nobody detected</li>');
}

function renderDeviceList(devices) {
  $('deviceCount').textContent = devices.filter(d => d.online).length;
  setHtml('devices', devices.length ? devices.map(d => {
    const hex = '#' + colorFor(DEVICE_COLORS, d.id).toString(16).padStart(6, '0');
    return `
    <li>
      <span class="dot" style="background:${d.online ? hex : '#3a4a55'}"></span><span class="name">${d.name}</span>
      <div class="sub">${d.online ? 'online' : 'offline'} · ${d.hasLidar ? 'LiDAR' : 'no LiDAR (estimated depth)'}</div>
      <div class="sub">${d.online ? `sees ${d.peopleSeen}` : ''}</div>
    </li>`;
  }).join('') : '<li class="empty">No phones connected</li>');

  setHtml('followButtons', devices.filter(d => d.online).map(d =>
    `<button data-follow="${d.id}" class="${viewMode === 'follow' && followId === d.id ? 'active' : ''}">👁 ${d.name}</button>`,
  ).join(''));
}

// ── Camera modes: orbit, top-down, follow a phone ("helmet view") ────────────
let viewMode = 'orbit';
let followId = null;

function fitView(box) {
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  controls.target.copy(centre);
  if (viewMode === 'top') {
    camera.position.set(centre.x, centre.y + size * 1.1, centre.z + 0.001);
  } else {
    camera.position.copy(centre).add(new THREE.Vector3(size * 0.6, size * 0.7, size * 0.8));
  }
  controls.update();
}

function setView(mode, id = null) {
  viewMode = mode;
  followId = id;
  controls.enabled = mode !== 'follow';
  document.querySelectorAll('#viewButtons button').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
  document.querySelectorAll('#followButtons button').forEach(b => b.classList.toggle('active', mode === 'follow' && b.dataset.follow === id));
  if (mode !== 'follow') {
    const box = new THREE.Box3().setFromObject(roomGroup);
    fitView(box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 2, 3)) : box);
  }
}
$('viewButtons').onclick = e => { if (e.target.dataset.view) setView(e.target.dataset.view); };
$('followButtons').onclick = e => {
  if (e.target.dataset.follow) {
    setView('follow', e.target.dataset.follow);
    renderDeviceList(lastDevices);
  }
};

// ── Hub connection ───────────────────────────────────────────────────────────
let lastWorldAt = 0;
let lastDevices = [];

function onWorld(packet) {
  lastWorldAt = performance.now();
  lastDevices = packet.devices;
  if (packet.roomVersion !== roomVersion) loadRoom(packet.roomVersion);
  updateDevices(packet.devices);
  updatePeople(packet.people, packet.devices);
  renderDeviceList(packet.devices);
}

function connect() {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/viewer`);
  socket.onopen = () => { $('hubStatus').textContent = 'HUB CONNECTED'; $('hubStatus').classList.add('live'); };
  socket.onmessage = e => {
    let p;
    try { p = JSON.parse(e.data); } catch { return; }
    if (p.type === 'world') onWorld(p);
  };
  socket.onclose = () => {
    $('hubStatus').textContent = 'RECONNECTING';
    $('hubStatus').classList.remove('live');
    setTimeout(connect, 2000);
  };
}

// ── Render loop ──────────────────────────────────────────────────────────────
// Helmet view: render exactly what the phone sees, upright, in a portrait 3:4
// frame (the phone camera's aspect) centred in the area left of the side panel.
function renderHelmetView(node) {
  const W = window.innerWidth, H = window.innerHeight;
  const panel = window.innerWidth > 720 ? 330 : 0;
  const h = H - 60, w = Math.min(h * 3 / 4, W - panel - 24);
  const x = Math.max(12, (W - panel - w) / 2), y = 12;

  camera.position.copy(node.position);
  camera.quaternion.copy(node.quaternion).multiply(PORTRAIT_ROLL);
  camera.fov = PHONE_FOV_LONG;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.setClearColor(0x020407);
  renderer.clear();
  renderer.setScissorTest(true);
  renderer.setScissor(x, y, w, h);
  renderer.setViewport(x, y, w, h);
  renderer.setClearColor(0x05090e);
  node.visible = false; // don't render the phone inside its own view
  renderer.render(scene, camera);
  node.visible = true;
  renderer.setScissorTest(false);
}

function restoreOrbitCamera() {
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  if (camera.fov !== ORBIT_FOV || camera.aspect !== window.innerWidth / window.innerHeight) {
    camera.fov = ORBIT_FOV;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
}

function frame() {
  requestAnimationFrame(frame);
  if (viewMode === 'follow') {
    const node = deviceNodes.get(followId);
    if (node && node.visible) {
      renderHelmetView(node);
      return;
    }
    setView('orbit');
  }
  restoreOrbitCamera();
  if (lastWorldAt && performance.now() - lastWorldAt > 2000 && lastDevices.length) {
    $('hubStatus').textContent = 'NO WORLD DATA';
  }
  controls.update();
  renderer.render(scene, camera);
}

setView('orbit');
loadRoom(0);
connect();
frame();
