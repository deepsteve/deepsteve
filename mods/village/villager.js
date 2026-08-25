// You: a small villager, and the walk that carries the whole feel.
//
// The issue is specific about the movement, and every clause of it is a "don't":
// slow walk speed, real acceleration and deceleration, no instant start/stop, no
// sprint, no crouch, no jump. What is left is deliberately unhurried, and the
// acceleration curve is doing most of the work — an instant-response walk at the
// same top speed reads as an FPS with the speed turned down, which is exactly the
// thing being avoided.

import * as THREE from 'three';
import { MOVE, PALETTE } from './config.js';
import { curve } from './curvature.js';
import { blobTexture } from './textures.js';
import { walkVector } from './input.js';

/**
 * Build the avatar. Chunky and low-poly, in the same idiom as the houses: a round
 * head, a rounded body, stubby limbs. Readable as a person from nine metres back,
 * which is the only distance it is ever seen from.
 */
export function buildVillager() {
  const group = new THREE.Group();

  const skin = curve(new THREE.MeshLambertMaterial({ color: 0xf0c9a0 }));
  const coat = curve(new THREE.MeshLambertMaterial({ color: 0x4a7ba8 }));
  const trouser = curve(new THREE.MeshLambertMaterial({ color: 0x3a4a5c }));
  const shoe = curve(new THREE.MeshLambertMaterial({ color: 0x4a3018 }));
  const hat = curve(new THREE.MeshLambertMaterial({ color: PALETTE.POST_RED }));

  // Body — a slightly squashed sphere reads rounder than a box at this scale.
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), coat);
  body.scale.set(1, 1.12, 0.88);
  body.position.y = 0.78;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 12), skin);
  head.position.y = 1.42;
  head.scale.set(1, 0.96, 0.94);
  group.add(head);

  // A rain hat, since it is always raining here.
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.05, 14), hat);
  brim.position.y = 1.63;
  group.add(brim);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.3, 0.26, 14), hat);
  crown.position.y = 1.76;
  group.add(crown);

  // Eyes — two dots, facing +Z, which is the direction the villager walks.
  const eyeMat = curve(new THREE.MeshLambertMaterial({ color: 0x2a2018 }));
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), eyeMat);
    eye.position.set(sx * 0.13, 1.45, 0.32);
    group.add(eye);
  }

  // Limbs, each on a pivot at the shoulder/hip so the walk cycle is one rotation.
  const limbs = { armL: null, armR: null, legL: null, legR: null };

  for (const [key, sx] of [['armL', -1], ['armR', 1]]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.42, 1.0, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.34, 3, 7), coat);
    arm.position.y = -0.25;
    pivot.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), skin);
    hand.position.y = -0.48;
    pivot.add(hand);
    group.add(pivot);
    limbs[key] = pivot;
  }

  for (const [key, sx] of [['legL', -1], ['legR', 1]]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.17, 0.5, 0);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.28, 3, 7), trouser);
    leg.position.y = -0.2;
    pivot.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.11, 0.3), shoe);
    foot.position.set(0, -0.42, 0.05);
    pivot.add(foot);
    group.add(pivot);
    limbs[key] = pivot;
  }

  // Painted shadow, in place of a shadow map (see curvature.js).
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.05;
  group.add(shadow);

  group.userData.limbs = limbs;
  // Kept so a jump can pin it to the ground and shrink it with altitude — the
  // whole group rises, and a shadow that rises with you reads as a bug.
  group.userData.shadow = shadow;
  return group;
}

/**
 * The walker: position, velocity, heading, and the walk phase that drives both the
 * limbs and the footstep audio.
 */
export class Walker {
  constructor(spawn) {
    this.position = new THREE.Vector3(spawn.x, 0, spawn.z);
    this.velocity = new THREE.Vector3();
    this.heading = spawn.heading || 0;   // where the body points
    this.bodyYaw = this.heading;         // eased toward heading
    this.phase = 0;                      // walk cycle, radians
    this.distance = 0;                   // metres walked, for footsteps
    this.stepped = 0;                    // last footstep's distance mark
    this.speed = 0;

    // The jump. `height` is metres off the ground; the walker is airborne
    // whenever it is above zero. Collision stays 2D and stays ON while airborne:
    // hopping is for getting over a fence by eye, not for landing inside a house.
    this.height = 0;
    this.vy = 0;
    this.airborne = false;
  }

  /** Leave the ground, if it is there to leave. No double jump. */
  jump() {
    if (this.airborne) return false;
    this.vy = MOVE.JUMP_SPEED;
    this.airborne = true;
    return true;
  }

  /**
   * @param {number} dt      seconds
   * @param {Object} input   {forward, back, left, right} booleans
   * @param {number} camYaw  the camera's yaw — movement is camera-relative
   * @param {Function} collide  (x, z) => {x, z} resolved position
   * @returns {boolean} true on the frame a foot lands, including the landing
   */
  update(dt, input, camYaw, collide) {
    // Camera-relative desired direction. The basis lives in input.js, three-free
    // and unit tested — it shipped with the strafe axis negated, which made D walk
    // left at every yaw, and that is not a thing to leave resting on a comment.
    const dir = walkVector(input, camYaw);
    const top = input.sprint ? MOVE.SPRINT_SPEED : MOVE.WALK_SPEED;
    const wanted = new THREE.Vector3(dir.x, 0, dir.z);
    if (dir.x || dir.z) wanted.multiplyScalar(top);

    // Accelerate toward the target; decay toward rest when there is none. Both are
    // frame-rate independent, so a 144Hz monitor walks the same as a 60Hz one.
    // Airborne, the same curve runs at AIR_CONTROL strength: you can steer a jump
    // but you cannot turn one on the spot.
    const grip = this.airborne ? MOVE.AIR_CONTROL : 1;
    if (wanted.lengthSq() > 0) {
      const blend = 1 - Math.exp(-MOVE.ACCEL * grip * dt);
      this.velocity.lerp(wanted, blend);
    } else if (!this.airborne) {
      this.velocity.multiplyScalar(Math.exp(-MOVE.DAMPING * dt));
      if (this.velocity.lengthSq() < 1e-4) this.velocity.set(0, 0, 0);
    }

    this.speed = this.velocity.length();

    // --- the vertical half, integrated separately from the ground plane.
    let landed = false;
    if (input.jump) this.jump();
    if (this.airborne) {
      this.vy -= MOVE.GRAVITY * dt;
      this.height += this.vy * dt;
      if (this.height <= 0) {
        this.height = 0;
        this.vy = 0;
        this.airborne = false;
        landed = true;
      }
    }

    if (this.speed > 0.001) {
      const nx = this.position.x + this.velocity.x * dt;
      const nz = this.position.z + this.velocity.z * dt;
      const resolved = collide ? collide(nx, nz, this.position.x, this.position.z) : { x: nx, z: nz };
      // Distance actually travelled, so walking into a wall stops the footsteps.
      const moved = Math.hypot(resolved.x - this.position.x, resolved.z - this.position.z);
      this.position.x = resolved.x;
      this.position.z = resolved.z;
      this.distance += moved;
      this.heading = Math.atan2(this.velocity.x, this.velocity.z);
    }

    // The body swings toward the heading rather than snapping — a snap at this
    // camera distance looks like the avatar teleporting into a new pose.
    this.bodyYaw = approachAngle(this.bodyYaw, this.heading, MOVE.TURN_RATE * dt);

    // Walk cycle, advanced by distance rather than time, so it never moonwalks.
    // Frozen in the air: legs that keep striding on the way up read as a glitch,
    // and the distance still accrues so the cycle resumes mid-stride on landing.
    if (!this.airborne) this.phase = (this.distance / MOVE.STEP_LENGTH) * Math.PI;

    let footfall = false;
    if (this.airborne) {
      // No footsteps off the ground; keep the mark current so touching down does
      // not immediately fire the whole distance flown as a burst of steps.
      this.stepped = this.distance;
    } else if (landed || this.distance - this.stepped >= MOVE.STEP_LENGTH / 2) {
      this.stepped = this.distance;
      footfall = true;
    }
    return footfall;
  }

  /**
   * 0..1 — how much of top speed, for the bob and the limb swing amplitude.
   * Measured against the WALK speed, so a sprint saturates it: the legs are
   * already at full swing at a walk and sprinting covers ground, not amplitude.
   */
  gait() {
    return Math.min(1, this.speed / MOVE.WALK_SPEED);
  }

  /** Pose the mesh built by buildVillager(). */
  apply(mesh) {
    mesh.position.set(this.position.x, this.height, this.position.z);
    mesh.rotation.y = this.bodyYaw;

    const limbs = mesh.userData.limbs;
    if (!limbs) return;

    const swing = Math.sin(this.phase) * 0.72 * this.gait();
    const counter = Math.sin(this.phase + Math.PI) * 0.72 * this.gait();
    limbs.legL.rotation.x = swing;
    limbs.legR.rotation.x = counter;
    limbs.armL.rotation.x = counter * 0.75;
    limbs.armR.rotation.x = swing * 0.75;

    // A small vertical lift on each step, so the walk has weight — ADDED to the
    // jump height rather than replacing it, or a jump never leaves the ground.
    const bounce = this.airborne ? 0 : Math.abs(Math.sin(this.phase)) * 0.045 * this.gait();
    mesh.position.y = this.height + bounce;

    // Airborne, tuck the legs and swing the arms up: the pose is what sells a
    // hop, since the arc itself is only ~1.2m and over in under a second.
    if (this.airborne) {
      const rise = Math.max(-1, Math.min(1, this.vy / MOVE.JUMP_SPEED));
      limbs.legL.rotation.x = -0.5 - rise * 0.25;
      limbs.legR.rotation.x = -0.3 - rise * 0.15;
      limbs.armL.rotation.x = -1.1 - rise * 0.5;
      limbs.armR.rotation.x = -1.1 - rise * 0.5;
    }

    // The shadow stays on the ground and shrinks with altitude, which is the only
    // cue for how high you are in a world with no cast shadows.
    const shadow = mesh.userData.shadow;
    if (shadow) {
      shadow.position.y = 0.05 - mesh.position.y;
      const shrink = 1 / (1 + this.height * 0.55);
      shadow.scale.set(shrink, shrink, 1);
      shadow.material.opacity = shrink;
    }
  }
}

/** Step `current` toward `target` by at most `maxDelta`, the short way round. */
function approachAngle(current, target, maxDelta) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/**
 * Collision against the town: houses are oriented boxes, so the test is done in
 * each house's local space where the box is axis-aligned. Sliding rather than
 * stopping — walking into a wall at an angle should carry you along it, not glue
 * you to it.
 */
export function makeCollider(town) {
  const boxes = town.plots.map((p) => ({
    x: p.position.x,
    z: p.position.z,
    // The fence sits in front of the house; treat the whole lot as solid so you
    // walk round to the gate rather than through the pickets.
    hw: p.width / 2 + MOVE.RADIUS,
    hd: p.depth / 2 + MOVE.RADIUS,
    sin: Math.sin(-p.rotation),
    cos: Math.cos(-p.rotation),
  }));

  return (nx, nz) => {
    let x = nx;
    let z = nz;
    for (const b of boxes) {
      // Into the box's local frame.
      const dx = x - b.x;
      const dz = z - b.z;
      const lx = dx * b.cos - dz * b.sin;
      const lz = dx * b.sin + dz * b.cos;
      if (Math.abs(lx) >= b.hw || Math.abs(lz) >= b.hd) continue;

      // Push out along whichever axis needs the least movement.
      const px = b.hw - Math.abs(lx);
      const pz = b.hd - Math.abs(lz);
      let ox = lx;
      let oz = lz;
      if (px < pz) ox = Math.sign(lx || 1) * b.hw;
      else oz = Math.sign(lz || 1) * b.hd;

      // Back to world.
      const wx = ox * b.cos + oz * b.sin;
      const wz = -ox * b.sin + oz * b.cos;
      x = b.x + wx;
      z = b.z + wz;
    }
    return { x, z };
  };
}
