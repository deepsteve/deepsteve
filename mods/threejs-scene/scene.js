import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Setup ---
const canvas = document.getElementById('scene-canvas');
const overlay = document.getElementById('overlay');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true, // needed for snapshots
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
camera.position.set(5, 4, 5);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Default lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 8, 5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
scene.add(dirLight);

// Grid
const grid = new THREE.GridHelper(20, 20, 0x444466, 0x2a2a44);
scene.add(grid);

// --- Object Registry ---
// id → { object3d, type, animate }
const registry = new Map();

// --- Resize ---
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * devicePixelRatio || canvas.height !== h * devicePixelRatio) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// --- Animation Loop ---
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();

  // Process per-object animations
  for (const [, entry] of registry) {
    if (!entry.animate) continue;
    const a = entry.animate;
    const obj = entry.object3d;
    if (a.rotateX) obj.rotation.x += a.rotateX;
    if (a.rotateY) obj.rotation.y += a.rotateY;
    if (a.rotateZ) obj.rotation.z += a.rotateZ;
    if (a.bobY) {
      const amp = a.bobAmplitude || 0.5;
      const spd = a.bobSpeed || 1;
      obj.position.y = (entry.baseY || 0) + Math.sin(t * spd) * amp;
    }
  }

  resize();
  controls.update();
  renderer.render(scene, camera);
}
animate();

// --- Geometry Builders ---
function buildGeometry(type, geo = {}) {
  switch (type) {
    case 'box':
      return new THREE.BoxGeometry(geo.width || 1, geo.height || 1, geo.depth || 1);
    case 'sphere':
      return new THREE.SphereGeometry(geo.radius || 0.5, geo.widthSegments || 32, geo.heightSegments || 16);
    case 'cylinder':
      return new THREE.CylinderGeometry(geo.radiusTop || 0.5, geo.radiusBottom || 0.5, geo.height || 1, geo.radialSegments || 32);
    case 'cone':
      return new THREE.ConeGeometry(geo.radius || 0.5, geo.height || 1, geo.radialSegments || 32);
    case 'torus':
      return new THREE.TorusGeometry(geo.radius || 0.5, geo.tube || 0.2, geo.radialSegments || 16, geo.tubularSegments || 48);
    case 'plane':
      return new THREE.PlaneGeometry(geo.width || 1, geo.height || 1);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function buildMaterial(mat = {}) {
  const params = {};
  if (mat.color != null) params.color = new THREE.Color(mat.color);
  if (mat.opacity != null) { params.opacity = mat.opacity; params.transparent = true; }
  if (mat.wireframe != null) params.wireframe = mat.wireframe;
  if (mat.metalness != null) params.metalness = mat.metalness;
  if (mat.roughness != null) params.roughness = mat.roughness;
  if (mat.emissive != null) params.emissive = new THREE.Color(mat.emissive);
  if (mat.side === 'double') params.side = THREE.DoubleSide;

  // Use MeshStandardMaterial if metalness/roughness specified, else MeshPhongMaterial
  if (mat.metalness != null || mat.roughness != null) {
    return new THREE.MeshStandardMaterial(params);
  }
  return new THREE.MeshPhongMaterial(params);
}

function applyTransform(obj, op) {
  if (op.position) obj.position.set(...op.position);
  if (op.rotation) obj.rotation.set(...op.rotation);
  if (op.scale) obj.scale.set(...op.scale);
  if (op.visible != null) obj.visible = op.visible;
  if (op.castShadow != null) obj.castShadow = op.castShadow;
  if (op.receiveShadow != null) obj.receiveShadow = op.receiveShadow;
}

// --- Text Sprite (canvas-based) ---
function createTextSprite(textParams = {}) {
  const content = textParams.content || 'Text';
  const fontSize = textParams.fontSize || 48;
  const color = textParams.color || '#ffffff';
  const bgColor = textParams.backgroundColor || null;

  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `${fontSize}px -apple-system, sans-serif`;
  const metrics = ctx.measureText(content);
  const w = Math.ceil(metrics.width) + 20;
  const h = fontSize + 20;
  c.width = w;
  c.height = h;

  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.font = `${fontSize}px -apple-system, sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(content, 10, h / 2);

  const texture = new THREE.CanvasTexture(c);
  texture.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(w / h * 1, 1, 1);
  return sprite;
}

// --- Light Builders ---
function buildLight(type, params = {}) {
  const color = params.color != null ? new THREE.Color(params.color) : 0xffffff;
  const intensity = params.intensity != null ? params.intensity : 1;

  let light;
  switch (type) {
    case 'ambient_light':
      light = new THREE.AmbientLight(color, intensity);
      break;
    case 'directional_light':
      light = new THREE.DirectionalLight(color, intensity);
      if (params.castShadow) {
        light.castShadow = true;
        light.shadow.mapSize.set(1024, 1024);
      }
      break;
    case 'point_light':
      light = new THREE.PointLight(color, intensity, params.distance || 0, params.decay || 2);
      if (params.castShadow) light.castShadow = true;
      break;
    case 'spot_light':
      light = new THREE.SpotLight(color, intensity, params.distance || 0, params.angle || Math.PI / 6, params.penumbra || 0.1, params.decay || 2);
      if (params.castShadow) light.castShadow = true;
      break;
    default:
      light = new THREE.PointLight(color, intensity);
  }
  return light;
}

// --- Line Builder ---
function buildLine(geo = {}, mat = {}) {
  const points = (geo.points || [[0,0,0],[1,1,1]]).map(p => new THREE.Vector3(...p));
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const color = mat.color != null ? new THREE.Color(mat.color) : 0xffffff;
  const material = new THREE.LineBasicMaterial({ color });
  return new THREE.Line(geometry, material);
}

// --- Operation Handlers ---
function handleAdd(op) {
  if (!op.id) return { error: 'add requires an id' };
  if (!op.type) return { error: 'add requires a type' };
  if (registry.has(op.id)) return { error: `object '${op.id}' already exists` };

  const meshTypes = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane'];
  const lightTypes = ['ambient_light', 'directional_light', 'point_light', 'spot_light'];
  let object3d;

  if (meshTypes.includes(op.type)) {
    const geometry = buildGeometry(op.type, op.geometry);
    const material = buildMaterial(op.material);
    object3d = new THREE.Mesh(geometry, material);
  } else if (lightTypes.includes(op.type)) {
    object3d = buildLight(op.type, op.light);
  } else if (op.type === 'line') {
    object3d = buildLine(op.geometry, op.material);
  } else if (op.type === 'group') {
    object3d = new THREE.Group();
  } else if (op.type === 'text') {
    object3d = createTextSprite(op.text);
  } else if (op.type === 'camera') {
    // Camera is special — update the scene camera
    if (op.camera) {
      if (op.camera.fov != null) camera.fov = op.camera.fov;
      if (op.camera.position) camera.position.set(...op.camera.position);
      if (op.camera.lookAt) camera.lookAt(new THREE.Vector3(...op.camera.lookAt));
      camera.updateProjectionMatrix();
    }
    return { ok: true, id: op.id, type: 'camera', note: 'scene camera updated' };
  } else {
    return { error: `unknown type '${op.type}'` };
  }

  applyTransform(object3d, op);

  // Parent to group if specified
  const parent = op.parent && registry.has(op.parent) ? registry.get(op.parent).object3d : scene;
  if (op.parent && !registry.has(op.parent)) {
    return { error: `parent group '${op.parent}' not found` };
  }
  parent.add(object3d);

  const entry = { object3d, type: op.type, animate: op.animate || null };
  if (op.position) entry.baseY = op.position[1];
  registry.set(op.id, entry);

  return { ok: true, id: op.id, type: op.type };
}

function handleUpdate(op) {
  if (!op.id) return { error: 'update requires an id' };

  // Allow updating camera without registry entry
  if (op.id === '__camera__' || op.type === 'camera') {
    if (op.camera) {
      if (op.camera.fov != null) camera.fov = op.camera.fov;
      if (op.camera.position) camera.position.set(...op.camera.position);
      if (op.camera.lookAt) camera.lookAt(new THREE.Vector3(...op.camera.lookAt));
      camera.updateProjectionMatrix();
    }
    if (op.position) camera.position.set(...op.position);
    return { ok: true, id: op.id, type: 'camera' };
  }

  const entry = registry.get(op.id);
  if (!entry) return { error: `object '${op.id}' not found` };

  const obj = entry.object3d;
  applyTransform(obj, op);
  if (op.position) entry.baseY = op.position[1];

  // Update material
  if (op.material && obj.material) {
    const m = op.material;
    if (m.color != null) obj.material.color.set(m.color);
    if (m.opacity != null) { obj.material.opacity = m.opacity; obj.material.transparent = true; }
    if (m.wireframe != null) obj.material.wireframe = m.wireframe;
    if (m.emissive != null && obj.material.emissive) obj.material.emissive.set(m.emissive);
  }

  // Update light properties
  if (op.light) {
    if (op.light.color != null && obj.color) obj.color.set(op.light.color);
    if (op.light.intensity != null) obj.intensity = op.light.intensity;
  }

  // Update text
  if (op.text && entry.type === 'text') {
    const parent = obj.parent;
    parent.remove(obj);
    const newSprite = createTextSprite(op.text);
    applyTransform(newSprite, op);
    parent.add(newSprite);
    entry.object3d = newSprite;
  }

  // Update animation
  if (op.animate !== undefined) {
    entry.animate = op.animate;
  }

  return { ok: true, id: op.id };
}

function handleRemove(op) {
  if (!op.id) return { error: 'remove requires an id' };
  const entry = registry.get(op.id);
  if (!entry) return { error: `object '${op.id}' not found` };

  entry.object3d.parent.remove(entry.object3d);

  // Dispose geometry/material
  const obj = entry.object3d;
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (obj.material.map) obj.material.map.dispose();
    obj.material.dispose();
  }

  registry.delete(op.id);
  return { ok: true, id: op.id };
}

function handleClear() {
  for (const [id, entry] of registry) {
    entry.object3d.parent.remove(entry.object3d);
    const obj = entry.object3d;
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  }
  registry.clear();
  return { ok: true, cleared: true };
}

// --- Query ---
function queryScene(id) {
  if (id) {
    const entry = registry.get(id);
    if (!entry) return { error: `object '${id}' not found` };
    const obj = entry.object3d;
    return {
      id,
      type: entry.type,
      position: [obj.position.x, obj.position.y, obj.position.z],
      rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
      scale: [obj.scale.x, obj.scale.y, obj.scale.z],
      visible: obj.visible,
      animate: entry.animate,
    };
  }

  // Return all objects
  const objects = [];
  for (const [id, entry] of registry) {
    const obj = entry.object3d;
    objects.push({
      id,
      type: entry.type,
      position: [obj.position.x, obj.position.y, obj.position.z],
    });
  }
  return {
    objectCount: objects.length,
    objects,
    camera: {
      position: [camera.position.x, camera.position.y, camera.position.z],
      fov: camera.fov,
    },
  };
}

// --- Snapshot ---
function captureSnapshot(width, height) {
  // If custom dimensions requested, resize temporarily
  const origW = canvas.width;
  const origH = canvas.height;
  let needRestore = false;

  if (width || height) {
    const w = width || canvas.clientWidth;
    const h = height || canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needRestore = true;
  }

  renderer.render(scene, camera);
  const dataUrl = canvas.toDataURL('image/png');

  if (needRestore) {
    renderer.setSize(origW / devicePixelRatio, origH / devicePixelRatio, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }

  return dataUrl;
}

// --- Update overlay ---
function updateOverlay() {
  const count = registry.size;
  overlay.textContent = count > 0 ? `3D Scene (${count} objects)` : '3D Scene';
}

// --- Bridge Callbacks ---
function sendResult(requestId, result) {
  fetch('/api/threejs-scene/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, result }),
  }).catch(err => console.error('Failed to send result:', err));
}

function sendSnapshotResult(requestId, dataUrl) {
  fetch('/api/threejs-scene/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, dataUrl }),
  }).catch(err => console.error('Failed to send snapshot:', err));
}

function sendError(requestId, error) {
  fetch('/api/threejs-scene/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, error }),
  }).catch(err => console.error('Failed to send error:', err));
}

// Wait for bridge API injection, then register callbacks
function waitForBridge() {
  if (!window.deepsteve) {
    setTimeout(waitForBridge, 100);
    return;
  }

  // scene_update
  window.deepsteve.onSceneUpdateRequest((msg) => {
    try {
      const results = [];
      for (const op of (msg.operations || [])) {
        let r;
        switch (op.op) {
          case 'add': r = handleAdd(op); break;
          case 'update': r = handleUpdate(op); break;
          case 'remove': r = handleRemove(op); break;
          case 'clear': r = handleClear(); break;
          default: r = { error: `unknown op '${op.op}'` };
        }
        results.push(r);
      }
      updateOverlay();
      sendResult(msg.requestId, results);
    } catch (err) {
      sendError(msg.requestId, err.message);
    }
  });

  // scene_query
  window.deepsteve.onSceneQueryRequest((msg) => {
    try {
      const result = queryScene(msg.id);
      sendResult(msg.requestId, result);
    } catch (err) {
      sendError(msg.requestId, err.message);
    }
  });

  // scene_snapshot
  window.deepsteve.onSceneSnapshotRequest((msg) => {
    try {
      const dataUrl = captureSnapshot(msg.width, msg.height);
      sendSnapshotResult(msg.requestId, dataUrl);
    } catch (err) {
      sendError(msg.requestId, err.message);
    }
  });
}

waitForBridge();
