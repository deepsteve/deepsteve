// Rain, and the overcast sky it falls out of.
//
// The village is a rainy one, and the whole thing is meant to feel
// calm rather than action-y, so the weather is doing mood work, not effects work.
// It is deliberately quiet: slow, thin, slightly slanted, and never loud enough to
// obscure the town.

import * as THREE from 'three';
import { PALETTE, RAIN, CURVE } from './config.js';
import { CURVE_GLSL, curveUniformRef } from './curvature.js';

/**
 * A sky dome that follows the camera.
 *
 * Deliberately NOT curved: the curvature shader bends geometry by its view-space
 * distance, and a dome centred on the viewer has none to speak of — running it
 * through the patch would buy nothing and risk a seam at the horizon. It writes no
 * depth and renders first, so everything else draws over it.
 */
export function buildSky() {
  const geo = new THREE.SphereGeometry(400, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(PALETTE.SKY_TOP) },
      uBottom: { value: new THREE.Color(PALETTE.SKY_BOTTOM) },
      uFog: { value: new THREE.Color(PALETTE.FOG) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vWorld = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform vec3 uFog;
      varying vec3 vWorld;
      void main() {
        float h = normalize(vWorld).y;
        // Overcast: pale and flat near the horizon, a shade heavier overhead.
        vec3 col = mix(uBottom, uTop, smoothstep(-0.05, 0.55, h));
        // Melt into the fog colour at the horizon so the curved ground's far edge
        // has nowhere visible to end.
        col = mix(uFog, col, smoothstep(-0.02, 0.22, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * The rain.
 *
 * Drops are short vertical line segments in a cylinder that rides along with the
 * camera in XZ but stays put in Y, so rain always falls downward in world space
 * however you turn, and the density around you never changes however far you walk.
 *
 * All the animation is in the vertex shader — the CPU touches one uniform per
 * frame. It carries the same curvature displacement as everything else, so a
 * distant sheet of rain leans away with the ground rather than standing up
 * through it.
 */
export class Rain {
  constructor() {
    const count = RAIN.COUNT;
    const positions = new Float32Array(count * 2 * 3);
    const seeds = new Float32Array(count * 2);
    const tips = new Float32Array(count * 2);

    for (let i = 0; i < count; i++) {
      // Even area coverage: sqrt keeps drops from bunching at the centre.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * RAIN.RADIUS;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = Math.random() * RAIN.TOP;
      const seed = Math.random();

      for (let v = 0; v < 2; v++) {
        const o = (i * 2 + v) * 3;
        positions[o] = x;
        positions[o + 1] = y;
        positions[o + 2] = z;
        seeds[i * 2 + v] = seed;
        tips[i * 2 + v] = v; // 0 = bottom of the streak, 1 = top
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute('aTip', new THREE.BufferAttribute(tips, 1));

    this.uniforms = {
      uTime: { value: 0 },
      uTop: { value: RAIN.TOP },
      uFall: { value: RAIN.FALL_SPEED },
      uSlant: { value: RAIN.SLANT },
      uStreak: { value: RAIN.STREAK },
      uRadius: { value: RAIN.RADIUS },
      uCurveStrength: curveUniformRef(),
      uFogColor: { value: new THREE.Color(PALETTE.FOG) },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `
        uniform float uTime;
        uniform float uTop;
        uniform float uFall;
        uniform float uSlant;
        uniform float uStreak;
        uniform float uRadius;
        uniform float uCurveStrength;
        attribute float aSeed;
        attribute float aTip;
        varying float vAlpha;

        void main() {
          // Each drop falls at its own speed and wraps at the top of the column.
          float speed = uFall * (0.75 + aSeed * 0.5);
          float y = mod(position.y - uTime * speed, uTop);

          // A little sideways drift, stronger the further it has fallen, so the
          // sheet leans instead of dropping dead straight.
          float drift = uSlant * (1.0 - y / uTop);
          vec3 world = vec3(position.x + drift, y, position.z);

          // The second vertex of each pair sits above the first: that gap is the
          // streak, and scaling it by speed makes fast drops smear more.
          world.y += aTip * uStreak * (0.7 + aSeed * 0.8);

          vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
          ${CURVE_GLSL}
          gl_Position = projectionMatrix * mvPosition;

          // Fade at the rim of the cylinder so drops do not pop into existence,
          // and near the ground so they read as landing rather than stopping.
          float rim = 1.0 - smoothstep(uRadius * 0.55, uRadius, length(position.xz));
          float floorFade = smoothstep(0.0, 1.4, y);
          vAlpha = rim * floorFade * 0.42;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(0.86, 0.90, 0.95, vAlpha);
        }
      `,
    });

    this.mesh = new THREE.LineSegments(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** Follow the camera in XZ only — Y stays world-space or the rain would tilt. */
  update(dt, camera) {
    if (!this.mesh.visible) return;
    this.uniforms.uTime.value += dt;
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
  }

  setEnabled(on) {
    this.mesh.visible = !!on;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * Lighting. Overcast means soft and shadowless: a strong hemisphere light doing
 * most of the work, and a weak directional only to keep the roofs and walls from
 * flattening into one another. No shadow maps — see curvature.js.
 */
export function buildLights() {
  const group = new THREE.Group();

  const hemi = new THREE.HemisphereLight(0xdfe8ee, 0x5d6b4a, 2.0);
  group.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2dc, 0.85);
  sun.position.set(-24, 34, 16);
  group.add(sun);

  // A cool fill from the opposite side, so the shaded faces read as damp rather
  // than black.
  const fill = new THREE.DirectionalLight(0xa8c0d4, 0.35);
  fill.position.set(20, 14, -22);
  group.add(fill);

  return group;
}

/** Fog colour and range live with the curvature, since that is what they conceal. */
export const FOG = { color: PALETTE.FOG, near: CURVE.FOG_NEAR, far: CURVE.FOG_FAR };
