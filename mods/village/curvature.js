// The curved horizon.
//
// Distant geometry bends down and away, so the town reads as sitting on a small
// sphere rather than on an infinite plane. This is the single most recognisable
// thing about the look the issue is asking for, and it is a vertex-shader trick,
// not real geometry: nothing actually moves, so collision, layout and the whole
// rest of the mod carry on believing the world is flat.
//
// The bend is applied in VIEW space, after modelViewMatrix, which is what makes it
// curve away in every direction from wherever you happen to be standing rather
// than away from some fixed world origin.
//
// Three things here are load-bearing and easy to undo by accident:
//
//   1. GEOMETRY MUST BE TESSELLATED. A vertex shader can only move vertices that
//      exist. A ground plane built as two triangles has four corners and will
//      simply tilt; it needs enough segments that the bend reads as a curve. See
//      GROUND_SEGMENTS.
//
//   2. NO SHADOW MAPS. The depth material that renders a shadow map is a different
//      program and would need the same patch, or objects and their shadows detach
//      as they get further away. The mod uses painted blob shadows instead — the
//      same trick mods/go-karts/go-karts.js:370 uses.
//
//   3. NOTHING IS POSITIONED BY CPU-SIDE PROJECTION. A DOM label placed by
//      projecting a world point would land in the wrong place, because the CPU
//      knows nothing about a displacement that happens on the GPU. That is why
//      every in-world label in this mod is a mesh (curved for free along with
//      everything else) and the one DOM panel sits at a fixed screen position.

import * as THREE from 'three';
import { CURVE } from './config.js';

// Shared across every patched material, so the strength can be tuned live and
// there is exactly one uniform to keep in step.
const curveUniform = { value: CURVE.STRENGTH };

/** The displacement itself, as GLSL. Reused by the hand-written shaders too. */
export const CURVE_GLSL = `
  mvPosition.y -= (mvPosition.x * mvPosition.x + mvPosition.z * mvPosition.z) * uCurveStrength;
`;

// three.js's stock project_vertex chunk, with the bend spliced in between the
// view transform and the projection.
const PATCHED_PROJECT_VERTEX = `
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  mvPosition = modelViewMatrix * mvPosition;
  ${CURVE_GLSL}
  gl_Position = projectionMatrix * mvPosition;
`;

/**
 * Bend one material. Returns the same material, so it composes:
 *   const m = curve(new THREE.MeshLambertMaterial({ color })).
 *
 * The constant customProgramCacheKey is deliberate. three.js appends it to the key
 * it already derives from the material's own parameters and defines, so a single
 * shared string means "all of these carry the same onBeforeCompile edit" — every
 * distinct material still gets its own program, but a Lambert and a Lambert with
 * the same settings share one instead of compiling a variant each.
 */
export function curve(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCurveStrength = curveUniform;
    shader.vertexShader = `uniform float uCurveStrength;\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      PATCHED_PROJECT_VERTEX,
    );
  };
  material.customProgramCacheKey = () => 'village-curve-v1';
  return material;
}

/** The uniform, for a hand-written ShaderMaterial that wants to bend to match. */
export function curveUniformRef() {
  return curveUniform;
}

export function setCurveStrength(value) {
  curveUniform.value = value;
}

// How finely the ground is subdivided. The plane is ~330m across, so this puts a
// vertex roughly every 2.5m — enough that the bend is a curve and not a fold, and
// cheap enough that it is one draw call of static geometry.
export const GROUND_SEGMENTS = 132;

/**
 * Fog is what hides the far edge where the ground has bent below the horizon.
 * It is unaffected by the patch: three.js's fog reads -mvPosition.z, and the bend
 * only touches .y. So the two compose without either knowing about the other.
 */
export function applyFog(scene, color) {
  scene.fog = new THREE.Fog(color, CURVE.FOG_NEAR, CURVE.FOG_FAR);
}
