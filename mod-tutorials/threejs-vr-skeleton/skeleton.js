/**
 * Three.js + WebXR Skeleton for deepsteve mods
 *
 * A minimal starting point for building VR mods. Includes:
 *   - WebGL renderer with XR enabled
 *   - Scene with lighting, ground plane, and a spinning cube
 *   - Camera rig (required pattern for VR locomotion)
 *   - VR controllers with grip models
 *   - VR button for entering immersive mode
 *   - Bridge API integration for deepsteve sessions
 *   - Resize handling and animation loop
 *
 * To use: copy this folder to mods/<your-mod-name>/, rename files,
 * update mod.json, and start building on top of this skeleton.
 */

import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ── Canvas & Renderer ───────────────────────────────────────────────
// Use the canvas element from index.html. Antialiasing and shadow maps
// are optional — enable shadows if your mod needs them.

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;  // Required for WebXR

// ── Scene ───────────────────────────────────────────────────────────
// Background color and fog give a sense of depth. Customize these to
// match your mod's aesthetic.

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);  // Sky blue
scene.fog = new THREE.Fog(0x87ceeb, 60, 120);

// ── Camera & Camera Rig ─────────────────────────────────────────────
// The camera rig is a Group that holds the camera. In VR, the headset
// controls the camera's local transform, so you move the *rig* for
// locomotion (teleport, walk, etc.). Always add VR controllers to the
// rig, not directly to the scene.

const camera = new THREE.PerspectiveCamera(
  70, window.innerWidth / window.innerHeight, 0.1, 200
);
camera.position.set(0, 1.6, 3);  // Eye height, slightly back

const cameraRig = new THREE.Group();
cameraRig.add(camera);
scene.add(cameraRig);

// ── Lighting ────────────────────────────────────────────────────────
// Ambient light for base illumination + directional light for shadows.

const ambient = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(10, 20, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -30;
sun.shadow.camera.right = 30;
sun.shadow.camera.top = 30;
sun.shadow.camera.bottom = -30;
scene.add(sun);

// ── VR Controllers ──────────────────────────────────────────────────
// Two controllers (indices 0 and 1) with grip models that show the
// physical controller meshes. Add event listeners for 'selectstart',
// 'selectend', 'squeezestart', 'squeezeend' to handle input.

const controllerModelFactory = new XRControllerModelFactory();

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  cameraRig.add(controller);

  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModelFactory.createControllerModel(grip));
  cameraRig.add(grip);

  // Example: log when trigger is pressed
  controller.addEventListener('selectstart', () => {
    console.log(`Controller ${i} select`);
  });
}

// ── VR Button ───────────────────────────────────────────────────────
// Adds the "Enter VR" button to the page. Only visible on
// WebXR-capable browsers/devices.

document.body.appendChild(VRButton.createButton(renderer));

// ── Ground Plane ────────────────────────────────────────────────────
// A simple flat ground. Set receiveShadow = true so objects cast
// shadows onto it.

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.MeshStandardMaterial({ color: 0x3a7a3a })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ── Demo Object: Spinning Cube ──────────────────────────────────────
// Replace this with your own objects. This cube just shows the scene
// is working.

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(0.5, 0.5, 0.5),
  new THREE.MeshStandardMaterial({ color: 0xff6600 })
);
cube.position.set(0, 1, 0);
cube.castShadow = true;
scene.add(cube);

// ── Resize Handler ──────────────────────────────────────────────────
// Keep the renderer and camera in sync with the window size.

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
onResize();

// ── Bridge API ──────────────────────────────────────────────────────
// The deepsteve bridge is injected into the mod iframe as
// window.deepsteve. It may not be available immediately, so poll for
// it. Once connected, you can read session data and react to changes.
//
// Available bridge methods:
//   deepsteve.getSessions()          — current session list
//   deepsteve.focusSession(id)       — switch active tab
//   deepsteve.onSessionsChanged(cb)  — subscribe to session updates
//   deepsteve.createSession(opts)    — spawn a new Claude session
//   deepsteve.killSession(id)        — terminate a session
//   deepsteve.getSettings()          — read deepsteve settings
//   deepsteve.onSettingsChanged(cb)  — subscribe to settings changes

let sessions = [];

function initBridge() {
  let attempts = 0;
  const poll = setInterval(() => {
    if (window.deepsteve) {
      clearInterval(poll);
      sessions = window.deepsteve.getSessions();
      window.deepsteve.onSessionsChanged((list) => {
        sessions = list;
        // React to session changes here — e.g. update HUD, spawn objects
      });
      console.log('Bridge connected, sessions:', sessions.length);
    } else if (++attempts > 100) {
      clearInterval(poll);
      console.warn('Bridge not available (running outside deepsteve?)');
    }
  }, 100);
}
initBridge();

// ── Animation Loop ──────────────────────────────────────────────────
// IMPORTANT: Use renderer.setAnimationLoop(), NOT requestAnimationFrame().
// WebXR requires setAnimationLoop to synchronize with the VR display's
// refresh rate. The callback receives a timestamp from the XR device.

let prevTime = performance.now();

function animate(timestamp) {
  const now = timestamp || performance.now();
  const dt = Math.min((now - prevTime) / 1000, 0.05);  // Cap delta to avoid jumps
  prevTime = now;

  // Spin the demo cube
  cube.rotation.x += 0.5 * dt;
  cube.rotation.y += 0.8 * dt;

  // Add your per-frame logic here:
  //   - Update physics
  //   - Move objects
  //   - Handle VR controller input
  //   - Update HUD

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);
