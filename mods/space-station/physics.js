import * as THREE from 'three';
import {
  PHYSICS, ROBOT_RADIUS, ROBOT_HEIGHT,
  GRAV_INTERIOR, GRAV_EVA, GRAV_HULL,
  STATION_HALF_W, STATION_HALF_D,
  input, robotState, state,
} from './config.js';
import { colliders, updateDoors, toggleNearestDoor, isInsideStation } from './environment.js';
import { animateRobot } from './robot.js';
import { playBootClank, playJetpackIgnite } from './audio.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

// ── Collision resolution ────────────────────────────────────────────────────

export function resolveCollisions(pos, vel, isPlayer) {
  const mMin = { x: pos.x - ROBOT_RADIUS, y: pos.y, z: pos.z - ROBOT_RADIUS };
  const mMax = { x: pos.x + ROBOT_RADIUS, y: pos.y + ROBOT_HEIGHT, z: pos.z + ROBOT_RADIUS };

  let onGround = false;

  for (const c of colliders) {
    if (mMax.x <= c.min.x || mMin.x >= c.max.x) continue;
    if (mMax.y <= c.min.y || mMin.y >= c.max.y) continue;
    if (mMax.z <= c.min.z || mMin.z >= c.max.z) continue;

    const overlapX = Math.min(mMax.x - c.min.x, c.max.x - mMin.x);
    const overlapY = Math.min(mMax.y - c.min.y, c.max.y - mMin.y);
    const overlapZ = Math.min(mMax.z - c.min.z, c.max.z - mMin.z);

    if (overlapY <= overlapX && overlapY <= overlapZ) {
      if (pos.y + ROBOT_HEIGHT / 2 < (c.min.y + c.max.y) / 2) {
        pos.y = c.min.y - ROBOT_HEIGHT;
        vel.y = Math.min(vel.y, 0);
      } else {
        pos.y = c.max.y;
        if (vel.y < -0.5) {
          vel.y = -vel.y * 0.2;
          if (Math.abs(vel.y) < 1) vel.y = 0;
        } else {
          vel.y = 0;
        }
        onGround = true;
      }
    } else if (overlapX <= overlapZ) {
      if (pos.x < (c.min.x + c.max.x) / 2) pos.x = c.min.x - ROBOT_RADIUS;
      else pos.x = c.max.x + ROBOT_RADIUS;
      vel.x = isPlayer ? 0 : vel.x * -0.2;
    } else {
      if (pos.z < (c.min.z + c.max.z) / 2) pos.z = c.min.z - ROBOT_RADIUS;
      else pos.z = c.max.z + ROBOT_RADIUS;
      vel.z = isPlayer ? 0 : vel.z * -0.2;
    }
  }

  return onGround;
}

// ── Hull walking ────────────────────────────────────────────────────────────

export function tryAttachToHull(m) {
  let bestDist = 3;
  let bestNormal = null;

  for (const c of colliders) {
    if (!c.isHull) continue;
    const cx = (c.min.x + c.max.x) / 2;
    const cy = (c.min.y + c.max.y) / 2;
    const cz = (c.min.z + c.max.z) / 2;

    const faces = [
      { dist: Math.abs(m.pos.x - c.max.x), normal: new THREE.Vector3(1, 0, 0), check: m.pos.x > cx },
      { dist: Math.abs(m.pos.x - c.min.x), normal: new THREE.Vector3(-1, 0, 0), check: m.pos.x < cx },
      { dist: Math.abs(m.pos.y - c.max.y), normal: new THREE.Vector3(0, 1, 0), check: m.pos.y > cy },
      { dist: Math.abs(m.pos.y - c.min.y), normal: new THREE.Vector3(0, -1, 0), check: m.pos.y < cy },
      { dist: Math.abs(m.pos.z - c.max.z), normal: new THREE.Vector3(0, 0, 1), check: m.pos.z > cz },
      { dist: Math.abs(m.pos.z - c.min.z), normal: new THREE.Vector3(0, 0, -1), check: m.pos.z < cz },
    ];

    for (const f of faces) {
      if (!f.check) continue;
      const margin = 2;
      if (f.normal.x !== 0) {
        if (m.pos.y < c.min.y - margin || m.pos.y > c.max.y + margin) continue;
        if (m.pos.z < c.min.z - margin || m.pos.z > c.max.z + margin) continue;
      } else if (f.normal.y !== 0) {
        if (m.pos.x < c.min.x - margin || m.pos.x > c.max.x + margin) continue;
        if (m.pos.z < c.min.z - margin || m.pos.z > c.max.z + margin) continue;
      } else {
        if (m.pos.x < c.min.x - margin || m.pos.x > c.max.x + margin) continue;
        if (m.pos.y < c.min.y - margin || m.pos.y > c.max.y + margin) continue;
      }
      if (f.dist < bestDist) { bestDist = f.dist; bestNormal = f.normal; }
    }
  }

  if (bestNormal) {
    m.gravMode = GRAV_HULL;
    m.hullNormal = bestNormal;
    m.vel.set(0, 0, 0);
    return true;
  }
  return false;
}

export function isTouchingSurface(worldPos) {
  const margin = 0.4;
  for (const c of colliders) {
    if (worldPos.x >= c.min.x - margin && worldPos.x <= c.max.x + margin &&
        worldPos.y >= c.min.y - margin && worldPos.y <= c.max.y + margin &&
        worldPos.z >= c.min.z - margin && worldPos.z <= c.max.z + margin) {
      return true;
    }
  }
  return false;
}

// ── AI ──────────────────────────────────────────────────────────────────────

const AI_IDLE = 0, AI_WANDER = 1, AI_WORK = 2;

const AI_WAYPOINTS = [
  new THREE.Vector3(0, 3.2, 0),   new THREE.Vector3(-16, 0, -10),
  new THREE.Vector3(-16, 0, 8),   new THREE.Vector3(14, 0, 14),
  new THREE.Vector3(15, 0, -12),  new THREE.Vector3(0, 7, 10),
  new THREE.Vector3(8, 0, -4),    new THREE.Vector3(0, 0, -10),
  new THREE.Vector3(0, 0, 10),
];

function pickWanderTarget(m) {
  const wp = AI_WAYPOINTS[Math.floor(Math.random() * AI_WAYPOINTS.length)];
  m.aiTarget.copy(wp);
  m.aiTimer = 4 + Math.random() * 6;
}

function updateAI(m, id, dt) {
  const session = state.sessions.find(s => s.id === id);
  const isWorking = session && !session.waitingForInput;
  const speed = isWorking ? 4 : 2;

  m.aiState = isWorking ? AI_WORK : (m.aiTimer > 0 ? AI_WANDER : AI_IDLE);
  m.aiTimer -= dt;
  if (m.aiTimer <= 0) pickWanderTarget(m);

  if (m.aiState !== AI_IDLE) {
    _v1.set(m.aiTarget.x - m.pos.x, 0, m.aiTarget.z - m.pos.z);
    if (_v1.length() > 1) {
      _v1.normalize().multiplyScalar(speed);
      m.vel.x += (_v1.x - m.vel.x) * 3 * dt;
      m.vel.z += (_v1.z - m.vel.z) * 3 * dt;
    }
  }
}

// ── Desktop movement ────────────────────────────────────────────────────────

let lastJetpackSound = 0;
let mouseYaw = 0, mousePitch = 0;

export function setMouseLook(yaw, pitch) { mouseYaw = yaw; mousePitch = pitch; }
export function getMouseYaw() { return mouseYaw; }
export function getMousePitch() { return mousePitch; }

export function updateDesktopMovement(m, dt) {
  const forward = _v2.set(0, 0, -1).applyQuaternion(_q1.setFromEuler(new THREE.Euler(0, mouseYaw, 0)));
  const right = _v3.set(forward.z, 0, -forward.x);

  if (m.gravMode === GRAV_EVA) {
    const thrustSpeed = 6;
    let mx = 0, my = 0, mz = 0;
    const camForward = _v4.set(0, 0, -1).applyQuaternion(
      _q1.setFromEuler(new THREE.Euler(mousePitch, mouseYaw, 0, 'YXZ'))
    );

    if (input.w) { mx += camForward.x; my += camForward.y; mz += camForward.z; }
    if (input.s) { mx -= camForward.x; my -= camForward.y; mz -= camForward.z; }
    if (input.a) { mx -= right.x; mz -= right.z; }
    if (input.d) { mx += right.x; mz += right.z; }

    const len = Math.sqrt(mx * mx + my * my + mz * mz);
    if (len > 0 && m.fuel > 0) {
      mx /= len; my /= len; mz /= len;
      m.vel.x += mx * thrustSpeed * dt;
      m.vel.y += my * thrustSpeed * dt;
      m.vel.z += mz * thrustSpeed * dt;
      m.fuel -= PHYSICS.jetpackBurnRate * dt;
      m.jetpackActive = true;
      if (performance.now() - lastJetpackSound > 500) {
        playJetpackIgnite();
        lastJetpackSound = performance.now();
      }
    } else {
      m.jetpackActive = false;
    }

    if (input.space && m.fuel > 0) {
      m.vel.y += thrustSpeed * dt;
      m.fuel -= PHYSICS.jetpackBurnRate * dt * 0.5;
      m.jetpackActive = true;
    }
    if (input.shift && m.fuel > 0) {
      m.vel.y -= thrustSpeed * dt;
      m.fuel -= PHYSICS.jetpackBurnRate * dt * 0.5;
      m.jetpackActive = true;
    }
    if (m.fuel <= 0) { m.fuel = 0; m.jetpackActive = false; }

  } else if (m.gravMode === GRAV_HULL) {
    const moveSpeed = 5;
    let mx = 0, mz = 0;
    if (input.w) { mx += forward.x; mz += forward.z; }
    if (input.s) { mx -= forward.x; mz -= forward.z; }
    if (input.a) { mx -= right.x; mz -= right.z; }
    if (input.d) { mx += right.x; mz += right.z; }
    const len = Math.sqrt(mx * mx + mz * mz);
    if (len > 0) {
      mx /= len; mz /= len;
      if (m.hullNormal) {
        const dot = mx * m.hullNormal.x + mz * m.hullNormal.z;
        mx -= dot * m.hullNormal.x; mz -= dot * m.hullNormal.z;
      }
      m.vel.x += (mx * moveSpeed - m.vel.x) * 5 * dt;
      m.vel.z += (mz * moveSpeed - m.vel.z) * 5 * dt;
    }

  } else {
    const moveSpeed = 8;
    let mx = 0, mz = 0;
    if (input.w) { mx += forward.x; mz += forward.z; }
    if (input.s) { mx -= forward.x; mz -= forward.z; }
    if (input.a) { mx -= right.x; mz -= right.z; }
    if (input.d) { mx += right.x; mz += right.z; }
    const len = Math.sqrt(mx * mx + mz * mz);
    if (len > 0) {
      mx /= len; mz /= len;
      m.vel.x += (mx * moveSpeed - m.vel.x) * 5 * dt;
      m.vel.z += (mz * moveSpeed - m.vel.z) * 5 * dt;
    }
    if (input.space && m.onGround) {
      m.vel.y = PHYSICS.jumpForce;
      input.space = false;
      playBootClank();
    }
  }

  if (input.e) {
    input.e = false;
    toggleNearestDoor(_v1.copy(m.pos));
  }
}

// ── Main physics tick ───────────────────────────────────────────────────────

export function updatePhysics(dt, now, isVR, updateVRLocomotion) {
  for (const [id, m] of Object.entries(robotState)) {
    const isPlayer = state.viewMode === 1 && id === state.followId;

    if (isPlayer) {
      if (isVR) updateVRLocomotion(m, dt);
      else updateDesktopMovement(m, dt);
    } else {
      m.gravMode = GRAV_INTERIOR;
      updateAI(m, id, dt);
    }

    // Gravity
    switch (m.gravMode) {
      case GRAV_INTERIOR: m.vel.y -= PHYSICS.gravity * dt; break;
      case GRAV_EVA: m.vel.multiplyScalar(PHYSICS.evaDamping); break;
      case GRAV_HULL:
        if (m.hullNormal) {
          m.vel.x -= m.hullNormal.x * PHYSICS.gravity * dt;
          m.vel.y -= m.hullNormal.y * PHYSICS.gravity * dt;
          m.vel.z -= m.hullNormal.z * PHYSICS.gravity * dt;
        }
        break;
    }

    m.pos.x += m.vel.x * dt;
    m.pos.y += m.vel.y * dt;
    m.pos.z += m.vel.z * dt;

    // Friction
    if (m.gravMode !== GRAV_EVA) {
      const f = m.onGround ? PHYSICS.friction : 0.99;
      m.vel.x *= f; m.vel.z *= f;
    }

    // Speed cap
    const spd = m.vel.length();
    if (spd > PHYSICS.maxSpeed) m.vel.multiplyScalar(PHYSICS.maxSpeed / spd);

    m.onGround = resolveCollisions(m.pos, m.vel, isPlayer);

    // Fuel recharge
    if (m.onGround || m.gravMode === GRAV_HULL) {
      m.fuel = Math.min(PHYSICS.jetpackFuelMax, m.fuel + PHYSICS.jetpackRechargeRate * dt);
    }

    // Floor clamp
    if (m.gravMode === GRAV_INTERIOR && m.pos.y < 0) {
      m.pos.y = 0; m.vel.y = 0; m.onGround = true;
    }

    // Auto-transition gravity modes
    if (isPlayer) {
      const inside = isInsideStation(m.pos);
      if (m.gravMode === GRAV_INTERIOR && !inside) m.gravMode = GRAV_EVA;
      else if (m.gravMode === GRAV_EVA && inside) m.gravMode = GRAV_INTERIOR;
    }

    m.mesh.position.copy(m.pos);

    if (!isPlayer && Math.sqrt(m.vel.x * m.vel.x + m.vel.z * m.vel.z) > 0.5) {
      m.mesh.rotation.y = Math.atan2(m.vel.x, m.vel.z);
    }

    m.label.position.set(m.pos.x, m.pos.y + 2.2, m.pos.z);
    animateRobot(m, now);
  }

  updateDoors(dt);
}
