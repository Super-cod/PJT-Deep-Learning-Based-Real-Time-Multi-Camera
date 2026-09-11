const $ = (id) => document.getElementById(id);
let paused = false;
let seconds = 134;
const target = { x: 2.14, y: 0, z: -3.61 };
let livePacket = null;
let liveDebug = null;

function format(n) { return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`; }
function update() {
  if (paused) return;
  const t = Date.now() / 1100;
  const phone = { x: 1.38 + Math.sin(t) * .19, y: 0, z: -2.20 + Math.cos(t * .73) * .14, yaw: 32 + Math.sin(t * .61) * 8 };
  const packetTarget = livePacket?.jointsWorld?.find(j => j.name === 'nose')?.position || liveDebug?.positionWorld;
  if (packetTarget) { target.x = packetTarget[0]; target.y = packetTarget[1]; target.z = packetTarget[2]; }
  const packetPhone = liveDebug?.phoneWorld?.position;
  const packetQ = liveDebug?.phoneWorld?.quaternionXyzw;
  if (packetPhone) { phone.x = packetPhone[0]; phone.y = packetPhone[1]; phone.z = packetPhone[2]; }
  if (packetQ) phone.yaw = Math.atan2(2 * (packetQ[3] * packetQ[1] + packetQ[0] * packetQ[2]), 1 - 2 * (packetQ[1] ** 2 + packetQ[2] ** 2)) * 180 / Math.PI;
  const yaw = phone.yaw * Math.PI / 180;
  const dx = target.x - phone.x, dz = target.z - phone.z;
  const relX = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
  const relZ = Math.sin(yaw) * dx + Math.cos(yaw) * dz;
  const distance = Math.hypot(dx, dz);
  $('phonePos').textContent = `${format(phone.x)} · ${format(phone.y)} · ${format(phone.z)}`;
  $('phoneRot').textContent = `0° · ${phone.yaw.toFixed(0)}° · 0°`;
  $('relativePos').textContent = `[${relX.toFixed(1)}, 0.0, ${relZ.toFixed(1)}]`;
  $('worldCoords').textContent = `WORLD [ ${format(target.x)}, ${format(target.y)}, ${format(target.z)} ]`;
  $('targetDistance').textContent = `${distance.toFixed(1)}m · confidence 94%`;
  $('phoneShape').style.transform = `rotate(${phone.yaw - 13}deg)`;
  $('phoneDot').style.left = `${51 + Math.sin(t) * 2.7}%`;
  $('phoneDot').style.top = `${32 - Math.cos(t * .73) * 2.1}%`;
  $('mapTarget').style.left = `${66 + Math.sin(t * .4) * 1.4}%`;
  $('targetMarker').style.left = `${61 + Math.sin(t*.4)*2.2}%`;
  $('targetMarker').style.top = `${34 - Math.cos(t*.5)*1.2}%`;
  $('latency').textContent = `${17 + Math.floor(Math.abs(Math.sin(t*1.2))*5)} ms`;
}
setInterval(update, 300); update();
setInterval(() => { if (!paused) { seconds++; const m = String(Math.floor(seconds / 60)).padStart(2,'0'); const s = String(seconds % 60).padStart(2,'0'); $('uptime').textContent = `00:${m}:${s}`; } }, 1000);
$('pauseButton').addEventListener('click', () => { paused = !paused; $('pauseButton').textContent = paused ? 'Resume' : 'Pause'; $('connectionText').textContent = paused ? 'Tracking paused' : 'Phone connected'; });

// The UI works standalone, then automatically switches to packets from the
// FastAPI hub when the project is running locally.
function connectHub() {
  const socket = new WebSocket('ws://127.0.0.1:8000/ws/viewer');
  socket.onopen = () => { $('connectionText').textContent = 'Laptop calibrated'; socket.send(JSON.stringify({type:'calibration', localPose:{position:[0,0,0], quaternionXyzw:[0,0,0,1]}})); };
  socket.onmessage = (event) => {
    const packet = JSON.parse(event.data);
    if (packet.type === 'skeleton') { livePacket = packet; $('connectionText').textContent = 'Live observer stream'; }
    if (packet.type === 'debug_pose') { liveDebug = packet; $('connectionText').textContent = 'Shared frame live'; }
    if (packet.type === 'target') { liveDebug = packet; $('connectionText').textContent = 'Target transformed to world'; }
  };
  socket.onclose = () => { if (!paused) $('connectionText').textContent = 'Demo telemetry'; setTimeout(connectHub, 2500); };
  socket.onerror = () => socket.close();
}
connectHub();
