import * as THREE from 'three';
import {
  MODE_ORBIT, MODE_FIRST, GRAV_INTERIOR, GRAV_EVA,
  STATION_H, PHYSICS,
  robotState, state, input,
} from './config.js';
import { startAudio, startAmbient } from './audio.js';
import { createRobotMesh, createLabel, updateLabel } from './robot.js';
import { buildEnvironment } from './environment.js';
import { updatePhysics, tryAttachToHull, setMouseLook, getMouseYaw, getMousePitch } from './physics.js';
import { updateHUD } from './hud.js';
import { initTerminal, updateTerminalStation, updateTerminalTick, showTerminal, hideTerminal, isTerminalPanelVisible } from './terminal.js';
import { initVR, showSelectionPanelIfNeeded } from './vr.js';

// ── Renderer ────────────────────────────────────────────────────────────────

const canvas = document.getElementById('scene');
canvas.tabIndex = -1;
canvas.style.outline = 'none';

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050510);
scene.fog = new THREE.Fog(0x050510, 60, 150);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 300);
const cameraRig = new THREE.Group();
cameraRig.add(camera);
scene.add(cameraRig);

// Lights
scene.add(new THREE.AmbientLight(0x8888ff, 0.3));
const sun = new THREE.DirectionalLight(0xccccff, 0.6);
sun.position.set(30, 40, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -50; sun.shadow.camera.right = 50;
sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40;
scene.add(sun);

// ── Build world ─────────────────────────────────────────────────────────────

const termStation = buildEnvironment(scene);
initTerminal(termStation);

// ── VR ──────────────────────────────────────────────────────────────────────

const vr = initVR(renderer, scene, camera, cameraRig, enterFirstPerson);

// ── Input ───────────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = true;
  if (k === ' ') { input.space = true; e.preventDefault(); }
  if (k === 'shift') input.shift = true;
  if (k === 'e') input.e = true;
  if (k === 'escape' && state.viewMode === MODE_FIRST) exitFirstPerson();
  if (k === 'f' && state.viewMode === MODE_FIRST && state.followId && robotState[state.followId]) {
    const m = robotState[state.followId];
    if (m.gravMode === GRAV_EVA) tryAttachToHull(m);
    else if (m.gravMode === 2 /* HULL */) { m.gravMode = GRAV_EVA; m.hullNormal = null; }
  }
  startAudio();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = false;
  if (k === ' ') input.space = false;
  if (k === 'shift') input.shift = false;
  if (k === 'e') input.e = false;
});
window.addEventListener('mousedown', () => { input.click = true; startAudio(); });
window.addEventListener('mouseup', () => { input.click = false; });

// Mouse look
canvas.addEventListener('click', () => {
  if (state.viewMode === MODE_FIRST && !document.pointerLockElement) canvas.requestPointerLock();
  canvas.focus();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas && state.viewMode === MODE_FIRST) {
    let yaw = getMouseYaw() - e.movementX * 0.002;
    let pitch = getMousePitch() - e.movementY * 0.002;
    pitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, pitch));
    setMouseLook(yaw, pitch);
  }
});

// Orbit camera drag
let orbitDragging = false;
const orbitAngle = { theta: Math.PI / 4, phi: Math.PI / 6 };
const orbitDist = 50;

canvas.addEventListener('mousedown', () => { if (state.viewMode === MODE_ORBIT) orbitDragging = true; });
canvas.addEventListener('mouseup', () => { orbitDragging = false; });
canvas.addEventListener('mousemove', (e) => {
  if (orbitDragging && state.viewMode === MODE_ORBIT) {
    orbitAngle.theta += e.movementX * 0.005;
    orbitAngle.phi = Math.max(0.05, Math.min(Math.PI / 2.5, orbitAngle.phi + e.movementY * 0.005));
  }
});

// Click on robots
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
canvas.addEventListener('click', (e) => {
  if (state.viewMode !== MODE_ORBIT) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  for (const [id, m] of Object.entries(robotState)) {
    if (raycaster.intersectObject(m.mesh, true).length > 0) {
      enterFirstPerson(id);
      return;
    }
  }
});

// ── Enter / Exit first person ───────────────────────────────────────────────

function enterFirstPerson(sessionId) {
  try {
    startAudio(); startAmbient();
    state.followId = sessionId;
    state.viewMode = MODE_FIRST;
    setTimeout(() => updateTerminalStation(sessionId), 0);

    const m = robotState[sessionId];
    if (m) {
      m.mesh.visible = false; m.label.visible = false;
      setMouseLook(m.mesh.rotation.y, 0);
    }
    if (!renderer.xr.isPresenting) {
      showTerminal(sessionId);
      canvas.focus();
      onResize();
    }
    refreshHUD();
  } catch (e) {
    console.error('[SpaceStation] enterFirstPerson error:', e);
  }
}

function exitFirstPerson() {
  if (document.pointerLockElement) document.exitPointerLock();
  updateTerminalStation(null);
  if (state.followId && robotState[state.followId]) {
    const m = robotState[state.followId];
    m.mesh.visible = true; m.label.visible = true;
    m.gravMode = GRAV_INTERIOR;
  }
  hideTerminal();
  state.followId = null;
  state.viewMode = MODE_ORBIT;
  if (!renderer.xr.isPresenting) onResize();
  refreshHUD();
  if (renderer.xr.isPresenting) showSelectionPanelIfNeeded(cameraRig);
}

// ── Camera ──────────────────────────────────────────────────────────────────

function updateCamera() {
  if (renderer.xr.isPresenting) {
    if (state.followId && robotState[state.followId]) cameraRig.position.copy(robotState[state.followId].pos);
    return;
  }
  if (state.viewMode === MODE_ORBIT) {
    const cx = orbitDist * Math.cos(orbitAngle.phi) * Math.sin(orbitAngle.theta);
    const cy = orbitDist * Math.sin(orbitAngle.phi) + 5;
    const cz = orbitDist * Math.cos(orbitAngle.phi) * Math.cos(orbitAngle.theta);
    camera.position.set(cx, cy, cz);
    camera.lookAt(0, STATION_H / 2, 0);
    camera.fov = 55; camera.updateProjectionMatrix();
  } else if (state.viewMode === MODE_FIRST && state.followId && robotState[state.followId]) {
    const m = robotState[state.followId];
    camera.position.set(m.pos.x, m.pos.y + 1.6, m.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = getMouseYaw();
    camera.rotation.x = getMousePitch();
    camera.fov = 75; camera.updateProjectionMatrix();
    m.mesh.rotation.y = getMouseYaw();
    m.mesh.visible = false; m.label.visible = false;
  }
}

// ── Resize ──────────────────────────────────────────────────────────────────

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

// ── HUD wrapper ─────────────────────────────────────────────────────────────

const hud = document.getElementById('hud');
function refreshHUD() {
  updateHUD(hud, { enterFirstPerson, exitFirstPerson });
}

// ── Detect mod container hidden ─────────────────────────────────────────────

{
  const modContainer = parent.document.getElementById('mod-container');
  if (modContainer) {
    new MutationObserver(() => {
      if (modContainer.style.display === 'none' && isTerminalPanelVisible()) {
        hideTerminal();
        if (state.viewMode === MODE_FIRST) {
          if (state.followId && robotState[state.followId]) robotState[state.followId].mesh.visible = true;
          state.followId = null; state.viewMode = MODE_ORBIT;
          refreshHUD();
        }
      }
    }).observe(modContainer, { attributes: true, attributeFilter: ['style'] });
  }
}

window.addEventListener('unload', hideTerminal);

// ── Deepsteve bridge ────────────────────────────────────────────────────────

function syncRobots() {
  const liveIds = new Set(state.sessions.map(s => s.id));

  for (const id of Object.keys(robotState)) {
    if (!liveIds.has(id)) {
      scene.remove(robotState[id].mesh);
      scene.remove(robotState[id].label);
      delete robotState[id];
      if (state.followId === id) exitFirstPerson();
    }
  }

  let colorIdx = Object.keys(robotState).length;
  for (const s of state.sessions) {
    if (!robotState[s.id]) {
      const mesh = createRobotMesh(colorIdx);
      scene.add(mesh);
      const label = createLabel(s.name, colorIdx);
      scene.add(label);

      const spawnX = (Math.random() - 0.5) * 30;
      const spawnZ = (Math.random() - 0.5) * 30;

      robotState[s.id] = {
        id: s.id, mesh, label, colorIdx,
        pos: new THREE.Vector3(spawnX, 0, spawnZ),
        vel: new THREE.Vector3(0, 0, 0),
        onGround: false,
        gravMode: GRAV_INTERIOR,
        hullNormal: null,
        fuel: PHYSICS.jetpackFuelMax,
        jetpackActive: false,
        name: s.name,
        aiState: 0, aiTarget: new THREE.Vector3(spawnX, 0, spawnZ),
        aiTimer: Math.random() * 3,
      };
      mesh.position.set(spawnX, 0, spawnZ);
      colorIdx++;
    }

    const m = robotState[s.id];
    if (m.name !== s.name) {
      m.name = s.name;
      updateLabel(m.label._ctx, s.name, m.colorIdx);
      m.label.material.map.needsUpdate = true;
    }
  }
}

{
  let attempts = 0;
  const poll = setInterval(() => {
    if (window.deepsteve) {
      clearInterval(poll);
      window.deepsteve.onSessionsChanged((list) => {
        state.sessions = list;
        syncRobots();
        refreshHUD();
      });
      if (window.deepsteve.onActiveSessionChanged) {
        window.deepsteve.onActiveSessionChanged((id) => {
          if (state.viewMode === MODE_FIRST && state.followId && state.followId !== id) return;
          updateTerminalStation(id);
        });
      }
    } else if (++attempts > 100) clearInterval(poll);
  }, 100);
}

// ── Animation loop ──────────────────────────────────────────────────────────

let prevTime = performance.now();
let hudFrame = 0;

function animate(timestamp) {
  const now = timestamp || performance.now();
  const dt = Math.min((now - prevTime) / 1000, 0.05);
  prevTime = now;

  updatePhysics(dt, now, renderer.xr.isPresenting, vr.updateLocomotion);
  updateCamera();
  updateTerminalTick(renderer);
  vr.updateLasers();

  for (const [id, m] of Object.entries(robotState)) {
    const hidden = state.viewMode === MODE_FIRST && id === state.followId;
    m.mesh.visible = !hidden;
    m.label.visible = !hidden;
  }

  if (++hudFrame % 12 === 0) refreshHUD();

  renderer.render(scene, camera);
}

// ── Start ───────────────────────────────────────────────────────────────────

onResize();
refreshHUD();
renderer.setAnimationLoop(animate);
