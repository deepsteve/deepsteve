import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ROBOT_COLORS, PHYSICS, robotState, state, input } from './config.js';
import { isTouchingSurface } from './physics.js';
import { playBootClank } from './audio.js';

const VR_VEL_FRAMES = 6;

let vrSelectionPanel = null;
let vrSelectionCards = [];
const vrSelectionRaycaster = new THREE.Raycaster();
const _selMat4 = new THREE.Matrix4();

let vrSnapTurnCooldown = false;
let vrJumpedThisPush = [false, false];
let vrThumbstickJumpReady = true;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// ── Setup ───────────────────────────────────────────────────────────────────

export function initVR(renderer, scene, camera, cameraRig, enterFirstPerson) {
  const factory = new XRControllerModelFactory();

  const controller0 = renderer.xr.getController(0);
  cameraRig.add(controller0);
  const grip0 = renderer.xr.getControllerGrip(0);
  grip0.add(factory.createControllerModel(grip0));
  cameraRig.add(grip0);

  const controller1 = renderer.xr.getController(1);
  cameraRig.add(controller1);
  const grip1 = renderer.xr.getControllerGrip(1);
  grip1.add(factory.createControllerModel(grip1));
  cameraRig.add(grip1);

  const vrHands = [
    { controller: controller0, posHistory: new Float32Array(VR_VEL_FRAMES * 3), idx: 0, prevPos: new THREE.Vector3(), vel: new THREE.Vector3() },
    { controller: controller1, posHistory: new Float32Array(VR_VEL_FRAMES * 3), idx: 0, prevPos: new THREE.Vector3(), vel: new THREE.Vector3() },
  ];

  document.body.appendChild(VRButton.createButton(renderer));

  // Laser pointers
  const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)]);
  const laserMat = new THREE.LineBasicMaterial({ color: 0x00ddff, linewidth: 2 });
  const laser0 = new THREE.Line(laserGeo, laserMat); laser0.visible = false; controller0.add(laser0);
  const laser1 = new THREE.Line(laserGeo.clone(), laserMat); laser1.visible = false; controller1.add(laser1);

  // Selection
  controller0.addEventListener('selectstart', () => checkRaycast(controller0, cameraRig, enterFirstPerson));
  controller1.addEventListener('selectstart', () => checkRaycast(controller1, cameraRig, enterFirstPerson));

  renderer.xr.addEventListener('sessionstart', () => {
    if (!state.followId) setTimeout(() => createSelectionPanel(cameraRig), 500);
  });
  renderer.xr.addEventListener('sessionend', () => removeSelectionPanel(cameraRig));

  return {
    vrHands, laser0, laser1, controller0, controller1,
    updateLasers() { const show = vrSelectionPanel !== null; laser0.visible = show; laser1.visible = show; },
    updateLocomotion: (m, dt) => updateVRLocomotion(m, dt, renderer, camera, cameraRig, vrHands),
  };
}

// ── VR Selection Panel ──────────────────────────────────────────────────────

function createSelectionPanel(cameraRig) {
  removeSelectionPanel(cameraRig);
  if (state.sessions.length === 0) return;

  vrSelectionPanel = new THREE.Group();
  vrSelectionCards = [];

  const cols = Math.min(state.sessions.length, 3);
  const rows = Math.ceil(state.sessions.length / cols);
  const cardW = 0.4, cardH = 0.5, gap = 0.08;
  const totalW = cols * cardW + (cols - 1) * gap;
  const totalH = rows * cardH + (rows - 1) * gap;

  // Title
  const titleCanvas = document.createElement('canvas');
  titleCanvas.width = 512; titleCanvas.height = 64;
  const tCtx = titleCanvas.getContext('2d');
  tCtx.fillStyle = 'rgba(0,8,20,0.9)'; tCtx.fillRect(0, 0, 512, 64);
  tCtx.fillStyle = '#00ddff'; tCtx.font = '24px "Press Start 2P", monospace';
  tCtx.textAlign = 'center'; tCtx.textBaseline = 'middle';
  tCtx.fillText('CHOOSE YOUR ROBOT', 256, 32);
  const titleMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(totalW + 0.2, 0.2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(titleCanvas) })
  );
  titleMesh.position.set(0, totalH / 2 + 0.2, 0);
  vrSelectionPanel.add(titleMesh);

  for (let i = 0; i < state.sessions.length; i++) {
    const s = state.sessions[i];
    const col = i % cols, row = Math.floor(i / cols);
    const x = (col - (cols - 1) / 2) * (cardW + gap);
    const y = ((rows - 1) / 2 - row) * (cardH + gap);
    const colorIdx = robotState[s.id] ? robotState[s.id].colorIdx : i;
    const color = ROBOT_COLORS[colorIdx % ROBOT_COLORS.length];

    const cardCanvas = document.createElement('canvas');
    cardCanvas.width = 256; cardCanvas.height = 320;
    const ctx = cardCanvas.getContext('2d');
    ctx.fillStyle = 'rgba(5,5,16,0.9)'; ctx.fillRect(0, 0, 256, 320);
    ctx.strokeStyle = color.hex; ctx.lineWidth = 4; ctx.strokeRect(2, 2, 252, 316);
    ctx.fillStyle = color.hex; ctx.fillRect(78, 80, 100, 90); // head
    ctx.fillStyle = '#00ddff'; ctx.fillRect(88, 110, 80, 25); // visor
    ctx.fillStyle = color.hex; ctx.fillRect(118, 55, 20, 30); // antenna
    const name = s.name.length > 10 ? s.name.slice(0, 9) + '\u2026' : s.name;
    ctx.fillStyle = '#fff'; ctx.font = '18px "Press Start 2P", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(name, 128, 220);
    ctx.fillStyle = '#00ddff'; ctx.font = '14px "Press Start 2P", monospace'; ctx.fillText('SELECT', 128, 280);

    const cardMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(cardW, cardH),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cardCanvas), side: THREE.DoubleSide })
    );
    cardMesh.position.set(x, y, 0);
    vrSelectionPanel.add(cardMesh);
    vrSelectionCards.push({ mesh: cardMesh, sessionId: s.id });
  }

  vrSelectionPanel.position.set(0, 1.5, -2);
  cameraRig.add(vrSelectionPanel);
}

function removeSelectionPanel(cameraRig) {
  if (!vrSelectionPanel) return;
  cameraRig.remove(vrSelectionPanel);
  vrSelectionPanel.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) { if (child.material.map) child.material.map.dispose(); child.material.dispose(); }
  });
  vrSelectionPanel = null; vrSelectionCards = [];
}

function checkRaycast(controller, cameraRig, enterFirstPerson) {
  if (!vrSelectionPanel || vrSelectionCards.length === 0) return;
  _selMat4.identity().extractRotation(controller.matrixWorld);
  vrSelectionRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  vrSelectionRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(_selMat4);
  const hits = vrSelectionRaycaster.intersectObjects(vrSelectionCards.map(c => c.mesh));
  if (hits.length > 0) {
    const card = vrSelectionCards.find(c => c.mesh === hits[0].object);
    if (card) { removeSelectionPanel(cameraRig); enterFirstPerson(card.sessionId); }
  }
}

export function showSelectionPanelIfNeeded(cameraRig) {
  setTimeout(() => createSelectionPanel(cameraRig), 300);
}

// ── VR Locomotion ───────────────────────────────────────────────────────────

function updateVRLocomotion(m, dt, renderer, camera, cameraRig, vrHands) {
  const session = renderer.xr.getSession();

  // Snap turn
  if (session) {
    for (const source of session.inputSources) {
      if (!source.gamepad || source.handedness !== 'right') continue;
      const axes = source.gamepad.axes;
      if (axes.length < 4) continue;
      const stickX = axes[2];
      if (Math.abs(stickX) > 0.6 && !vrSnapTurnCooldown) {
        cameraRig.rotateY(stickX > 0 ? -Math.PI / 6 : Math.PI / 6);
        vrSnapTurnCooldown = true;
      }
      if (Math.abs(stickX) < 0.3) vrSnapTurnCooldown = false;
    }
  }

  // Thumbstick locomotion + jump
  let vrJumpBtnPressed = false;
  if (session) {
    for (const source of session.inputSources) {
      if (!source.gamepad) continue;
      const axes = source.gamepad.axes;
      if (axes.length < 4) continue;
      if (source.handedness === 'left') {
        const stickX = axes[2], stickY = axes[3], deadzone = 0.15, moveSpeed = 6;
        if (Math.abs(stickX) > deadzone || Math.abs(stickY) > deadzone) {
          camera.getWorldDirection(_v1); _v1.y = 0; _v1.normalize();
          _v2.crossVectors(_v1, _v3.set(0, 1, 0)).normalize();
          m.vel.x += ((_v1.x * -stickY + _v2.x * stickX) * moveSpeed - m.vel.x) * 5 * dt;
          m.vel.z += ((_v1.z * -stickY + _v2.z * stickX) * moveSpeed - m.vel.z) * 5 * dt;
        }
      }
      if ((source.gamepad.buttons.length > 4 && source.gamepad.buttons[4].pressed) ||
          (source.gamepad.buttons.length > 3 && source.gamepad.buttons[3].pressed)) {
        vrJumpBtnPressed = true;
      }
    }
  }
  if (vrJumpBtnPressed && m.onGround && vrThumbstickJumpReady) {
    m.vel.y = PHYSICS.jumpForce; playBootClank(); vrThumbstickJumpReady = false;
  } else if (!vrJumpBtnPressed) { vrThumbstickJumpReady = true; }

  // Gorilla Tag arm-swing
  const accelRate = 14;
  let totalPushX = 0, totalPushZ = 0, shouldJump = false, jumpStrength = 0;

  for (let hi = 0; hi < vrHands.length; hi++) {
    const hand = vrHands[hi];
    hand.controller.getWorldPosition(_v1);
    _v2.subVectors(_v1, hand.prevPos).divideScalar(dt || 1 / 72);

    const base = hand.idx * 3;
    hand.posHistory[base] = _v2.x; hand.posHistory[base + 1] = _v2.y; hand.posHistory[base + 2] = _v2.z;
    hand.idx = (hand.idx + 1) % VR_VEL_FRAMES;

    hand.vel.set(0, 0, 0);
    for (let i = 0; i < VR_VEL_FRAMES; i++) {
      hand.vel.x += hand.posHistory[i * 3]; hand.vel.y += hand.posHistory[i * 3 + 1]; hand.vel.z += hand.posHistory[i * 3 + 2];
    }
    hand.vel.divideScalar(VR_VEL_FRAMES);

    const touching = isTouchingSurface(_v1);
    if (touching && hand.vel.length() > 0.8) {
      totalPushX -= hand.vel.x; totalPushZ -= hand.vel.z;
      if (hand.vel.y < -2.0 && m.onGround && !vrJumpedThisPush[hi]) {
        shouldJump = true;
        jumpStrength = Math.max(jumpStrength, Math.min(PHYSICS.jumpForce, -hand.vel.y * 1.2));
        vrJumpedThisPush[hi] = true;
      }
    } else { vrJumpedThisPush[hi] = false; }

    hand.prevPos.copy(_v1);
  }

  if (totalPushX !== 0 || totalPushZ !== 0) {
    m.vel.x += totalPushX * accelRate * dt; m.vel.z += totalPushZ * accelRate * dt;
  }
  if (shouldJump) { m.vel.y = jumpStrength; playBootClank(); }
}
