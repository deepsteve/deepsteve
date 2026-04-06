import * as THREE from 'three';
import { STATION_W, STATION_H, STATION_D, STATION_HALF_W, STATION_HALF_D, DOOR_AUTO_CLOSE } from './config.js';
import { playDoorOpen, playAirlockCycle } from './audio.js';

// ── Collider registry ───────────────────────────────────────────────────────

export const colliders = [];

function addCollider(x, y, z, w, h, d, isHull = false) {
  colliders.push({
    min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 },
    max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 },
    isHull,
  });
}

// ── Door registry ───────────────────────────────────────────────────────────

export const doors = [];

function createDoor(scene, x, y, z, w, h, d, slideDir, slideAmount, isAirlock = false) {
  const doorMat = new THREE.MeshPhongMaterial({ color: 0x3a3a4e, shininess: 50 });
  const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), doorMat);
  doorMesh.position.set(x, y, z);
  doorMesh.castShadow = true;
  scene.add(doorMesh);

  // Accent strip
  const accentMat = new THREE.MeshPhongMaterial({ color: 0x00ddff, emissive: 0x00ddff, emissiveIntensity: 0.3 });
  const stripSize = slideDir === 'x' ? [0.05, h * 0.8, d] : [w, h * 0.8, 0.05];
  const strip = new THREE.Mesh(new THREE.BoxGeometry(...stripSize), accentMat);
  doorMesh.add(strip);

  const closedPos = new THREE.Vector3(x, y, z);
  const openPos = closedPos.clone();
  if (slideDir === 'x') openPos.x += slideAmount;
  else if (slideDir === 'y') openPos.y += slideAmount;
  else openPos.z += slideAmount;

  const door = {
    mesh: doorMesh, closedPos: closedPos.clone(), openPos: openPos.clone(),
    isOpen: false, timer: 0, isAirlock, transitioning: false,
    colliderIdx: colliders.length,
  };
  addCollider(x, y, z, w, h, d);
  doors.push(door);
  return door;
}

export function openDoor(door) {
  if (door.isOpen) return;
  door.isOpen = true;
  door.timer = DOOR_AUTO_CLOSE;
  door.transitioning = true;
  if (door.isAirlock) playAirlockCycle();
  else playDoorOpen();
}

export function closeDoor(door) {
  if (!door.isOpen) return;
  door.isOpen = false;
  door.transitioning = true;
  playDoorOpen();
}

export function toggleNearestDoor(playerPos) {
  let best = null, bestDist = 3; // DOOR_INTERACT_DIST
  for (const door of doors) {
    const dist = door.mesh.position.distanceTo(playerPos);
    if (dist < bestDist) { bestDist = dist; best = door; }
  }
  if (best) {
    if (best.isOpen) closeDoor(best);
    else openDoor(best);
  }
  return best;
}

export function getNearestDoorDist(playerPos) {
  let bestDist = Infinity;
  for (const door of doors) {
    const dist = door.mesh.position.distanceTo(playerPos);
    if (dist < bestDist) bestDist = dist;
  }
  return bestDist;
}

export function updateDoors(dt) {
  for (const door of doors) {
    if (door.isOpen) {
      door.timer -= dt;
      if (door.timer <= 0 && !door.isAirlock) closeDoor(door);
    }
    if (door.transitioning) {
      const target = door.isOpen ? door.openPos : door.closedPos;
      door.mesh.position.lerp(target, 8 * dt);
      if (door.mesh.position.distanceTo(target) < 0.05) {
        door.mesh.position.copy(target);
        door.transitioning = false;
      }
      // Sync collider
      const c = colliders[door.colliderIdx];
      if (c) {
        const w = c.max.x - c.min.x, h = c.max.y - c.min.y, d = c.max.z - c.min.z;
        c.min.x = door.mesh.position.x - w / 2; c.max.x = door.mesh.position.x + w / 2;
        c.min.y = door.mesh.position.y - h / 2; c.max.y = door.mesh.position.y + h / 2;
        c.min.z = door.mesh.position.z - d / 2; c.max.z = door.mesh.position.z + d / 2;
      }
    }
  }
}

// ── Terminal station position (exported for VR keyboard proximity) ───────────

export const TERM_X = 8, TERM_Z = -4;

// ── Build everything ────────────────────────────────────────────────────────

export function buildEnvironment(scene) {
  const metalFloorMat = new THREE.MeshPhongMaterial({ color: 0x222233, shininess: 40 });
  const metalWallMat = new THREE.MeshPhongMaterial({ color: 0x2a2a3a, shininess: 30 });
  const metalCeilingMat = new THREE.MeshPhongMaterial({ color: 0x1a1a2a, shininess: 20 });
  const accentMat = new THREE.MeshPhongMaterial({ color: 0x00ddff, emissive: 0x00ddff, emissiveIntensity: 0.4 });
  const hullMat = new THREE.MeshPhongMaterial({ color: 0x333344, shininess: 50 });

  // ── Starfield ─────────────────────────────────────────────────────────────
  {
    const count = 3000;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 120 + Math.random() * 80;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.4, sizeAttenuation: true })));
  }

  // ── Floor + ceiling with hull panels ──────────────────────────────────────
  {
    const floor = new THREE.Mesh(new THREE.BoxGeometry(STATION_W, 0.5, STATION_D), metalFloorMat);
    floor.position.set(0, -0.25, 0); floor.receiveShadow = true;
    scene.add(floor);
    addCollider(0, -0.25, 0, STATION_W, 0.5, STATION_D);

    const hullBottom = new THREE.Mesh(new THREE.BoxGeometry(STATION_W + 1, 0.3, STATION_D + 1), hullMat);
    hullBottom.position.set(0, -0.65, 0); scene.add(hullBottom);
    addCollider(0, -0.65, 0, STATION_W + 1, 0.3, STATION_D + 1, true);

    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(STATION_W, 0.5, STATION_D), metalCeilingMat);
    ceiling.position.set(0, STATION_H + 0.25, 0); scene.add(ceiling);
    addCollider(0, STATION_H + 0.25, 0, STATION_W, 0.5, STATION_D);

    const hullTop = new THREE.Mesh(new THREE.BoxGeometry(STATION_W + 1, 0.3, STATION_D + 1), hullMat);
    hullTop.position.set(0, STATION_H + 0.65, 0); scene.add(hullTop);
    addCollider(0, STATION_H + 0.65, 0, STATION_W + 1, 0.3, STATION_D + 1, true);
  }

  // ── Walls with hull exterior ──────────────────────────────────────────────
  {
    const thick = 0.5;
    const defs = [
      { pos: [0, STATION_H / 2, -STATION_HALF_D], size: [STATION_W, STATION_H, thick],
        hullPos: [0, STATION_H / 2, -STATION_HALF_D - 0.4], hullSize: [STATION_W + 1, STATION_H + 1, 0.3] },
      { pos: [0, STATION_H / 2, STATION_HALF_D], size: [STATION_W, STATION_H, thick],
        hullPos: [0, STATION_H / 2, STATION_HALF_D + 0.4], hullSize: [STATION_W + 1, STATION_H + 1, 0.3] },
      { pos: [-STATION_HALF_W, STATION_H / 2, 0], size: [thick, STATION_H, STATION_D],
        hullPos: [-STATION_HALF_W - 0.4, STATION_H / 2, 0], hullSize: [0.3, STATION_H + 1, STATION_D + 1] },
      { pos: [STATION_HALF_W, STATION_H / 2, 0], size: [thick, STATION_H, STATION_D],
        hullPos: [STATION_HALF_W + 0.4, STATION_H / 2, 0], hullSize: [0.3, STATION_H + 1, STATION_D + 1] },
    ];
    for (const w of defs) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(...w.size), metalWallMat);
      wall.position.set(...w.pos); wall.receiveShadow = true; scene.add(wall);
      addCollider(...w.pos, ...w.size);
      const hull = new THREE.Mesh(new THREE.BoxGeometry(...w.hullSize), hullMat);
      hull.position.set(...w.hullPos); scene.add(hull);
      addCollider(...w.hullPos, ...w.hullSize, true);
    }
  }

  // ── Accent strips ─────────────────────────────────────────────────────────
  {
    const stripGeo = new THREE.BoxGeometry(STATION_W - 2, 0.05, 0.1);
    const stripGeoZ = new THREE.BoxGeometry(0.1, 0.05, STATION_D - 2);
    const yy = 0.03;
    for (const [geo, pos] of [
      [stripGeo, [0, yy, -STATION_HALF_D + 1]], [stripGeo, [0, yy, STATION_HALF_D - 1]],
      [stripGeoZ, [-STATION_HALF_W + 1, yy, 0]], [stripGeoZ, [STATION_HALF_W - 1, yy, 0]],
    ]) {
      const strip = new THREE.Mesh(geo, accentMat);
      strip.position.set(...pos); scene.add(strip);
    }
  }

  // ── Command Bridge (center, elevated) ─────────────────────────────────────
  {
    const bridgeFloor = new THREE.Mesh(new THREE.BoxGeometry(14, 0.5, 14), metalFloorMat);
    bridgeFloor.position.set(0, 2.75, 0); bridgeFloor.receiveShadow = true;
    scene.add(bridgeFloor);
    addCollider(0, 2.75, 0, 14, 0.5, 14);

    // Ramp
    const rampLen = 8;
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(4, 0.25, rampLen), metalFloorMat);
    ramp.position.set(0, 1.25, -10);
    ramp.rotation.x = -Math.atan2(2.5, rampLen);
    ramp.receiveShadow = true; scene.add(ramp);
    for (let i = 0; i < 8; i++) {
      const t = (i + 0.5) / 8;
      addCollider(0, 2.5 * t, -14 + rampLen * t, 4, 0.4, rampLen / 8);
    }

    // Consoles
    const consoleMat = new THREE.MeshPhongMaterial({ color: 0x1a1a2e, shininess: 60 });
    const screenMat = new THREE.MeshPhongMaterial({ color: 0x003344, emissive: 0x00ddff, emissiveIntensity: 0.15 });
    for (const c of [
      { pos: [0, 3.6, -5], size: [8, 0.8, 1.2] },
      { pos: [-5, 3.6, 0], size: [1.2, 0.8, 8] },
      { pos: [5, 3.6, 0], size: [1.2, 0.8, 8] },
    ]) {
      const desk = new THREE.Mesh(new THREE.BoxGeometry(...c.size), consoleMat);
      desk.position.set(...c.pos); desk.castShadow = true; scene.add(desk);
      addCollider(...c.pos, ...c.size);
      const screen = new THREE.Mesh(new THREE.BoxGeometry(c.size[0] * 0.8, 0.05, c.size[2] * 0.8), screenMat);
      screen.position.set(c.pos[0], c.pos[1] + 0.42, c.pos[2]); scene.add(screen);
    }

    scene.add(new THREE.PointLight(0x00ddff, 0.6, 20).translateX(0).translateY(8));

    // Viewscreen
    const viewscreen = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 5),
      new THREE.MeshPhongMaterial({ color: 0x050520, emissive: 0x001133, emissiveIntensity: 0.3, side: THREE.DoubleSide })
    );
    viewscreen.position.set(0, 6, -STATION_HALF_D + 0.6); scene.add(viewscreen);
  }

  // ── Cargo Bay (lower-left) ────────────────────────────────────────────────
  {
    addWall(scene, -12, STATION_H / 2, -7, 0.3, STATION_H, 26);

    const crateMat = new THREE.MeshPhongMaterial({ color: 0x445544, shininess: 20 });
    for (const [pos, size] of [
      [[-16, 1, -12], [2, 2, 2]], [[-14, 0.75, -14], [1.5, 1.5, 1.5]],
      [[-18, 1.25, -8], [2.5, 2.5, 2]], [[-16, 0.5, -4], [1, 1, 1]],
      [[-13, 1, 4], [2, 2, 3]], [[-17, 0.75, 8], [1.5, 1.5, 1.5]],
      [[-15, 1.5, 12], [3, 3, 2]],
    ]) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(...size), crateMat);
      crate.position.set(...pos); crate.castShadow = true; crate.receiveShadow = true;
      scene.add(crate); addCollider(...pos, ...size);
    }
    const cargoLight = new THREE.PointLight(0xffaa44, 0.5, 25);
    cargoLight.position.set(-16, 8, 0); scene.add(cargoLight);
  }

  // ── Engine Room (back-right) ──────────────────────────────────────────────
  {
    addWall(scene, 10, STATION_H / 2, 7, 20, STATION_H, 0.3);

    const reactorMat = new THREE.MeshPhongMaterial({
      color: 0x003366, emissive: 0x0066ff, emissiveIntensity: 0.6, shininess: 80
    });
    const reactor = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 6, 12), reactorMat);
    reactor.position.set(14, 3, 14); scene.add(reactor);
    addCollider(14, 3, 14, 4, 6, 4);

    // Pipes
    const pipeMat = new THREE.MeshPhongMaterial({ color: 0x556666, shininess: 60 });
    for (const [from, to, r] of [
      [[14, 6, 14], [14, 9, 14], 0.15],
      [[14, 0, 14], [6, 0, 14], 0.12],
      [[14, 3, 14], [14, 3, 19], 0.12],
    ]) {
      const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), pipeMat);
      pipe.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
      const dir = new THREE.Vector3(dx, dy, dz).normalize();
      pipe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      scene.add(pipe);
    }

    const engineLight = new THREE.PointLight(0x0066ff, 0.8, 20);
    engineLight.position.set(14, 5, 14); scene.add(engineLight);
  }

  // ── Living Quarters (front-right) ─────────────────────────────────────────
  {
    addWall(scene, 10, STATION_H / 2, -7, 20, STATION_H, 0.3);

    const bunkMat = new THREE.MeshPhongMaterial({ color: 0x3a3a4a, shininess: 20 });
    for (const [bx, bz] of [[14, -14], [17, -14], [14, -11], [17, -11]]) {
      for (const [h, y] of [['lower', 0.8], ['upper', 2.5]]) {
        const bunk = new THREE.Mesh(new THREE.BoxGeometry(2, 0.3, 1.5), bunkMat);
        bunk.position.set(bx, y, bz); bunk.castShadow = true; scene.add(bunk);
        addCollider(bx, y, bz, 2, 0.3, 1.5);
      }
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.5, 1.5), bunkMat);
      frame.position.set(bx + 1, 1.25, bz); scene.add(frame);
      addCollider(bx + 1, 1.25, bz, 0.1, 2.5, 1.5);
    }

    const table = new THREE.Mesh(new THREE.BoxGeometry(3, 0.15, 2),
      new THREE.MeshPhongMaterial({ color: 0x444455, shininess: 40 }));
    table.position.set(15, 1, -8); table.castShadow = true; scene.add(table);
    addCollider(15, 1, -8, 3, 0.15, 2);

    const quartersLight = new THREE.PointLight(0xffcc88, 0.4, 18);
    quartersLight.position.set(15, 8, -12); scene.add(quartersLight);
  }

  // ── Observation Deck (upper level) ────────────────────────────────────────
  {
    const obsFloor = new THREE.Mesh(new THREE.BoxGeometry(10, 0.4, 10), metalFloorMat);
    obsFloor.position.set(0, 6.8, 10); obsFloor.receiveShadow = true; scene.add(obsFloor);
    addCollider(0, 6.8, 10, 10, 0.4, 10);

    // Ramp from bridge
    const rampLen = 6, rampH = 4;
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(3, 0.25, rampLen), metalFloorMat);
    ramp.position.set(0, 4.75, 4);
    ramp.rotation.x = -Math.atan2(rampH, rampLen);
    ramp.receiveShadow = true; scene.add(ramp);
    for (let i = 0; i < 8; i++) {
      const t = (i + 0.5) / 8;
      addCollider(0, 3 + rampH * t, 1 + rampLen * t, 3, 0.4, rampLen / 8);
    }

    // Window
    const windowMat = new THREE.MeshPhongMaterial({
      color: 0x050520, emissive: 0x001122, emissiveIntensity: 0.2,
      transparent: true, opacity: 0.4, side: THREE.DoubleSide,
    });
    const win = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), windowMat);
    win.position.set(0, 8, STATION_HALF_D - 0.3); scene.add(win);

    scene.add(new THREE.PointLight(0xaaaaff, 0.3, 15).translateY(9).translateZ(10));

    // Railings
    const railMat = new THREE.MeshPhongMaterial({ color: 0x555566, shininess: 60 });
    for (const [pos, size] of [
      [[-4.5, 7.7, 10], [0.1, 1.5, 10]], [[4.5, 7.7, 10], [0.1, 1.5, 10]],
      [[0, 7.7, 14.5], [10, 1.5, 0.1]],
    ]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(...size), railMat);
      rail.position.set(...pos); scene.add(rail); addCollider(...pos, ...size);
    }
  }

  // ── Structural columns ────────────────────────────────────────────────────
  {
    const columnMat = new THREE.MeshPhongMaterial({ color: 0x444455, shininess: 50 });
    for (const [cx, cz] of [[6, -8], [-6, -8], [6, 8], [-6, 8], [0, -16], [0, 16]]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, STATION_H, 8), columnMat);
      col.position.set(cx, STATION_H / 2, cz); col.castShadow = true; scene.add(col);
      addCollider(cx, STATION_H / 2, cz, 0.6, STATION_H, 0.6);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.03, 8, 16), accentMat);
      ring.position.set(cx, STATION_H / 2, cz); ring.rotation.x = Math.PI / 2;
      scene.add(ring);
    }
  }

  // ── Doors ─────────────────────────────────────────────────────────────────
  createDoor(scene, -12, STATION_H / 2, 0, 0.3, STATION_H, 3, 'z', 4);        // cargo bay
  createDoor(scene, 10, STATION_H / 2, 10, 3, STATION_H, 0.3, 'x', 4);        // engine room
  createDoor(scene, 10, STATION_H / 2, -10, 3, STATION_H, 0.3, 'x', 4);       // living quarters

  // ── Airlock ───────────────────────────────────────────────────────────────
  {
    const AIRLOCK_X = -STATION_HALF_W, AIRLOCK_Z = -14;
    const cW = 4, cH = 4, cD = 4;
    const cX = AIRLOCK_X - cW / 2 - 0.5, cY = cH / 2;

    // Chamber walls
    for (const [pos, size] of [
      [[cX, cY, AIRLOCK_Z - cD / 2], [cW, cH, 0.3]],
      [[cX, cY, AIRLOCK_Z + cD / 2], [cW, cH, 0.3]],
      [[cX - cW / 2, cY, AIRLOCK_Z], [0.3, cH, cD]],
      [[cX, 0, AIRLOCK_Z], [cW, 0.3, cD]],
      [[cX, cH, AIRLOCK_Z], [cW, 0.3, cD]],
    ]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(...size), hullMat);
      wall.position.set(...pos); scene.add(wall); addCollider(...pos, ...size);
    }

    // Hull panel for hull-walking
    const hullOuter = new THREE.Mesh(new THREE.BoxGeometry(cW + 0.5, cH + 0.5, 0.3), hullMat);
    hullOuter.position.set(cX, cY, AIRLOCK_Z - cD / 2 - 0.3); scene.add(hullOuter);
    addCollider(cX, cY, AIRLOCK_Z - cD / 2 - 0.3, cW + 0.5, cH + 0.5, 0.3, true);

    const airlockLight = new THREE.PointLight(0xff2200, 0.5, 8);
    airlockLight.position.set(cX, cH - 0.5, AIRLOCK_Z); scene.add(airlockLight);

    createDoor(scene, AIRLOCK_X - 0.25, cH / 2, AIRLOCK_Z, 0.5, cH, 3, 'z', 3.5, false); // inner
    createDoor(scene, cX - cW / 2, cY, AIRLOCK_Z, 0.3, cH, 3, 'z', 3.5, true);            // outer
  }

  // ── Terminal station ──────────────────────────────────────────────────────
  const termStation = buildTerminalStation(scene);
  return termStation;
}

function addWall(scene, x, y, z, w, h, d) {
  const dividerMat = new THREE.MeshPhongMaterial({ color: 0x2a2a3a, shininess: 30 });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), dividerMat);
  wall.position.set(x, y, z); wall.castShadow = true; wall.receiveShadow = true;
  scene.add(wall); addCollider(x, y, z, w, h, d);
}

function buildTerminalStation(scene) {
  const termPlat = new THREE.Mesh(
    new THREE.CylinderGeometry(2.5, 2.5, 0.3, 6),
    new THREE.MeshPhongMaterial({ color: 0x006688, emissive: 0x00ddff, emissiveIntensity: 0.2, shininess: 60 })
  );
  termPlat.position.set(TERM_X, 0.15, TERM_Z); scene.add(termPlat);

  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8),
    new THREE.MeshPhongMaterial({ color: 0x888899, emissive: 0x00ddff, emissiveIntensity: 0.3, shininess: 80 })
  );
  pillar.position.set(TERM_X, 0.6, TERM_Z); scene.add(pillar);

  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0a1a'; ctx.fillRect(0, 0, 1024, 512);
  ctx.fillStyle = '#00ddff'; ctx.font = 'bold 28px monospace'; ctx.textAlign = 'center';
  ctx.fillText('SPACE STATION TERMINAL', 512, 200);
  ctx.font = '18px monospace';
  ctx.fillText('Select a robot to view its terminal', 512, 260);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2.5, 1.5),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
  );
  mesh.position.set(TERM_X, 1.5, TERM_Z); mesh.rotation.y = Math.PI;
  scene.add(mesh);

  // Border
  const border = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.6), new THREE.MeshBasicMaterial({ color: 0x00ddff }));
  border.position.set(TERM_X, 1.5, TERM_Z + 0.01); border.rotation.y = Math.PI; scene.add(border);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.6), new THREE.MeshBasicMaterial({ color: 0x111122 }));
  back.position.set(TERM_X, 1.5, TERM_Z + 0.02); back.rotation.y = Math.PI; scene.add(back);

  return { mesh, texture, canvas };
}

// ── Utilities ───────────────────────────────────────────────────────────────

export function isInsideStation(pos) {
  return pos.x > -STATION_HALF_W && pos.x < STATION_HALF_W &&
         pos.y > 0 && pos.y < STATION_H &&
         pos.z > -STATION_HALF_D && pos.z < STATION_HALF_D;
}
