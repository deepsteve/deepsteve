import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ── Config ──────────────────────────────────────────────────────────────────

const MONKEY_COLORS = [
  { body: 0x8B4513, accent: 0x654321, hex: '#8B4513' }, // brown
  { body: 0x4a4a4a, accent: 0x333333, hex: '#4a4a4a' }, // dark grey
  { body: 0xd2691e, accent: 0xa0522d, hex: '#d2691e' }, // chocolate
  { body: 0x2f4f2f, accent: 0x1a3a1a, hex: '#2f4f2f' }, // dark green
  { body: 0x800000, accent: 0x5a0000, hex: '#800000' }, // maroon
  { body: 0x556b2f, accent: 0x3b4a1f, hex: '#556b2f' }, // olive
  { body: 0xbc8f5f, accent: 0x8b6d3f, hex: '#bc8f5f' }, // tan
  { body: 0x696969, accent: 0x484848, hex: '#696969' }, // dim grey
];

const MODE_ORBIT = 0;   // Fly around, click a monkey
const MODE_FIRST = 1;   // First-person inside a monkey

const ARENA_SIZE = 40;
const ARENA_HALF = ARENA_SIZE / 2;
const WALL_HEIGHT = 6;

const TAG_COOLDOWN = 3;  // seconds before tag-back allowed

// ── Tunable physics ─────────────────────────────────────────────────────────

const PHYSICS = {
  gravity: 19.6,
  jumpMultiplier: 1.4,
  maxSpeed: 18,
  friction: 0.92,
  bounciness: 0.3,
  tagRadius: 2.5,
};

// ── State ───────────────────────────────────────────────────────────────────

let sessions = [];
let viewMode = MODE_ORBIT;
let followId = null;
let terminalPanelEl = null;
let originalTermParent = null;
let originalTermNext = null;
let itMonkeyId = null;         // who is "it"
let lastTagTime = 0;           // timestamp of last tag
let physPanelOpen = false;

const monkeyState = {};        // id → { mesh, vel, pos, onGround, score, ... }
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

// ── WASD input state ────────────────────────────────────────────────────────

const input = { w: false, a: false, s: false, d: false, space: false, click: false };

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = true;
  if (k === ' ') { input.space = true; e.preventDefault(); }
  if (k === 'escape' && viewMode === MODE_FIRST) exitFirstPerson();
  startAudio();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = false;
  if (k === ' ') input.space = false;
});
window.addEventListener('mousedown', () => { input.click = true; startAudio(); });
window.addEventListener('mouseup', () => { input.click = false; });

// Mouse look (pointer lock)
let mouseYaw = 0, mousePitch = 0;
const canvas = document.getElementById('scene');

canvas.addEventListener('click', () => {
  if (viewMode === MODE_FIRST && !document.pointerLockElement) {
    canvas.requestPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && viewMode === MODE_FIRST) {
    // pointer lock lost — don't exit first person, just stop mouse look
  }
});

document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas && viewMode === MODE_FIRST) {
    mouseYaw -= e.movementX * 0.002;
    mousePitch -= e.movementY * 0.002;
    mousePitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, mousePitch));
  }
});

// ── Audio (procedural) ──────────────────────────────────────────────────────

let audioCtx = null;

function startAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playTag() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(200, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(800, audioCtx.currentTime + 0.1);
  gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.15);
}

function playJump() {
  if (!audioCtx) return;
  const bufSize = audioCtx.sampleRate * 0.15;
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'bandpass'; filter.frequency.value = 800; filter.Q.value = 2;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  src.connect(filter).connect(gain).connect(audioCtx.destination);
  src.start(); src.stop(audioCtx.currentTime + 0.15);
}

function playLand() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 80;
  gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.1);
}

// Ambient jungle sounds
let ambientStarted = false;
function startAmbient() {
  if (ambientStarted || !audioCtx) return;
  ambientStarted = true;

  // Low rumble
  const noise = audioCtx.createBufferSource();
  const noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 4, audioCtx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  noise.buffer = noiseBuf; noise.loop = true;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 200;
  const ng = audioCtx.createGain(); ng.gain.value = 0.015;
  noise.connect(lp).connect(ng).connect(audioCtx.destination);
  noise.start();

  // Periodic bird chirps
  setInterval(() => {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const f = 1200 + Math.random() * 1800;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(f * 0.7, audioCtx.currentTime + 0.12);
    g.gain.setValueAtTime(0.02, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.15);
  }, 3000 + Math.random() * 5000);
}

// ── Three.js setup ──────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 60, 120);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);

// Camera rig for VR — move the rig, camera stays relative inside it
const cameraRig = new THREE.Group();
cameraRig.add(camera);
scene.add(cameraRig);

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

// ── WebXR Controllers ───────────────────────────────────────────────────────

const controllerModelFactory = new XRControllerModelFactory();

const controller0 = renderer.xr.getController(0);
cameraRig.add(controller0);
const controllerGrip0 = renderer.xr.getControllerGrip(0);
controllerGrip0.add(controllerModelFactory.createControllerModel(controllerGrip0));
cameraRig.add(controllerGrip0);

const controller1 = renderer.xr.getController(1);
cameraRig.add(controller1);
const controllerGrip1 = renderer.xr.getControllerGrip(1);
controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
cameraRig.add(controllerGrip1);

// VR velocity tracking — ring buffers for each hand
const VR_VEL_FRAMES = 6;
const vrHands = [
  { controller: controller0, posHistory: new Float32Array(VR_VEL_FRAMES * 3), idx: 0, prevPos: new THREE.Vector3(), vel: new THREE.Vector3(), touching: false },
  { controller: controller1, posHistory: new Float32Array(VR_VEL_FRAMES * 3), idx: 0, prevPos: new THREE.Vector3(), vel: new THREE.Vector3(), touching: false },
];

// Add VR button to the page (only shows if WebXR available)
document.body.appendChild(VRButton.createButton(renderer));

// ── Build arena environment ─────────────────────────────────────────────────

// Collidable surfaces: { min: {x,y,z}, max: {x,y,z} }
const colliders = [];

function addCollider(x, y, z, w, h, d) {
  colliders.push({
    min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 },
    max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 },
  });
}

// Ground
{
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshLambertMaterial({ color: 0x3a7a3a })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);
  addCollider(0, -0.5, 0, 200, 1, 200); // ground collider
}

// Arena floor (slightly darker)
{
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE),
    new THREE.MeshLambertMaterial({ color: 0x358035 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.01;
  floor.receiveShadow = true;
  scene.add(floor);
}

// Walls
{
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x6b6b4b, transparent: true, opacity: 0.3 });
  const wallGeo = new THREE.BoxGeometry(ARENA_SIZE, WALL_HEIGHT, 0.5);
  const sideGeo = new THREE.BoxGeometry(0.5, WALL_HEIGHT, ARENA_SIZE);

  const walls = [
    { geo: wallGeo, pos: [0, WALL_HEIGHT / 2, -ARENA_HALF], col: [0, WALL_HEIGHT / 2, -ARENA_HALF, ARENA_SIZE, WALL_HEIGHT, 0.5] },
    { geo: wallGeo, pos: [0, WALL_HEIGHT / 2, ARENA_HALF], col: [0, WALL_HEIGHT / 2, ARENA_HALF, ARENA_SIZE, WALL_HEIGHT, 0.5] },
    { geo: sideGeo, pos: [-ARENA_HALF, WALL_HEIGHT / 2, 0], col: [-ARENA_HALF, WALL_HEIGHT / 2, 0, 0.5, WALL_HEIGHT, ARENA_SIZE] },
    { geo: sideGeo, pos: [ARENA_HALF, WALL_HEIGHT / 2, 0], col: [ARENA_HALF, WALL_HEIGHT / 2, 0, 0.5, WALL_HEIGHT, ARENA_SIZE] },
  ];

  for (const w of walls) {
    const mesh = new THREE.Mesh(w.geo, wallMat);
    mesh.position.set(...w.pos);
    mesh.receiveShadow = true;
    scene.add(mesh);
    addCollider(...w.col);
  }
}

// Platforms at various heights
const platformDefs = [
  { x: -12, y: 1.5, z: -10, w: 6, d: 6 },
  { x: 10, y: 2.5, z: -12, w: 5, d: 5 },
  { x: 0, y: 3.5, z: 0, w: 7, d: 7 },     // center tall
  { x: -8, y: 2, z: 12, w: 5, d: 4 },
  { x: 14, y: 1, z: 8, w: 6, d: 5 },
  { x: -15, y: 3, z: 2, w: 4, d: 6 },
  { x: 8, y: 4, z: -4, w: 4, d: 4 },       // highest
  { x: -5, y: 1, z: -15, w: 5, d: 4 },
  { x: 16, y: 2, z: -6, w: 4, d: 5 },
  { x: -10, y: 2.5, z: -4, w: 4, d: 4 },
];

{
  const platMat = new THREE.MeshLambertMaterial({ color: 0xa08060 });
  for (const p of platformDefs) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.w, 0.5, p.d), platMat);
    mesh.position.set(p.x, p.y, p.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    addCollider(p.x, p.y, p.z, p.w, 0.5, p.d);
  }
}

// Ramps connecting some platforms
const rampDefs = [
  { from: [-12, 0, -10], to: [-12, 1.5, -10], angle: 0, len: 5 },
  { from: [10, 0, -12], to: [10, 2.5, -12], angle: Math.PI / 4, len: 6 },
  { from: [0, 0, 5], to: [0, 3.5, 0], angle: 0, len: 8 },
  { from: [-8, 0, 15], to: [-8, 2, 12], angle: 0, len: 5 },
  { from: [14, 0, 12], to: [14, 1, 8], angle: 0, len: 6 },
];

{
  const rampMat = new THREE.MeshLambertMaterial({ color: 0x8b7355 });
  for (const r of rampDefs) {
    const h = r.to[1];
    const len = r.len;
    const rampAngle = Math.atan2(h, len);
    const geo = new THREE.BoxGeometry(3, 0.3, len);
    const mesh = new THREE.Mesh(geo, rampMat);
    mesh.position.set(r.from[0], h / 2, (r.from[2] + r.to[2]) / 2);
    mesh.rotation.x = rampAngle;
    mesh.rotation.y = r.angle;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    // Approximate ramp as series of stair-step colliders for simplicity
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const sy = h * t;
      const sz = r.from[2] + (r.to[2] - r.from[2]) * t;
      const sx = r.from[0] + (r.to[0] - r.from[0]) * t;
      addCollider(sx, sy, sz, 3, 0.4, len / steps);
    }
  }
}

// Terminal station (glowing green platform)
{
  const termPlat = new THREE.Mesh(
    new THREE.BoxGeometry(5, 0.3, 5),
    new THREE.MeshPhongMaterial({ color: 0x00cc66, emissive: 0x00cc66, emissiveIntensity: 0.3 })
  );
  termPlat.position.set(0, 0.15, 0);
  scene.add(termPlat);

  // Glowing pillar
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 2, 8),
    new THREE.MeshPhongMaterial({ color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.5 })
  );
  pillar.position.set(0, 1, 0);
  scene.add(pillar);
}

// Trees
function addTree(x, z, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15 * s, 0.2 * s, 1.5 * s, 6),
    new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
  );
  trunk.position.y = 0.75 * s; trunk.castShadow = true; g.add(trunk);
  const foliage = new THREE.Mesh(
    new THREE.ConeGeometry(1.2 * s, 2.5 * s, 6),
    new THREE.MeshLambertMaterial({ color: 0x2a6a2a })
  );
  foliage.position.y = 2.5 * s; foliage.castShadow = true; g.add(foliage);
  g.position.set(x, 0, z); scene.add(g);
  // Tree trunk is collidable
  addCollider(x, 0.75 * s, z, 0.4 * s, 1.5 * s, 0.4 * s);
}

// Place trees around outside arena
[[-25, -18, 1.2], [-28, 8, 0.9], [26, -16, 1.1], [28, 10, 1], [-22, 22, 1.3], [24, 18, 0.8],
 [-18, -22, 1], [22, -20, 0.9], [-24, 12, 1.1], [18, 22, 1.2], [-20, -8, 0.8], [20, 5, 1.1],
 // Some inside arena
 [12, 14, 0.7], [-14, -14, 0.8], [6, -10, 0.6], [-6, 8, 0.7]].forEach(t => addTree(...t));

// ── Box-based monkey model ──────────────────────────────────────────────────

function createMonkeyMesh(colorIdx) {
  const group = new THREE.Group();
  const c = MONKEY_COLORS[colorIdx % MONKEY_COLORS.length];
  const bodyMat = new THREE.MeshPhongMaterial({ color: c.body, shininess: 30 });
  const accentMat = new THREE.MeshPhongMaterial({ color: c.accent, shininess: 20 });
  const faceMat = new THREE.MeshPhongMaterial({ color: 0xdeb887, shininess: 20 }); // face/belly
  const eyeWhite = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 60 });
  const pupilMat = new THREE.MeshPhongMaterial({ color: 0x111111, shininess: 80 });

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 0.5), bodyMat);
  torso.position.y = 0.9; torso.castShadow = true; group.add(torso);

  // Belly patch
  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.05), faceMat);
  belly.position.set(0, 0.85, 0.26); group.add(belly);

  // Head
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.5), bodyMat);
  head.position.set(0, 1.6, 0); head.castShadow = true; group.add(head);
  head.name = 'head';

  // Muzzle
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.25, 0.15), faceMat);
  muzzle.position.set(0, 1.5, 0.3); group.add(muzzle);

  // Eyes
  const eyeGeo = new THREE.BoxGeometry(0.12, 0.14, 0.05);
  const pupilGeo = new THREE.BoxGeometry(0.06, 0.08, 0.03);

  const leftEye = new THREE.Mesh(eyeGeo, eyeWhite);
  leftEye.position.set(-0.15, 1.65, 0.26); group.add(leftEye);
  const leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
  leftPupil.position.set(-0.15, 1.65, 0.29); group.add(leftPupil);

  const rightEye = new THREE.Mesh(eyeGeo, eyeWhite);
  rightEye.position.set(0.15, 1.65, 0.26); group.add(rightEye);
  const rightPupil = new THREE.Mesh(pupilGeo, pupilMat);
  rightPupil.position.set(0.15, 1.65, 0.29); group.add(rightPupil);

  // Upper arms (gorilla-long)
  const armGeo = new THREE.BoxGeometry(0.18, 0.55, 0.18);
  const leftUpperArm = new THREE.Mesh(armGeo, bodyMat);
  leftUpperArm.position.set(-0.5, 0.95, 0); leftUpperArm.castShadow = true; group.add(leftUpperArm);
  leftUpperArm.name = 'leftUpperArm';

  const rightUpperArm = new THREE.Mesh(armGeo, bodyMat);
  rightUpperArm.position.set(0.5, 0.95, 0); rightUpperArm.castShadow = true; group.add(rightUpperArm);
  rightUpperArm.name = 'rightUpperArm';

  // Forearms
  const forearmGeo = new THREE.BoxGeometry(0.15, 0.5, 0.15);
  const leftForearm = new THREE.Mesh(forearmGeo, accentMat);
  leftForearm.position.set(-0.5, 0.45, 0); leftForearm.castShadow = true; group.add(leftForearm);
  leftForearm.name = 'leftForearm';

  const rightForearm = new THREE.Mesh(forearmGeo, accentMat);
  rightForearm.position.set(0.5, 0.45, 0); rightForearm.castShadow = true; group.add(rightForearm);
  rightForearm.name = 'rightForearm';

  // Legs
  const legGeo = new THREE.BoxGeometry(0.2, 0.4, 0.2);
  const leftLeg = new THREE.Mesh(legGeo, accentMat);
  leftLeg.position.set(-0.2, 0.3, 0); leftLeg.castShadow = true; group.add(leftLeg);
  leftLeg.name = 'leftLeg';

  const rightLeg = new THREE.Mesh(legGeo, accentMat);
  rightLeg.position.set(0.2, 0.3, 0); rightLeg.castShadow = true; group.add(rightLeg);
  rightLeg.name = 'rightLeg';

  // Tail — curving sequence of small boxes
  const tailMat = new THREE.MeshPhongMaterial({ color: c.accent, shininess: 15 });
  const tailSegs = 5;
  for (let i = 0; i < tailSegs; i++) {
    const t = i / tailSegs;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.15), tailMat);
    seg.position.set(0, 0.6 + t * 0.3, -0.3 - t * 0.25);
    seg.rotation.x = -t * 0.4;
    seg.name = 'tail' + i;
    group.add(seg);
  }

  // Ground shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 1.0),
    new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.25 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.02, 0);
  shadow.name = 'shadow';
  group.add(shadow);

  return group;
}

// ── Name label sprite ───────────────────────────────────────────────────────

function createLabel(name, colorIdx) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const ctx = c.getContext('2d');
  updateLabel(ctx, name, colorIdx);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(4, 0.75, 1);
  sprite.position.y = 2.2;
  sprite._canvas = c; sprite._ctx = ctx;
  return sprite;
}

function updateLabel(ctx, name, colorIdx, isIt, score) {
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  const display = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
  const hex = MONKEY_COLORS[colorIdx % MONKEY_COLORS.length].hex;
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  const tw = Math.max(display.length * 18 + 30, 80), x = (c.width - tw) / 2;
  roundRect(ctx, x, 10, tw, 44, 12); ctx.fill();
  ctx.strokeStyle = isIt ? '#ff4444' : hex; ctx.lineWidth = 3;
  roundRect(ctx, x, 10, tw, 44, 12); ctx.stroke();
  ctx.fillStyle = isIt ? '#ff4444' : '#fff';
  ctx.font = '22px "Press Start 2P", monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(display, c.width / 2, 32);
  if (isIt) {
    ctx.fillStyle = '#ff4444'; ctx.font = '14px "Press Start 2P", monospace';
    ctx.fillText('IT!', c.width / 2, 72);
  } else if (score > 0) {
    ctx.fillStyle = '#8f8'; ctx.font = '14px "Press Start 2P", monospace';
    ctx.fillText('Tags: ' + score, c.width / 2, 72);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

// ── AABB collision ──────────────────────────────────────────────────────────

const MONKEY_RADIUS = 0.35;
const MONKEY_HEIGHT = 1.8;

function resolveCollisions(pos, vel) {
  // Monkey as AABB
  const mMin = { x: pos.x - MONKEY_RADIUS, y: pos.y, z: pos.z - MONKEY_RADIUS };
  const mMax = { x: pos.x + MONKEY_RADIUS, y: pos.y + MONKEY_HEIGHT, z: pos.z + MONKEY_RADIUS };

  let onGround = false;

  for (const c of colliders) {
    // Check overlap
    if (mMax.x <= c.min.x || mMin.x >= c.max.x) continue;
    if (mMax.y <= c.min.y || mMin.y >= c.max.y) continue;
    if (mMax.z <= c.min.z || mMin.z >= c.max.z) continue;

    // Compute penetration on each axis
    const overlapX = Math.min(mMax.x - c.min.x, c.max.x - mMin.x);
    const overlapY = Math.min(mMax.y - c.min.y, c.max.y - mMin.y);
    const overlapZ = Math.min(mMax.z - c.min.z, c.max.z - mMin.z);

    // Resolve on the axis of smallest overlap
    if (overlapY <= overlapX && overlapY <= overlapZ) {
      if (pos.y + MONKEY_HEIGHT / 2 < (c.min.y + c.max.y) / 2) {
        // Hit ceiling
        pos.y = c.min.y - MONKEY_HEIGHT;
        vel.y = Math.min(vel.y, 0);
      } else {
        // Land on top
        pos.y = c.max.y;
        if (vel.y < -0.5) {
          vel.y = -vel.y * PHYSICS.bounciness;
          if (Math.abs(vel.y) < 1) vel.y = 0;
        } else {
          vel.y = 0;
        }
        onGround = true;
      }
    } else if (overlapX <= overlapZ) {
      if (pos.x < (c.min.x + c.max.x) / 2) {
        pos.x = c.min.x - MONKEY_RADIUS;
      } else {
        pos.x = c.max.x + MONKEY_RADIUS;
      }
      vel.x *= -PHYSICS.bounciness;
    } else {
      if (pos.z < (c.min.z + c.max.z) / 2) {
        pos.z = c.min.z - MONKEY_RADIUS;
      } else {
        pos.z = c.max.z + MONKEY_RADIUS;
      }
      vel.z *= -PHYSICS.bounciness;
    }
  }

  return onGround;
}

// Check if a position is near any surface (for VR hand touch detection)
function isTouchingSurface(worldPos) {
  const margin = 0.15;
  for (const c of colliders) {
    if (worldPos.x >= c.min.x - margin && worldPos.x <= c.max.x + margin &&
        worldPos.y >= c.min.y - margin && worldPos.y <= c.max.y + margin &&
        worldPos.z >= c.min.z - margin && worldPos.z <= c.max.z + margin) {
      return true;
    }
  }
  return false;
}

// ── AI states ───────────────────────────────────────────────────────────────

const AI_IDLE = 0, AI_WANDER = 1, AI_FLEE = 2, AI_CHASE = 3;

function pickWanderTarget(m) {
  m.aiTarget.set(
    (Math.random() - 0.5) * (ARENA_SIZE - 4),
    0,
    (Math.random() - 0.5) * (ARENA_SIZE - 4)
  );
  m.aiTimer = 3 + Math.random() * 4;
}

function updateAI(m, id, dt, now) {
  const sm = {};
  for (const s of sessions) sm[s.id] = s;
  const session = sm[id];
  const isWorking = session && !session.waitingForInput;
  const isIt = id === itMonkeyId;

  // State transitions
  if (isIt) {
    m.aiState = AI_CHASE;
  } else if (itMonkeyId && monkeyState[itMonkeyId]) {
    const itPos = monkeyState[itMonkeyId].pos;
    const dist = _v1.set(itPos.x - m.pos.x, 0, itPos.z - m.pos.z).length();
    if (dist < 8) {
      m.aiState = AI_FLEE;
    } else if (isWorking) {
      m.aiState = AI_WANDER;
    } else {
      m.aiState = AI_IDLE;
    }
  } else if (isWorking) {
    m.aiState = AI_WANDER;
  } else {
    m.aiState = AI_IDLE;
  }

  const speed = isWorking ? 5 : 2;

  switch (m.aiState) {
    case AI_IDLE:
      // Gentle sway, occasional new target
      m.aiTimer -= dt;
      if (m.aiTimer <= 0) pickWanderTarget(m);
      break;

    case AI_WANDER:
      m.aiTimer -= dt;
      if (m.aiTimer <= 0) pickWanderTarget(m);
      _v1.set(m.aiTarget.x - m.pos.x, 0, m.aiTarget.z - m.pos.z);
      if (_v1.length() > 1) {
        _v1.normalize().multiplyScalar(speed);
        m.vel.x += (_v1.x - m.vel.x) * 3 * dt;
        m.vel.z += (_v1.z - m.vel.z) * 3 * dt;
      }
      // Random jumps
      if (m.onGround && Math.random() < 0.01) {
        m.vel.y = 6 + Math.random() * 3;
      }
      break;

    case AI_FLEE: {
      if (!itMonkeyId || !monkeyState[itMonkeyId]) break;
      const itPos = monkeyState[itMonkeyId].pos;
      _v1.set(m.pos.x - itPos.x, 0, m.pos.z - itPos.z);
      if (_v1.length() > 0.1) {
        _v1.normalize().multiplyScalar(speed * 1.3);
        m.vel.x += (_v1.x - m.vel.x) * 4 * dt;
        m.vel.z += (_v1.z - m.vel.z) * 4 * dt;
      }
      // Jump to escape
      if (m.onGround && Math.random() < 0.03) {
        m.vel.y = 7 + Math.random() * 3;
      }
      break;
    }

    case AI_CHASE: {
      // Find nearest non-it monkey
      let nearest = null, bestDist = Infinity;
      for (const [oid, om] of Object.entries(monkeyState)) {
        if (oid === id || oid === itMonkeyId) continue;
        const d = _v1.set(om.pos.x - m.pos.x, 0, om.pos.z - m.pos.z).length();
        if (d < bestDist) { bestDist = d; nearest = om; }
      }
      if (nearest) {
        _v1.set(nearest.pos.x - m.pos.x, 0, nearest.pos.z - m.pos.z);
        if (_v1.length() > 0.1) {
          _v1.normalize().multiplyScalar(speed * 1.2);
          m.vel.x += (_v1.x - m.vel.x) * 4 * dt;
          m.vel.z += (_v1.z - m.vel.z) * 4 * dt;
        }
      }
      // Jump toward target
      if (m.onGround && Math.random() < 0.025) {
        m.vel.y = 6 + Math.random() * 4;
      }
      break;
    }
  }
}

// ── Monkey limb animation ───────────────────────────────────────────────────

function animateMonkey(m, now) {
  const mesh = m.mesh;
  const speed = Math.sqrt(m.vel.x * m.vel.x + m.vel.z * m.vel.z);
  const t = now * 0.003;

  // Walking limb swing
  const walkAmp = Math.min(speed / 8, 1) * 0.4;
  const walkFreq = speed * 0.5;

  for (const child of mesh.children) {
    switch (child.name) {
      case 'leftUpperArm':
        child.rotation.x = Math.sin(t * walkFreq) * walkAmp;
        child.position.y = 0.95;
        break;
      case 'rightUpperArm':
        child.rotation.x = -Math.sin(t * walkFreq) * walkAmp;
        child.position.y = 0.95;
        break;
      case 'leftForearm':
        child.rotation.x = Math.sin(t * walkFreq) * walkAmp * 0.7 - 0.2;
        child.position.y = 0.45;
        break;
      case 'rightForearm':
        child.rotation.x = -Math.sin(t * walkFreq) * walkAmp * 0.7 - 0.2;
        child.position.y = 0.45;
        break;
      case 'leftLeg':
        child.rotation.x = -Math.sin(t * walkFreq) * walkAmp * 0.5;
        break;
      case 'rightLeg':
        child.rotation.x = Math.sin(t * walkFreq) * walkAmp * 0.5;
        break;
      case 'head':
        // Slight bob
        child.position.y = 1.6 + Math.sin(t * 2) * 0.02;
        break;
      case 'shadow':
        // Shadow stays at ground level relative to monkey
        child.position.y = 0.02 - m.pos.y;
        child.material.opacity = Math.max(0.05, 0.25 - m.pos.y * 0.03);
        break;
    }

    // Tail wag
    if (child.name && child.name.startsWith('tail')) {
      const i = parseInt(child.name[4]);
      child.rotation.z = Math.sin(t * 3 + i * 0.6) * 0.15 * (i + 1) / 5;
    }
  }

  // Idle sway when not moving
  if (speed < 0.5) {
    mesh.rotation.z = Math.sin(t * 0.5) * 0.03;
  } else {
    mesh.rotation.z = 0;
  }

  // "It" monkey glows red
  if (m.id === itMonkeyId) {
    // Pulse the body emissive
    const pulse = (Math.sin(now * 0.005) + 1) * 0.5;
    mesh.children[0].material.emissive = mesh.children[0].material.emissive || new THREE.Color();
    mesh.children[0].material.emissive.setRGB(pulse * 0.3, 0, 0);
    mesh.children[0].material.emissiveIntensity = 1;
  } else {
    mesh.children[0].material.emissive = mesh.children[0].material.emissive || new THREE.Color();
    mesh.children[0].material.emissive.setRGB(0, 0, 0);
  }
}

// ── Physics update ──────────────────────────────────────────────────────────

function updatePhysics(dt, now) {
  const isVR = renderer.xr.isPresenting;
  const nowSec = now / 1000;

  for (const [id, m] of Object.entries(monkeyState)) {
    const isPlayer = viewMode === MODE_FIRST && id === followId;

    if (isPlayer) {
      if (isVR) {
        updateVRLocomotion(m, dt);
      } else {
        updateDesktopMovement(m, dt);
      }
    } else {
      updateAI(m, id, dt, now);
    }

    // Gravity
    m.vel.y -= PHYSICS.gravity * dt;

    // Apply velocity
    m.pos.x += m.vel.x * dt;
    m.pos.y += m.vel.y * dt;
    m.pos.z += m.vel.z * dt;

    // Friction (horizontal only)
    if (m.onGround) {
      m.vel.x *= PHYSICS.friction;
      m.vel.z *= PHYSICS.friction;
    } else {
      // Air friction (lighter)
      m.vel.x *= 0.99;
      m.vel.z *= 0.99;
    }

    // Speed cap
    const hSpeed = Math.sqrt(m.vel.x * m.vel.x + m.vel.z * m.vel.z);
    if (hSpeed > PHYSICS.maxSpeed) {
      const scale = PHYSICS.maxSpeed / hSpeed;
      m.vel.x *= scale;
      m.vel.z *= scale;
    }

    // Collision resolution
    const wasOnGround = m.onGround;
    m.onGround = resolveCollisions(m.pos, m.vel);

    // Land sound
    if (!wasOnGround && m.onGround && isPlayer) playLand();

    // Keep in arena bounds
    m.pos.x = Math.max(-ARENA_HALF + 1, Math.min(ARENA_HALF - 1, m.pos.x));
    m.pos.z = Math.max(-ARENA_HALF + 1, Math.min(ARENA_HALF - 1, m.pos.z));

    // Floor clamp
    if (m.pos.y < 0) { m.pos.y = 0; m.vel.y = 0; m.onGround = true; }

    // Update mesh position
    m.mesh.position.copy(m.pos);

    // Face direction of movement (for AI monkeys)
    if (!isPlayer && hSpeed > 0.5) {
      m.mesh.rotation.y = Math.atan2(m.vel.x, m.vel.z);
    }

    // Label follows
    m.label.position.set(m.pos.x, m.pos.y + 2.2, m.pos.z);

    // Animate limbs
    animateMonkey(m, now);
  }

  // Tag detection
  if (itMonkeyId && monkeyState[itMonkeyId] && nowSec - lastTagTime > TAG_COOLDOWN) {
    const itM = monkeyState[itMonkeyId];
    for (const [id, m] of Object.entries(monkeyState)) {
      if (id === itMonkeyId) continue;
      const dist = _v1.set(m.pos.x - itM.pos.x, m.pos.y - itM.pos.y, m.pos.z - itM.pos.z).length();
      if (dist < PHYSICS.tagRadius) {
        // Tag!
        const taggerIsPlayer = itMonkeyId === followId;
        monkeyState[itMonkeyId].score++;
        itMonkeyId = id;
        lastTagTime = nowSec;
        playTag();

        // Update labels
        for (const [lid, lm] of Object.entries(monkeyState)) {
          const sess = sessions.find(s => s.id === lid);
          updateLabel(lm.label._ctx, sess ? sess.name : lid, lm.colorIdx, lid === itMonkeyId, lm.score);
          lm.label.material.map.needsUpdate = true;
        }
        updateHUD();
        showItFlash();
        break;
      }
    }
  }

  // Desktop click-to-tag
  if (viewMode === MODE_FIRST && followId && input.click && followId === itMonkeyId) {
    input.click = false;
    const playerM = monkeyState[followId];
    if (playerM) {
      // Find closest monkey in front of player
      let bestDist = PHYSICS.tagRadius * 1.5;
      let bestId = null;
      const forward = _v2.set(0, 0, -1).applyQuaternion(_q1.setFromEuler(new THREE.Euler(0, mouseYaw, 0)));
      for (const [id, m] of Object.entries(monkeyState)) {
        if (id === followId) continue;
        _v1.set(m.pos.x - playerM.pos.x, m.pos.y - playerM.pos.y, m.pos.z - playerM.pos.z);
        const dist = _v1.length();
        if (dist < bestDist && _v1.normalize().dot(forward) > 0.5) {
          bestDist = dist; bestId = id;
        }
      }
      if (bestId && (performance.now() / 1000) - lastTagTime > TAG_COOLDOWN) {
        monkeyState[followId].score++;
        itMonkeyId = bestId;
        lastTagTime = performance.now() / 1000;
        playTag();
        for (const [lid, lm] of Object.entries(monkeyState)) {
          const sess = sessions.find(s => s.id === lid);
          updateLabel(lm.label._ctx, sess ? sess.name : lid, lm.colorIdx, lid === itMonkeyId, lm.score);
          lm.label.material.map.needsUpdate = true;
        }
        updateHUD();
        showItFlash();
      }
    }
  }
}

// ── Desktop movement ────────────────────────────────────────────────────────

function updateDesktopMovement(m, dt) {
  const forward = _v2.set(0, 0, -1).applyQuaternion(_q1.setFromEuler(new THREE.Euler(0, mouseYaw, 0)));
  const right = _v3.set(forward.z, 0, -forward.x);

  const moveSpeed = 8;
  let moveX = 0, moveZ = 0;
  if (input.w) { moveX += forward.x; moveZ += forward.z; }
  if (input.s) { moveX -= forward.x; moveZ -= forward.z; }
  if (input.a) { moveX -= right.x; moveZ -= right.z; }
  if (input.d) { moveX += right.x; moveZ += right.z; }

  const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
  if (len > 0) {
    moveX /= len; moveZ /= len;
    m.vel.x += (moveX * moveSpeed - m.vel.x) * 5 * dt;
    m.vel.z += (moveZ * moveSpeed - m.vel.z) * 5 * dt;
  }

  // Jump
  if (input.space && m.onGround) {
    m.vel.y = 8 * PHYSICS.jumpMultiplier;
    input.space = false;
    playJump();
  }
}

// ── VR arm-swing locomotion ─────────────────────────────────────────────────

function updateVRLocomotion(m, dt) {
  // Track each hand's velocity and surface contact
  let appliedForce = false;
  for (const hand of vrHands) {
    // Get world position of controller
    hand.controller.getWorldPosition(_v1);

    // Compute velocity from position diff
    _v2.subVectors(_v1, hand.prevPos).divideScalar(dt || 1 / 72);

    // Store in ring buffer
    const base = hand.idx * 3;
    hand.posHistory[base] = _v2.x;
    hand.posHistory[base + 1] = _v2.y;
    hand.posHistory[base + 2] = _v2.z;
    hand.idx = (hand.idx + 1) % VR_VEL_FRAMES;

    // Average velocity from ring buffer
    hand.vel.set(0, 0, 0);
    for (let i = 0; i < VR_VEL_FRAMES; i++) {
      hand.vel.x += hand.posHistory[i * 3];
      hand.vel.y += hand.posHistory[i * 3 + 1];
      hand.vel.z += hand.posHistory[i * 3 + 2];
    }
    hand.vel.divideScalar(VR_VEL_FRAMES);

    // Check if hand is touching a surface
    const touching = isTouchingSurface(_v1);

    if (touching) {
      // Apply inverted velocity as force (gorilla tag mechanic)
      const force = hand.vel.length() * PHYSICS.jumpMultiplier;
      if (force > 0.5) {
        m.vel.x -= hand.vel.x * PHYSICS.jumpMultiplier * 2;
        m.vel.y -= hand.vel.y * PHYSICS.jumpMultiplier * 2;
        m.vel.z -= hand.vel.z * PHYSICS.jumpMultiplier * 2;
        appliedForce = true;
      }
    }

    hand.prevPos.copy(_v1);
  }

  if (appliedForce) playJump();
}

// ── Camera ──────────────────────────────────────────────────────────────────

const orbitAngle = { theta: Math.PI / 4, phi: Math.PI / 6 };
const orbitDist = 35;

function updateCamera() {
  if (renderer.xr.isPresenting) {
    // VR mode: move camera rig to follow player
    if (followId && monkeyState[followId]) {
      const m = monkeyState[followId];
      cameraRig.position.copy(m.pos);
      cameraRig.position.y += 1.5; // eye height
    }
    return;
  }

  if (viewMode === MODE_ORBIT) {
    // Orbit camera looking at arena center
    const cx = orbitDist * Math.cos(orbitAngle.phi) * Math.sin(orbitAngle.theta);
    const cy = orbitDist * Math.sin(orbitAngle.phi) + 5;
    const cz = orbitDist * Math.cos(orbitAngle.phi) * Math.cos(orbitAngle.theta);
    camera.position.set(cx, cy, cz);
    camera.lookAt(0, 2, 0);
    camera.fov = 55;
    camera.updateProjectionMatrix();
  } else if (viewMode === MODE_FIRST && followId && monkeyState[followId]) {
    const m = monkeyState[followId];
    // First-person from monkey head
    const eyePos = _v1.set(m.pos.x, m.pos.y + 1.6, m.pos.z);
    camera.position.copy(eyePos);
    // Apply mouse look
    camera.rotation.order = 'YXZ';
    camera.rotation.y = mouseYaw;
    camera.rotation.x = mousePitch;
    camera.fov = 75;
    camera.updateProjectionMatrix();

    // Update player monkey facing direction
    m.mesh.rotation.y = mouseYaw;

    // Hide player monkey in first person
    m.mesh.visible = false;
    m.label.visible = false;
  }
}

// ── Orbit camera drag ───────────────────────────────────────────────────────

let orbitDragging = false;
canvas.addEventListener('mousedown', (e) => {
  if (viewMode === MODE_ORBIT) { orbitDragging = true; }
});
canvas.addEventListener('mouseup', () => { orbitDragging = false; });
canvas.addEventListener('mousemove', (e) => {
  if (orbitDragging && viewMode === MODE_ORBIT) {
    orbitAngle.theta += e.movementX * 0.005;
    orbitAngle.phi = Math.max(0.05, Math.min(Math.PI / 2.5, orbitAngle.phi + e.movementY * 0.005));
  }
});

// ── Enter / Exit first person ───────────────────────────────────────────────

function enterFirstPerson(sessionId) {
  startAudio();
  startAmbient();
  followId = sessionId;
  viewMode = MODE_FIRST;

  const m = monkeyState[sessionId];
  if (m) {
    m.mesh.visible = false;
    m.label.visible = false;
    mouseYaw = m.mesh.rotation.y;
    mousePitch = 0;
  }

  // If no one is "it" yet, make a random AI monkey "it"
  if (!itMonkeyId) {
    const otherIds = Object.keys(monkeyState).filter(id => id !== sessionId);
    if (otherIds.length > 0) {
      itMonkeyId = otherIds[Math.floor(Math.random() * otherIds.length)];
      lastTagTime = performance.now() / 1000;
      // Update all labels
      for (const [lid, lm] of Object.entries(monkeyState)) {
        const sess = sessions.find(s => s.id === lid);
        updateLabel(lm.label._ctx, sess ? sess.name : lid, lm.colorIdx, lid === itMonkeyId, lm.score);
        lm.label.material.map.needsUpdate = true;
      }
    }
  }

  showTerminal(sessionId);
  onResize();
  updateHUD();
}

function exitFirstPerson() {
  if (document.pointerLockElement) document.exitPointerLock();
  if (followId && monkeyState[followId]) {
    monkeyState[followId].mesh.visible = true;
    monkeyState[followId].label.visible = true;
  }
  hideTerminal();
  followId = null;
  viewMode = MODE_ORBIT;
  onResize();
  updateHUD();
}

// ── Terminal (real xterm.js reparented) ──────────────────────────────────────

function showTerminal(sessionId) {
  hideTerminal();

  const parentDoc = parent.document;
  const termContainer = parentDoc.getElementById('term-' + sessionId);
  if (!termContainer) return;

  originalTermParent = termContainer.parentNode;
  originalTermNext = termContainer.nextSibling;

  terminalPanelEl = parentDoc.createElement('div');
  terminalPanelEl.id = 'monkey-terminal-panel';
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

  const screen = parentDoc.createElement('div');
  screen.id = 'monkey-screen';
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
  const color = monkeyState[sessionId] ? MONKEY_COLORS[monkeyState[sessionId].colorIdx % MONKEY_COLORS.length] : MONKEY_COLORS[0];

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

  const fullBtn = parentDoc.createElement('button');
  fullBtn.textContent = '\u2922';
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

  // Move real terminal in
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

// Detect mod container hidden (user clicked a tab)
{
  const modContainer = parent.document.getElementById('mod-container');
  if (modContainer) {
    const obs = new MutationObserver(() => {
      if (modContainer.style.display === 'none' && terminalPanelEl) {
        hideTerminal();
        if (viewMode === MODE_FIRST) {
          if (followId && monkeyState[followId]) monkeyState[followId].mesh.visible = true;
          followId = null;
          viewMode = MODE_ORBIT;
          updateHUD();
        }
      }
    });
    obs.observe(modContainer, { attributes: true, attributeFilter: ['style'] });
  }
}

// ── Raycaster (click on monkeys) ────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  if (viewMode !== MODE_ORBIT) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  for (const [id, m] of Object.entries(monkeyState)) {
    if (raycaster.intersectObject(m.mesh, true).length > 0) {
      enterFirstPerson(id);
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
let itFlashTimeout = null;

function showItFlash() {
  if (itFlashTimeout) clearTimeout(itFlashTimeout);
  let el = document.getElementById('it-flash');
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'it-flash';
  el.textContent = followId === itMonkeyId ? "YOU'RE IT!" : 'TAGGED!';
  hud.appendChild(el);
  itFlashTimeout = setTimeout(() => { el.remove(); itFlashTimeout = null; }, 500);
}

function updateHUD() {
  let html = '';

  // Header
  html += '<div id="header"><div style="display:flex;align-items:center;gap:12px">';
  html += '<h1>MONKEY CODE</h1>';
  html += `<span class="monkey-count">${Object.keys(monkeyState).length} monkey${Object.keys(monkeyState).length !== 1 ? 's' : ''}</span>`;
  html += '</div><div style="display:flex;align-items:center;gap:10px">';
  if (viewMode === MODE_FIRST) html += '<button id="back-btn" class="hud-btn back">BACK</button>';
  html += '</div></div>';

  // Hint
  if (viewMode === MODE_ORBIT && Object.keys(monkeyState).length > 0) {
    html += '<div id="hint">Click a monkey to become it!</div>';
  }

  // Scoreboard
  if (Object.keys(monkeyState).length > 0) {
    html += '<div id="scoreboard">';
    html += '<div class="title">TAG SCORES</div>';
    const sorted = Object.entries(monkeyState)
      .map(([id, m]) => {
        const sess = sessions.find(s => s.id === id);
        return { id, name: sess ? sess.name : id, score: m.score, isIt: id === itMonkeyId, colorIdx: m.colorIdx };
      })
      .sort((a, b) => b.score - a.score);

    for (let i = 0; i < Math.min(sorted.length, 8); i++) {
      const s = sorted[i];
      const c = MONKEY_COLORS[s.colorIdx % MONKEY_COLORS.length];
      const dn = s.name.length > 12 ? s.name.slice(0, 11) + '\u2026' : s.name;
      const active = s.id === followId ? 'active' : '';
      html += `<div class="row ${active}" data-monkey-id="${s.id}" style="cursor:pointer">`;
      html += `<span class="pos" style="color:${i < 3 ? '#8f8' : '#888'}">#${i + 1}</span>`;
      html += `<div class="dot" style="background:${c.hex}"></div>`;
      html += `<span class="name">${esc(dn)}</span>`;
      if (s.isIt) html += '<span class="it-badge">IT</span>';
      html += `<span class="stat">${s.score}</span></div>`;
    }
    html += '</div>';
  }

  // No sessions
  if (sessions.length === 0) {
    html += '<div id="no-monkeys"><div class="big">NO MONKEYS</div><div class="small">Open some Claude sessions to see them swing around!</div></div>';
  }

  // Controls hint in first person
  if (viewMode === MODE_FIRST) {
    const isIt = followId === itMonkeyId;
    const hint = isIt ? 'Click to tag nearby monkeys!' : 'WASD move / Space jump / ESC back';
    html += `<div id="hint">${hint}</div>`;
  }

  // Physics panel
  html += buildPhysicsPanel();

  hud.innerHTML = html;

  // Bind events
  document.getElementById('back-btn')?.addEventListener('click', exitFirstPerson);
  document.querySelectorAll('[data-monkey-id]').forEach(el => {
    el.addEventListener('click', () => enterFirstPerson(el.dataset.monkeyId));
  });

  // Physics panel toggle
  document.getElementById('phys-toggle')?.addEventListener('click', () => {
    physPanelOpen = !physPanelOpen;
    updateHUD();
  });

  // Physics sliders
  for (const key of Object.keys(PHYSICS)) {
    const slider = document.getElementById('phys-' + key);
    if (slider) {
      slider.addEventListener('input', () => {
        PHYSICS[key] = parseFloat(slider.value);
        const valEl = document.getElementById('phys-val-' + key);
        if (valEl) valEl.textContent = PHYSICS[key].toFixed(1);
      });
    }
  }
}

function buildPhysicsPanel() {
  let html = '<div id="physics-panel">';
  html += `<div class="panel-header" id="phys-toggle"><span>PHYSICS</span><span>${physPanelOpen ? '\u25B2' : '\u25BC'}</span></div>`;
  if (physPanelOpen) {
    html += '<div class="panel-body">';
    const sliders = [
      { key: 'gravity', label: 'Gravity', min: 0, max: 40, step: 0.5 },
      { key: 'jumpMultiplier', label: 'Jump Mult', min: 0.5, max: 5, step: 0.1 },
      { key: 'maxSpeed', label: 'Max Speed', min: 5, max: 40, step: 1 },
      { key: 'friction', label: 'Friction', min: 0.5, max: 1, step: 0.01 },
      { key: 'bounciness', label: 'Bounce', min: 0, max: 1, step: 0.05 },
      { key: 'tagRadius', label: 'Tag Radius', min: 1, max: 6, step: 0.5 },
    ];
    for (const s of sliders) {
      html += '<div class="slider-row">';
      html += `<label>${s.label}</label>`;
      html += `<input type="range" id="phys-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${PHYSICS[s.key]}">`;
      html += `<span class="val" id="phys-val-${s.key}">${PHYSICS[s.key].toFixed(1)}</span>`;
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── Deepsteve bridge ────────────────────────────────────────────────────────

function initBridge() {
  let attempts = 0;
  const poll = setInterval(() => {
    if (window.deepsteve) {
      clearInterval(poll);
      window.deepsteve.onSessionsChanged((list) => {
        sessions = list;
        syncMonkeys();
        updateHUD();
      });
    } else if (++attempts > 100) clearInterval(poll);
  }, 100);
}

function syncMonkeys() {
  const liveIds = new Set(sessions.map(s => s.id));

  // Remove departed monkeys
  for (const id of Object.keys(monkeyState)) {
    if (!liveIds.has(id)) {
      scene.remove(monkeyState[id].mesh);
      scene.remove(monkeyState[id].label);
      if (itMonkeyId === id) itMonkeyId = null;
      delete monkeyState[id];
      if (followId === id) exitFirstPerson();
    }
  }

  // Add new monkeys
  let colorIdx = Object.keys(monkeyState).length;
  for (const s of sessions) {
    if (!monkeyState[s.id]) {
      const mesh = createMonkeyMesh(colorIdx);
      scene.add(mesh);
      const label = createLabel(s.name, colorIdx);
      scene.add(label);

      // Random spawn position
      const spawnX = (Math.random() - 0.5) * (ARENA_SIZE - 8);
      const spawnZ = (Math.random() - 0.5) * (ARENA_SIZE - 8);

      monkeyState[s.id] = {
        id: s.id,
        mesh, label, colorIdx,
        pos: new THREE.Vector3(spawnX, 0, spawnZ),
        vel: new THREE.Vector3(0, 0, 0),
        onGround: false,
        score: 0,
        name: s.name,
        aiState: AI_IDLE,
        aiTarget: new THREE.Vector3(spawnX, 0, spawnZ),
        aiTimer: Math.random() * 3,
      };
      mesh.position.set(spawnX, 0, spawnZ);
      colorIdx++;
    }

    // Update name if changed
    const m = monkeyState[s.id];
    if (m.name !== s.name) {
      m.name = s.name;
      updateLabel(m.label._ctx, s.name, m.colorIdx, s.id === itMonkeyId, m.score);
      m.label.material.map.needsUpdate = true;
    }
  }
}

// ── Animation loop ──────────────────────────────────────────────────────────

let prevTime = performance.now();
let hudThrottleFrame = 0;

function animate(timestamp) {
  const now = timestamp || performance.now();
  const dt = Math.min((now - prevTime) / 1000, 0.05); // cap at 50ms
  prevTime = now;

  updatePhysics(dt, now);
  updateCamera();

  // Show/hide monkeys in first person
  for (const [id, m] of Object.entries(monkeyState)) {
    if (viewMode === MODE_FIRST && id === followId) {
      m.mesh.visible = false;
      m.label.visible = false;
    } else {
      m.mesh.visible = true;
      m.label.visible = true;
    }
  }

  // Throttled HUD update (~5 times/sec)
  hudThrottleFrame++;
  if (hudThrottleFrame % 12 === 0) updateHUD();

  renderer.render(scene, camera);
}

// ── Start ───────────────────────────────────────────────────────────────────

initBridge();
onResize();
updateHUD();

// Use renderer.setAnimationLoop for WebXR compatibility
renderer.setAnimationLoop(animate);
