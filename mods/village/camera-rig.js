// The camera.
//
// The issue raised third-person-vs-first-person as its open design question and the
// answer taken was third person: you see the villager, which is half of what makes
// this read the way it does.
//
// Three things do the work, and none of them is the camera's position:
//
//   THE LENS. 38° of field of view. A wide FOV is what makes a game look like a
//   game engine; a long lens flattens the town, keeps the houses' proportions
//   honest at distance, and is the single cheapest thing on this list.
//
//   THE SPRING. The camera never sits where it is told to. It is smooth-damped
//   toward its ideal, critically damped so it cannot overshoot, which is what
//   "eases toward where you're looking instead of snapping 1:1 with the mouse"
//   means once written down. Position eases slower than aim, so quick mouse moves
//   turn the view before the body of the shot catches up.
//
//   THE SETTLE. With the mouse untouched for a moment, yaw drifts to sit behind
//   your direction of travel. You stop steering the camera and it agrees with you.
//   Weighted by how forward you are moving, so strafing does not walk you in a
//   slow circle and backing away does not whip the camera around.

import * as THREE from 'three';
import { CAMERA } from './config.js';

/**
 * Critically damped smooth-damp, per axis. Never overshoots at any dt, which a
 * plain lerp-with-a-constant cannot promise once the frame rate wobbles.
 */
function smoothDamp(current, target, velRef, key, omega, dt) {
  const change = current - target;
  const temp = (velRef[key] + omega * change) * dt;
  velRef[key] = (velRef[key] - omega * temp) * Math.exp(-omega * dt);
  return target + (change + temp) * Math.exp(-omega * dt);
}

export class ChaseCamera {
  constructor(spawn) {
    this.yaw = spawn.heading || 0;
    this.pitch = 0.12;

    this.position = new THREE.Vector3();
    this.aim = new THREE.Vector3();
    this.posVel = { x: 0, y: 0, z: 0 };
    this.aimVel = { x: 0, y: 0, z: 0 };

    this.sinceMouse = CAMERA.AUTO_YAW_DELAY;
    this.bob = 0;
    this.initialised = false;

    // When set, the shot is a board instead of the villager. Same spring, so
    // stepping up to read a session is a dolly and stepping away is a dolly back
    // — the one thing this mod must never do is cut.
    this.focus = null;
  }

  /**
   * Read a board. `shot` is {position, aim} in world space, or null to go back to
   * following the villager.
   */
  setFocus(shot) {
    this.focus = shot;
  }

  /** Raw pointer-lock deltas. */
  look(movementX, movementY) {
    this.yaw -= movementX * CAMERA.MOUSE_SENSITIVITY;
    this.pitch -= movementY * CAMERA.MOUSE_SENSITIVITY;
    this.pitch = Math.max(CAMERA.PITCH_MIN, Math.min(CAMERA.PITCH_MAX, this.pitch));
    this.sinceMouse = 0;
  }

  /** Where the camera's forward points in XZ — walking is relative to this. */
  get forwardYaw() {
    return this.yaw;
  }

  update(dt, walker, camera) {
    this.sinceMouse += dt;

    // --- the settle
    const gait = walker.gait();
    if (gait > 0.05 && this.sinceMouse > CAMERA.AUTO_YAW_DELAY) {
      let diff = walker.heading - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // Only drift by how much of the movement is "forwards" relative to the
      // camera. Strafing weights to zero; backing away weights to zero.
      const forwardness = Math.max(0, Math.cos(diff));
      const step = CAMERA.AUTO_YAW_RATE * forwardness * gait * dt;
      this.yaw += Math.sign(diff) * Math.min(Math.abs(diff), step);
    }

    // --- the ideal shot
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    const target = walker.position;

    let idealX = target.x - Math.sin(this.yaw) * CAMERA.DISTANCE * cosP;
    let idealZ = target.z - Math.cos(this.yaw) * CAMERA.DISTANCE * cosP;
    // Floored so a hard upward pitch drops the camera to knee height rather than
    // through the ground. The camera rises with a jump, but only partly: tracking
    // the arc 1:1 makes the jump invisible, because the villager never moves
    // within the frame.
    let idealY = Math.max(CAMERA.MIN_HEIGHT, CAMERA.HEIGHT + sinP * CAMERA.DISTANCE)
      + walker.height * CAMERA.JUMP_FOLLOW;

    let aimX = target.x;
    // Pitching up lifts the aim as well as dropping the camera. Dropping the
    // camera alone just looks along the ground from lower down; it is the rising
    // aim point that tilts the view into the sky.
    let aimY = CAMERA.LOOK_HEIGHT + walker.height * CAMERA.JUMP_FOLLOW
      - Math.min(0, sinP) * CAMERA.PITCH_LIFT;
    let aimZ = target.z;

    if (this.focus) {
      idealX = this.focus.position.x;
      idealY = this.focus.position.y;
      idealZ = this.focus.position.z;
      aimX = this.focus.aim.x;
      aimY = this.focus.aim.y;
      aimZ = this.focus.aim.z;
    }

    if (!this.initialised) {
      this.position.set(idealX, idealY, idealZ);
      this.aim.set(aimX, aimY, aimZ);
      this.initialised = true;
    }

    // --- the spring
    this.position.x = smoothDamp(this.position.x, idealX, this.posVel, 'x', CAMERA.POS_STIFFNESS, dt);
    this.position.y = smoothDamp(this.position.y, idealY, this.posVel, 'y', CAMERA.POS_STIFFNESS, dt);
    this.position.z = smoothDamp(this.position.z, idealZ, this.posVel, 'z', CAMERA.POS_STIFFNESS, dt);

    this.aim.x = smoothDamp(this.aim.x, aimX, this.aimVel, 'x', CAMERA.AIM_STIFFNESS, dt);
    this.aim.y = smoothDamp(this.aim.y, aimY, this.aimVel, 'y', CAMERA.AIM_STIFFNESS, dt);
    this.aim.z = smoothDamp(this.aim.z, aimZ, this.aimVel, 'z', CAMERA.AIM_STIFFNESS, dt);

    // --- the bob: gentle and low amplitude, per the issue. It rides the walk
    //     cycle so it is in step with the footsteps rather than on its own timer.
    const wantBob = Math.sin(walker.phase * CAMERA.BOB_RATE) * CAMERA.BOB_AMOUNT * gait;
    this.bob += (wantBob - this.bob) * Math.min(1, dt * 12);

    // --- the sprint lens. A few degrees of extra field of view is the cheapest
    //     honest cue that you are moving faster; it eases in and out so it reads
    //     as momentum rather than as a zoom.
    const wantFov = walker.speed > CAMERA.SPRINT_FOV_AT ? CAMERA.SPRINT_FOV : CAMERA.FOV;
    if (Math.abs(camera.fov - wantFov) > 0.01) {
      camera.fov += (wantFov - camera.fov) * Math.min(1, dt * CAMERA.FOV_RATE);
      camera.updateProjectionMatrix();
    }

    camera.position.set(this.position.x, this.position.y + this.bob, this.position.z);
    camera.lookAt(this.aim.x, this.aim.y + this.bob * 0.4, this.aim.z);
  }
}
