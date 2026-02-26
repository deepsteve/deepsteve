import * as THREE from 'three';

// ── Config ──────────────────────────────────────────────────────────────────

const KART_COLORS = [
  { body: 0xe53935, accent: 0xb71c1c, hex: '#e53935' },
  { body: 0x1e88e5, accent: 0x0d47a1, hex: '#1e88e5' },
  { body: 0xffb300, accent: 0xe65100, hex: '#ffb300' },
  { body: 0x43a047, accent: 0x1b5e20, hex: '#43a047' },
  { body: 0x8e24aa, accent: 0x4a148c, hex: '#8e24aa' },
  { body: 0x00acc1, accent: 0x006064, hex: '#00acc1' },
  { body: 0xf4511e, accent: 0xbf360c, hex: '#f4511e' },
  { body: 0xec407a, accent: 0x880e4f, hex: '#ec407a' },
];

const TRACK_RX = 28;
const TRACK_RZ = 16;
const TRACK_WIDTH = 7;
const TOTAL_LAPS = 3;
const START_ANGLE = Math.PI;

const MODE_GRID = 0;   // Behind the pack, click a kart
const MODE_COCKPIT = 1; // First-person inside the kart

const RACE_IDLE = 0, RACE_COUNTDOWN = 1, RACE_RUNNING = 2, RACE_FINISHED = 3;

// ── State ───────────────────────────────────────────────────────────────────

let sessions = [];
let raceState = RACE_IDLE;
let countdown = 3;
let raceStartTime = 0;
let raceElapsed = 0;
let results = [];
let viewMode = MODE_GRID;
let followId = null;
let terminalPanelEl = null;
let originalTermParent = null;
let originalTermNext = null;

const kartState = {};

// ── WASD input state ─────────────────────────────────────────────────────────

const input = { w: false, a: false, s: false, d: false };

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = true;
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = false;
});

// ── Three.js setup ──────────────────────────────────────────────────────────

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 80, 160);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(20, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 30;
sun.shadow.camera.bottom = -30;
scene.add(sun);

// ── Cockpit geometry (only visible in cockpit mode) ─────────────────────────

const cockpitGroup = new THREE.Group();
cockpitGroup.visible = false;
scene.add(cockpitGroup);

// Steering wheel
{
  const wheelRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.15, 0.02, 8, 24),
    new THREE.MeshPhongMaterial({ color: 0x222222, shininess: 40 })
  );
  wheelRing.rotation.x = -Math.PI * 0.35;
  wheelRing.position.set(0, 0.55, 0.25);
  cockpitGroup.add(wheelRing);

  // Steering column
  const col = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8),
    new THREE.MeshPhongMaterial({ color: 0x333333 })
  );
  col.rotation.x = -Math.PI * 0.35;
  col.position.set(0, 0.42, 0.3);
  cockpitGroup.add(col);

  // Cross-bar
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.015, 0.015),
    new THREE.MeshPhongMaterial({ color: 0x333333 })
  );
  bar.rotation.x = -Math.PI * 0.35;
  bar.position.set(0, 0.55, 0.25);
  cockpitGroup.add(bar);
}

// Dashboard body (dark plastic)
{
  const dash = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.12, 0.5),
    new THREE.MeshPhongMaterial({ color: 0x1a1a1a, shininess: 20 })
  );
  dash.position.set(0, 0.38, 0.35);
  cockpitGroup.add(dash);
}

// Dashboard screen bezel (right side — this is where the terminal goes)
// We use a 3D frame that visually matches where the CSS terminal overlay sits
{
  // Screen frame on the right dashboard
  const bezelMat = new THREE.MeshPhongMaterial({ color: 0x111111, shininess: 30 });

  // Back plate
  const backPlate = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.35, 0.02),
    bezelMat
  );
  backPlate.position.set(0.38, 0.56, 0.28);
  backPlate.rotation.y = -0.2;
  backPlate.rotation.x = -0.15;
  cockpitGroup.add(backPlate);

  // Border strips (top, bottom, left, right)
  const borderMat = new THREE.MeshPhongMaterial({ color: 0x333333, shininess: 40 });
  const borders = [
    { s: [0.52, 0.02, 0.03], p: [0.38, 0.74, 0.27] }, // top
    { s: [0.52, 0.02, 0.03], p: [0.38, 0.39, 0.29] }, // bottom
    { s: [0.02, 0.37, 0.03], p: [0.12, 0.56, 0.28] }, // left
    { s: [0.02, 0.37, 0.03], p: [0.64, 0.56, 0.28] }, // right
  ];
  for (const b of borders) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...b.s), borderMat);
    m.position.set(...b.p);
    m.rotation.y = -0.2;
    m.rotation.x = -0.15;
    cockpitGroup.add(m);
  }
}

// Kart body sides (visible edges of the kart from cockpit)
{
  const sideMat = new THREE.MeshPhongMaterial({ color: 0x444444, shininess: 20 });
  // Left side panel
  const leftPanel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.8), sideMat);
  leftPanel.position.set(-0.6, 0.3, 0.15);
  cockpitGroup.add(leftPanel);
  // Right side panel
  const rightPanel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.8), sideMat);
  rightPanel.position.set(0.6, 0.3, 0.15);
  cockpitGroup.add(rightPanel);
  // Floor
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.03, 0.8), sideMat);
  floor.position.set(0, 0.18, 0.15);
  cockpitGroup.add(floor);
}

// ── Build environment ───────────────────────────────────────────────────────

// Ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshLambertMaterial({ color: 0x3a7a3a })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
ground.receiveShadow = true;
scene.add(ground);

// Track ring
function makeTrackRing() {
  const segs = 80;
  const shape = new THREE.Shape();
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    const fn = i === 0 ? 'moveTo' : 'lineTo';
    shape[fn]((TRACK_RX + TRACK_WIDTH / 2) * Math.cos(t), (TRACK_RZ + TRACK_WIDTH / 2) * Math.sin(t));
  }
  const hole = new THREE.Path();
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    const fn = i === 0 ? 'moveTo' : 'lineTo';
    hole[fn]((TRACK_RX - TRACK_WIDTH / 2) * Math.cos(t), (TRACK_RZ - TRACK_WIDTH / 2) * Math.sin(t));
  }
  shape.holes.push(hole);
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 80), new THREE.MeshLambertMaterial({ color: 0x444444 }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.01;
  mesh.receiveShadow = true;
  return mesh;
}
scene.add(makeTrackRing());

// Inner grass
{
  const segs = 64, irx = TRACK_RX - TRACK_WIDTH / 2 - 0.5, irz = TRACK_RZ - TRACK_WIDTH / 2 - 0.5;
  const shape = new THREE.Shape();
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    shape[i === 0 ? 'moveTo' : 'lineTo'](irx * Math.cos(t), irz * Math.sin(t));
  }
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshLambertMaterial({ color: 0x358035 }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.02; scene.add(m);
}

// Center dashed line
{
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    const t = (i / 200) * Math.PI * 2;
    pts.push(new THREE.Vector3(TRACK_RX * Math.cos(t), 0.03, TRACK_RZ * Math.sin(t)));
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0x999999, dashSize: 0.5, gapSize: 0.5 })
  );
  line.computeLineDistances();
  scene.add(line);
}

// Curbs
{
  const group = new THREE.Group();
  for (let i = 0; i < 60; i++) {
    const t = (i / 60) * Math.PI * 2;
    const r = TRACK_RX - TRACK_WIDTH / 2 + 0.3, rz = TRACK_RZ - TRACK_WIDTH / 2 + 0.3;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.08, 0.5),
      new THREE.MeshLambertMaterial({ color: i % 2 === 0 ? 0xe53935 : 0xffffff })
    );
    m.position.set(r * Math.cos(t), 0.04, rz * Math.sin(t));
    m.rotation.y = -t;
    group.add(m);
  }
  scene.add(group);
}

// Start/finish line
{
  const inner = TRACK_RX - TRACK_WIDTH / 2, n = Math.floor(TRACK_WIDTH / 0.8);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.05, 0.8),
      new THREE.MeshLambertMaterial({ color: i % 2 === 0 ? 0xffffff : 0x111111 })
    );
    m.position.set(-(inner + i * 0.8 + 0.4), 0.03, 0);
    scene.add(m);
  }
}

// Grandstand
{
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(6, 2, 3), new THREE.MeshLambertMaterial({ color: 0xa0845a }));
  base.position.set(0, 1, 0); base.castShadow = true; g.add(base);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(7, 0.3, 3.5), new THREE.MeshLambertMaterial({ color: 0xc0a060 }));
  roof.position.set(0, 2.3, 0); roof.castShadow = true; g.add(roof);
  [0xe53935, 0x1e88e5, 0xffb300, 0x43a047, 0xec407a, 0x8e24aa].forEach((c, i) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), new THREE.MeshLambertMaterial({ color: c }));
    s.position.set(-2.2 + i * 0.9, 2.1, 0.8); g.add(s);
  });
  g.position.set(-(TRACK_RX + TRACK_WIDTH / 2 + 4), 0, 0);
  scene.add(g);
}

// Trees
function addTree(x, z, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15 * s, 0.2 * s, 1.5 * s, 6), new THREE.MeshLambertMaterial({ color: 0x5a3a1a }));
  trunk.position.y = 0.75 * s; trunk.castShadow = true; g.add(trunk);
  const foliage = new THREE.Mesh(new THREE.ConeGeometry(1.2 * s, 2.5 * s, 6), new THREE.MeshLambertMaterial({ color: 0x2a6a2a }));
  foliage.position.y = 2.5 * s; foliage.castShadow = true; g.add(foliage);
  g.position.set(x, 0, z); scene.add(g);
}
[[-38,-8,1.2],[-35,5,0.9],[36,-10,1.1],[38,6,1],[0,-24,1.3],[5,22,0.8],
 [-15,20,1],[20,-22,0.9],[-10,-20,1.1],[15,18,1.2],[-25,-15,0.8],[30,14,1.1]].forEach(t => addTree(...t));

// ── Kart mesh builder ───────────────────────────────────────────────────────

function createKartMesh(colorIdx) {
  const group = new THREE.Group();
  const c = KART_COLORS[colorIdx % KART_COLORS.length];
  const mat = new THREE.MeshPhongMaterial({ color: c.body, shininess: 60 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 0.9), mat);
  body.position.set(0, 0.35, 0); body.castShadow = true; group.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.7), mat);
  nose.position.set(0.9, 0.3, 0); nose.castShadow = true; group.add(nose);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.8), mat);
  spoiler.position.set(-0.85, 0.6, 0); group.add(spoiler);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.9), mat);
  wing.position.set(-0.85, 0.78, 0); group.add(wing);

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 80 }));
  helmet.position.set(0, 0.7, 0); group.add(helmet);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.2), new THREE.MeshPhongMaterial({ color: 0x222222 }));
  visor.position.set(0.2, 0.68, 0); group.add(visor);

  const wg = new THREE.CylinderGeometry(0.18, 0.18, 0.22, 8);
  const wm = new THREE.MeshLambertMaterial({ color: 0x222222 });
  for (const [wx, wy, wz] of [[0.55,0.18,0.55],[0.55,0.18,-0.55],[-0.55,0.18,0.55],[-0.55,0.18,-0.55]]) {
    const w = new THREE.Mesh(wg, wm); w.position.set(wx, wy, wz); w.rotation.x = Math.PI / 2; w.castShadow = true; group.add(w);
  }

  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.0), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.25 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.set(0, 0.02, 0); group.add(shadow);

  return group;
}

// Name label sprite
function createLabel(name, colorIdx) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const ctx = c.getContext('2d');
  updateLabel(ctx, name, colorIdx);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(4, 0.75, 1);
  sprite.position.y = 1.8;
  sprite._canvas = c; sprite._ctx = ctx;
  return sprite;
}

function updateLabel(ctx, name, colorIdx, lap, finished) {
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  const display = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
  const hex = KART_COLORS[colorIdx % KART_COLORS.length].hex;
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  const tw = Math.max(display.length * 18 + 30, 80), x = (c.width - tw) / 2;
  roundRect(ctx, x, 10, tw, 44, 12); ctx.fill();
  ctx.strokeStyle = hex; ctx.lineWidth = 3;
  roundRect(ctx, x, 10, tw, 44, 12); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '22px "Press Start 2P", monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(display, c.width / 2, 32);
  if (lap > 0 && !finished) { ctx.fillStyle = '#ffd700'; ctx.font = '14px "Press Start 2P", monospace'; ctx.fillText(`L${lap}/${TOTAL_LAPS}`, c.width / 2, 72); }
  if (finished) { ctx.fillStyle = '#ffd700'; ctx.font = '16px "Press Start 2P", monospace'; ctx.fillText('\u{1F3C1} FINISHED', c.width / 2, 72); }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

// ── Track helpers ───────────────────────────────────────────────────────────

function trackPos3D(angle, laneOffset = 0) {
  return new THREE.Vector3(
    (TRACK_RX + laneOffset) * Math.cos(angle), 0,
    (TRACK_RZ + laneOffset) * Math.sin(angle)
  );
}

function trackTangent(angle) {
  return new THREE.Vector3(TRACK_RX * Math.sin(angle), 0, -TRACK_RZ * Math.cos(angle)).normalize();
}

// ── Deepsteve bridge ────────────────────────────────────────────────────────

function initBridge() {
  let attempts = 0;
  const poll = setInterval(() => {
    if (window.deepsteve) {
      clearInterval(poll);
      window.deepsteve.onSessionsChanged((list) => {
        sessions = list;
        syncKarts();
        updateHUD();
      });
    } else if (++attempts > 100) clearInterval(poll);
  }, 100);
}

function syncKarts() {
  const liveIds = new Set(sessions.map(s => s.id));
  for (const id of Object.keys(kartState)) {
    if (!liveIds.has(id)) {
      scene.remove(kartState[id].mesh);
      scene.remove(kartState[id].label);
      delete kartState[id];
      if (followId === id) exitCockpit();
    }
  }
  let laneIdx = Object.keys(kartState).length;
  for (const s of sessions) {
    if (!kartState[s.id]) {
      const mesh = createKartMesh(laneIdx);
      scene.add(mesh);
      const label = createLabel(s.name, laneIdx);
      scene.add(label);
      kartState[s.id] = {
        angle: START_ANGLE, speed: 0,
        baseSpeed: 8 + Math.random() * 5,
        wobble: Math.random() * 1000,
        lap: 0, prevAngle: START_ANGLE,
        finished: false, finishTime: null,
        lane: laneIdx, mesh, label, name: s.name,
      };
      laneIdx++;
    }
    const k = kartState[s.id];
    if (k.name !== s.name) {
      k.name = s.name;
      updateLabel(k.label._ctx, s.name, k.lane, k.lap, k.finished);
      k.label.material.map.needsUpdate = true;
    }
  }
}

// ── Camera ──────────────────────────────────────────────────────────────────

const cockpitCamPos = new THREE.Vector3();
const cockpitCamLook = new THREE.Vector3();

function updateCamera() {
  if (viewMode === MODE_GRID) {
    // Behind the pack at start line
    const startPos = trackPos3D(START_ANGLE, 0);
    const behind = trackTangent(START_ANGLE).multiplyScalar(-12);
    camera.position.set(startPos.x + behind.x, 5, startPos.z + behind.z + 2);
    camera.lookAt(startPos.x, 1, startPos.z);
    camera.fov = 55;
    camera.updateProjectionMatrix();
  } else if (viewMode === MODE_COCKPIT && followId && kartState[followId]) {
    const k = kartState[followId];
    const kartCount = Object.keys(kartState).length;
    const laneOffset = k.laneOffset != null ? k.laneOffset : (k.lane - (kartCount - 1) / 2) * 1.2;
    const pos = trackPos3D(k.angle, laneOffset);
    const tangent = trackTangent(k.angle);

    // First-person: driver's eye position (slightly above and behind center of kart)
    const targetPos = new THREE.Vector3(
      pos.x - tangent.x * 0.1,
      0.9,
      pos.z - tangent.z * 0.1
    );

    // Look ahead along the track
    const targetLook = new THREE.Vector3(
      pos.x + tangent.x * 8,
      0.7,
      pos.z + tangent.z * 8
    );

    // Smooth follow
    cockpitCamPos.lerp(targetPos, 0.12);
    cockpitCamLook.lerp(targetLook, 0.08);
    camera.position.copy(cockpitCamPos);
    camera.lookAt(cockpitCamLook);

    // Wider FOV for cockpit immersion
    camera.fov = 75;
    camera.updateProjectionMatrix();

    // Position cockpit geometry relative to camera
    cockpitGroup.position.copy(camera.position);
    cockpitGroup.quaternion.copy(camera.quaternion);
  }
}

// ── Cockpit mode ────────────────────────────────────────────────────────────

function enterCockpit(sessionId) {
  followId = sessionId;
  viewMode = MODE_COCKPIT;

  // Initialize player lane offset from current lane position
  const k = kartState[sessionId];
  if (k) {
    const kartCount = Object.keys(kartState).length;
    k.laneOffset = (k.lane - (kartCount - 1) / 2) * 1.2;
  }
  if (k) {
    const kartCount = Object.keys(kartState).length;
    const laneOffset = (k.lane - (kartCount - 1) / 2) * 1.2;
    const pos = trackPos3D(k.angle, laneOffset);
    const tangent = trackTangent(k.angle);
    cockpitCamPos.set(pos.x - tangent.x * 0.1, 0.9, pos.z - tangent.z * 0.1);
    cockpitCamLook.set(pos.x + tangent.x * 8, 0.7, pos.z + tangent.z * 8);
  }

  // Hide the followed kart's mesh (we're inside it)
  if (k) k.mesh.visible = false;

  cockpitGroup.visible = true;
  showTerminal(sessionId);
  onResize();
  updateHUD();
}

function exitCockpit() {
  if (followId && kartState[followId]) {
    kartState[followId].mesh.visible = true;
    delete kartState[followId].laneOffset;
  }
  cockpitGroup.visible = false;
  hideTerminal();
  followId = null;
  viewMode = MODE_GRID;
  onResize();
  updateHUD();
}

// ── Terminal (mounted inside the cockpit) ───────────────────────────────────
// The terminal is the real xterm DOM element from the parent document,
// positioned as a fixed overlay on the right side with CSS 3D perspective
// to look like a screen mounted on the kart's dashboard.

function showTerminal(sessionId) {
  hideTerminal();

  const parentDoc = parent.document;
  const termContainer = parentDoc.getElementById('term-' + sessionId);
  if (!termContainer) return;

  originalTermParent = termContainer.parentNode;
  originalTermNext = termContainer.nextSibling;

  // Create the dashboard-mounted screen in the parent document
  terminalPanelEl = parentDoc.createElement('div');
  terminalPanelEl.id = 'gokart-terminal-panel';
  terminalPanelEl.style.cssText = `
    position: fixed;
    bottom: 30px;
    right: 30px;
    width: 42%;
    height: 55%;
    z-index: 999;
    perspective: 800px;
    pointer-events: none;
  `;

  // The screen itself with 3D tilt to look like a dashboard-mounted display
  const screen = parentDoc.createElement('div');
  screen.id = 'gokart-screen';
  screen.style.cssText = `
    width: 100%;
    height: 100%;
    transform: rotateY(-8deg) rotateX(2deg);
    transform-origin: right center;
    border-radius: 8px;
    overflow: hidden;
    box-shadow:
      0 0 30px rgba(0, 200, 100, 0.15),
      0 0 60px rgba(0, 200, 100, 0.05),
      inset 0 0 1px rgba(255,255,255,0.1);
    border: 3px solid #333;
    display: flex;
    flex-direction: column;
    background: #0d1117;
    pointer-events: auto;
  `;
  terminalPanelEl.appendChild(screen);

  // Header bar
  const header = parentDoc.createElement('div');
  header.style.cssText = `
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 10px; background: #161b22; border-bottom: 1px solid #333;
    font-family: 'Press Start 2P', monospace; flex-shrink: 0;
  `;

  const session = sessions.find(s => s.id === sessionId);
  const color = kartState[sessionId] ? KART_COLORS[kartState[sessionId].lane % KART_COLORS.length] : KART_COLORS[0];

  const nameRow = parentDoc.createElement('div');
  nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

  const dot = parentDoc.createElement('div');
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${color.hex};box-shadow:0 0 6px ${color.hex};`;
  nameRow.appendChild(dot);

  const nameSpan = parentDoc.createElement('span');
  nameSpan.textContent = session ? session.name : sessionId;
  nameSpan.style.cssText = 'font-size:8px;color:#aaa;';
  nameRow.appendChild(nameSpan);
  header.appendChild(nameRow);

  const btnGroup = parentDoc.createElement('div');
  btnGroup.style.cssText = 'display:flex;gap:6px;';

  // Fullscreen button
  const fullBtn = parentDoc.createElement('button');
  fullBtn.textContent = '\u2922'; // expand icon
  fullBtn.title = 'Open terminal fullscreen';
  fullBtn.style.cssText = `
    background:transparent; border:1px solid #444; border-radius:3px;
    color:#8b949e; font-size:12px; padding:2px 6px; cursor:pointer;
    line-height:1;
  `;
  fullBtn.addEventListener('click', () => {
    if (window.deepsteve) window.deepsteve.focusSession(sessionId);
  });
  btnGroup.appendChild(fullBtn);
  header.appendChild(btnGroup);
  screen.appendChild(header);

  // Terminal wrapper
  const termWrapper = parentDoc.createElement('div');
  termWrapper.style.cssText = 'flex:1;overflow:hidden;';
  screen.appendChild(termWrapper);

  // Move the real terminal in
  termContainer.style.display = '';
  termContainer.classList.add('active');
  termWrapper.appendChild(termContainer);

  parentDoc.body.appendChild(terminalPanelEl);

  // Refit
  requestAnimationFrame(() => {
    if (parent.window.__deepsteve) parent.window.__deepsteve.fitSession(sessionId);
  });
}

function hideTerminal() {
  if (!terminalPanelEl) return;

  const termContainer = terminalPanelEl.querySelector('.terminal-container');
  if (termContainer && originalTermParent) {
    termContainer.classList.remove('active');
    if (originalTermNext) originalTermParent.insertBefore(termContainer, originalTermNext);
    else originalTermParent.appendChild(termContainer);
    const id = termContainer.id.replace('term-', '');
    requestAnimationFrame(() => {
      if (parent.window.__deepsteve) parent.window.__deepsteve.fitSession(id);
    });
  }

  terminalPanelEl.remove();
  terminalPanelEl = null;
  originalTermParent = null;
  originalTermNext = null;
}

window.addEventListener('unload', hideTerminal);

// Detect when mod container gets hidden (user clicked a tab directly)
{
  const modContainer = parent.document.getElementById('mod-container');
  if (modContainer) {
    const obs = new MutationObserver(() => {
      if (modContainer.style.display === 'none' && terminalPanelEl) {
        hideTerminal();
        if (viewMode === MODE_COCKPIT) {
          if (followId && kartState[followId]) kartState[followId].mesh.visible = true;
          cockpitGroup.visible = false;
          followId = null;
          viewMode = MODE_GRID;
          updateHUD();
        }
      }
    });
    obs.observe(modContainer, { attributes: true, attributeFilter: ['style'] });
  }
}

// ── Race control ────────────────────────────────────────────────────────────

function startRace() {
  if (sessions.length === 0) return;
  sessions.forEach((s, i) => {
    const k = kartState[s.id];
    if (!k) return;
    Object.assign(k, {
      angle: START_ANGLE + i * 0.06, speed: 0,
      baseSpeed: 8 + Math.random() * 5, wobble: Math.random() * 1000,
      workingMult: 1.15 + Math.random() * 0.10,
      lap: 0, prevAngle: START_ANGLE + i * 0.06,
      finished: false, finishTime: null, lane: i,
    });
    // Re-init lane offset if player is in this kart
    if (viewMode === MODE_COCKPIT && followId === s.id) {
      const kartCount = sessions.length;
      k.laneOffset = (i - (kartCount - 1) / 2) * 1.2;
      k.mesh.visible = false;
    }
  });
  results = []; raceElapsed = 0;
  raceState = RACE_COUNTDOWN; countdown = 3;
  updateHUD();

  let c = 3;
  const iv = setInterval(() => {
    if (--c > 0) { countdown = c; updateHUD(); }
    else { clearInterval(iv); countdown = 0; raceState = RACE_RUNNING; raceStartTime = performance.now(); updateHUD(); }
  }, 1000);
}

// ── Physics ─────────────────────────────────────────────────────────────────

function updatePhysics(now, dt) {
  if (raceState !== RACE_RUNNING) return;
  raceElapsed = (now - raceStartTime) / 1000;
  let allFinished = true;
  const finishOrder = [];
  const sm = {}; for (const s of sessions) sm[s.id] = s;

  for (const [id, k] of Object.entries(kartState)) {
    if (k.finished) { finishOrder.push({ id, time: k.finishTime }); continue; }
    allFinished = false;

    const isPlayer = viewMode === MODE_COCKPIT && id === followId;
    if (isPlayer) {
      // WASD: W = gas, S = brake, A/D = steer (adjust lane offset)
      const gas = input.w ? 1 : 0;
      const brake = input.s ? 1 : 0;
      const targetSpeed = k.baseSpeed * (0.3 + gas * 0.9) * (1 - brake * 0.7);
      k.speed += (targetSpeed - k.speed) * 4 * dt;
      if (input.a) k.laneOffset = (k.laneOffset || 0) - 3.0 * dt;
      if (input.d) k.laneOffset = (k.laneOffset || 0) + 3.0 * dt;
      const maxOff = TRACK_WIDTH / 2 - 0.5;
      k.laneOffset = Math.max(-maxOff, Math.min(maxOff, k.laneOffset || 0));
    } else {
      const working = sm[id] && !sm[id].waitingForInput;
      const mult = working ? (k.workingMult || 1.2) : 0.9;
      const wobble = Math.sin(now / 600 + k.wobble) * 0.5;
      k.speed += (k.baseSpeed * mult + wobble - k.speed) * 3 * dt;
    }

    const prev = k.angle;
    k.angle -= k.speed * dt * 0.02;
    while (k.angle < -Math.PI) k.angle += 2 * Math.PI;
    while (k.angle > Math.PI) k.angle -= 2 * Math.PI;
    if (prev < -Math.PI * 0.8 && k.angle > Math.PI * 0.8) {
      k.lap++;
      if (k.lap >= TOTAL_LAPS) { k.finished = true; k.finishTime = raceElapsed; finishOrder.push({ id, time: raceElapsed }); }
    }
  }

  if (allFinished || finishOrder.length === Object.keys(kartState).length) {
    finishOrder.sort((a, b) => a.time - b.time);
    results = finishOrder.map((f, i) => ({ id: f.id, name: sm[f.id]?.name || '???', time: f.time, position: i + 1 }));
    raceState = RACE_FINISHED;
    updateHUD();
  }
}

// ── Animation loop ──────────────────────────────────────────────────────────

let lastTime = 0;

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - (lastTime || now)) / 1000, 0.05);
  lastTime = now;

  updatePhysics(now, dt);

  const kartCount = Object.keys(kartState).length;
  for (const [id, k] of Object.entries(kartState)) {
    const isPlayer = viewMode === MODE_COCKPIT && id === followId;
    const laneOffset = isPlayer && k.laneOffset != null ? k.laneOffset : (k.lane - (kartCount - 1) / 2) * 1.2;
    const pos = trackPos3D(k.angle, laneOffset);
    k.mesh.position.copy(pos);
    const tan = trackTangent(k.angle);
    k.mesh.rotation.y = Math.atan2(-tan.z, tan.x);
    k.label.position.set(pos.x, 1.8, pos.z);
    updateLabel(k.label._ctx, k.name, k.lane, k.lap, k.finished);
    k.label.material.map.needsUpdate = true;
    // In cockpit mode: hide the followed kart, show all others
    k.mesh.visible = !(viewMode === MODE_COCKPIT && id === followId);
    k.label.visible = !(viewMode === MODE_COCKPIT && id === followId);
  }

  updateCamera();

  if (raceState === RACE_RUNNING && Math.floor(now / 200) !== Math.floor((now - 16) / 200)) {
    updateHUD();
  }

  renderer.render(scene, camera);
}

// ── Raycaster ───────────────────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  if (viewMode === MODE_COCKPIT) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  for (const [id, k] of Object.entries(kartState)) {
    if (raycaster.intersectObject(k.mesh, true).length > 0) {
      enterCockpit(id);
      return;
    }
  }
});

// ── Resize ──────────────────────────────────────────────────────────────────

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

// ── HUD ─────────────────────────────────────────────────────────────────────

const hud = document.getElementById('hud');

function updateHUD() {
  let html = '';

  // Header
  html += '<div id="header"><div style="display:flex;align-items:center">';
  html += '<h1>DEEPSTEVE GP</h1>';
  if (raceState === RACE_RUNNING) html += `<span class="timer">${raceElapsed.toFixed(1)}s</span>`;
  html += '</div><div style="display:flex;align-items:center;gap:10px">';
  if (viewMode === MODE_COCKPIT) html += '<button id="back-btn" class="hud-btn back">BACK</button>';
  if (sessions.length > 0 && raceState !== RACE_RUNNING && raceState !== RACE_COUNTDOWN) {
    const cls = raceState === RACE_FINISHED ? 'rematch' : 'start';
    html += `<button id="start-btn" class="hud-btn ${cls}">${raceState === RACE_FINISHED ? 'REMATCH' : 'START RACE'}</button>`;
  }
  html += `<span class="racers">${sessions.length} racer${sessions.length !== 1 ? 's' : ''}</span>`;
  html += '</div></div>';

  // Hint
  if (viewMode === MODE_GRID && sessions.length > 0 && raceState === RACE_IDLE) {
    html += '<div id="hint">Click a kart to get in!</div>';
  }

  // Countdown
  if (raceState === RACE_COUNTDOWN) {
    html += `<div id="countdown-overlay"><div class="num" style="color:${countdown <= 1 ? '#e53935' : '#ffd700'}">${countdown}</div></div>`;
  }

  // GO
  if (raceState === RACE_RUNNING && raceElapsed < 1) {
    html += `<div id="countdown-overlay" style="background:transparent;pointer-events:none"><div class="num" style="color:#43a047;opacity:${Math.max(0, 1 - raceElapsed)}">GO!</div></div>`;
  }

  // Leaderboard
  if (raceState === RACE_RUNNING || raceState === RACE_FINISHED) {
    html += '<div id="leaderboard">';
    html += `<div class="title">${raceState === RACE_FINISHED ? 'FINAL RESULTS' : `LAP ${currentMaxLap()} / ${TOTAL_LAPS}`}</div>`;
    html += buildLeaderboardHTML();
    html += '</div>';
  }

  // No sessions
  if (sessions.length === 0) html += '<div id="no-racers"><div class="big">NO RACERS</div><div class="small">Open some Claude sessions to see them on the track!</div></div>';

  // Winner
  if (raceState === RACE_FINISHED && results.length > 0) {
    const wn = results[0].name.length > 12 ? results[0].name.slice(0, 11) + '\u2026' : results[0].name;
    html += `<div id="winner-overlay"><div class="winner-name">${esc(wn)}</div><div class="wins">WINS!</div><div class="time">${results[0].time.toFixed(2)}s</div></div>`;
  }

  // Cockpit: lap display (bottom-left)
  if (viewMode === MODE_COCKPIT && followId && kartState[followId]) {
    const k = kartState[followId];
    if (raceState === RACE_RUNNING && !k.finished) {
      html += `<div id="cockpit-hud">`;
      html += `<div class="lap-display">LAP <span style="color:#ffd700">${k.lap + 1}</span>/${TOTAL_LAPS}</div>`;
      html += `</div>`;
    }
  }

  hud.innerHTML = html;

  document.getElementById('start-btn')?.addEventListener('click', startRace);
  document.getElementById('back-btn')?.addEventListener('click', exitCockpit);
  document.querySelectorAll('[data-chase-id]').forEach(el => {
    el.addEventListener('click', () => enterCockpit(el.dataset.chaseId));
  });
}

function currentMaxLap() {
  let m = 0;
  for (const k of Object.values(kartState)) m = Math.max(m, k.lap + 1);
  return Math.min(m, TOTAL_LAPS);
}

function buildLeaderboardHTML() {
  const standings = getStandings();
  const medals = ['', '\u{1F947}', '\u{1F948}', '\u{1F949}'];
  let html = '';
  for (let i = 0; i < Math.min(standings.length, 8); i++) {
    const s = standings[i];
    const c = KART_COLORS[(kartState[s.id]?.lane || i) % KART_COLORS.length];
    const pos = raceState === RACE_FINISHED && i < 3 ? medals[i + 1] : `P${i + 1}`;
    const dn = s.name.length > 12 ? s.name.slice(0, 11) + '\u2026' : s.name;
    const active = s.id === followId ? 'active' : '';
    html += `<div class="row ${active}" data-chase-id="${s.id}" style="cursor:pointer">`;
    html += `<span class="pos" style="color:${i < 3 ? '#ffd700' : '#888'}">${pos}</span>`;
    html += `<div class="dot" style="background:${c.hex}"></div>`;
    html += `<span class="name">${esc(dn)}</span>`;
    html += `<span class="stat">${s.finished ? s.finishTime.toFixed(1) + 's' : 'L' + (s.lap + 1)}</span></div>`;
  }
  return html;
}

function getStandings() {
  if (raceState === RACE_FINISHED && results.length > 0) {
    return results.map(r => ({ id: r.id, name: r.name, lap: TOTAL_LAPS - 1, finished: true, finishTime: r.time }));
  }
  const sm = {}; for (const s of sessions) sm[s.id] = s;
  return Object.entries(kartState)
    .map(([id, k]) => ({ id, name: sm[id]?.name || '???', lap: k.lap, progress: k.lap + (START_ANGLE - k.angle + Math.PI) / (2 * Math.PI), finished: k.finished, finishTime: k.finishTime }))
    .sort((a, b) => { if (a.finished !== b.finished) return a.finished ? -1 : 1; if (a.finished && b.finished) return a.finishTime - b.finishTime; return b.progress - a.progress; });
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── Start ───────────────────────────────────────────────────────────────────

initBridge();
onResize();
updateHUD();
requestAnimationFrame(animate);
