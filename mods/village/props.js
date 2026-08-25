// Everything you can see, built from primitives.
//
// No model files: release.sh cannot ship them (see the header in textures.js), and
// the flat-shaded, primitive-built look is the right one for this village anyway.
// Materials all go through curve() from curvature.js so they bend with the horizon;
// a material that skips it will visibly float free of the world at distance.
//
// Shadows are painted blobs, not shadow maps — see curvature.js for why.

import * as THREE from 'three';
import { PALETTE, HOUSE_SCHEMES, LAYOUT, SCREEN } from './config.js';
import { curve, GROUND_SEGMENTS } from './curvature.js';
import {
  cobbleTexture, grassTexture, wallTexture, roofTexture, woodTexture,
  brickTexture, puddleTexture, blobTexture, labelTexture, noticeTexture,
} from './textures.js';
import { houseStyle, hashUnit } from './layout.js';

const LANE_WIDTH = 7.4;
// Metres covered by one repeat of the cobble texture. The texture holds a 4×4 hex
// grid, so this works out at roughly 0.55m per stone — a stone you could step on,
// which is the scale that makes the lane read as cobbles rather than as slabs.
const COBBLE_TILE = 2.2;

// Shared materials — one instance each, so the whole town is a handful of programs.
let shared = null;

function materials() {
  if (shared) return shared;
  const grass = grassTexture();
  grass.repeat.set(56, 56);
  const cobble = cobbleTexture();
  cobble.repeat.set(1, 1);

  shared = {
    grass: curve(new THREE.MeshLambertMaterial({ map: grass })),
    cobble: curve(new THREE.MeshLambertMaterial({ map: cobble })),
    wood: curve(new THREE.MeshLambertMaterial({ map: woodTexture(PALETTE.WOOD, 'wood') })),
    woodDark: curve(new THREE.MeshLambertMaterial({ map: woodTexture(PALETTE.WOOD_DARK, 'woodDark') })),
    white: curve(new THREE.MeshLambertMaterial({ color: PALETTE.WHITE })),
    brick: curve(new THREE.MeshLambertMaterial({ map: brickTexture() })),
    post: curve(new THREE.MeshLambertMaterial({ color: PALETTE.POST_RED })),
    trunk: curve(new THREE.MeshLambertMaterial({ color: PALETTE.TRUNK })),
    leaf: curve(new THREE.MeshLambertMaterial({ color: PALETTE.LEAF, flatShading: true })),
    leafLight: curve(new THREE.MeshLambertMaterial({ color: PALETTE.LEAF_LIGHT, flatShading: true })),
    overgrown: curve(new THREE.MeshLambertMaterial({ color: PALETTE.OVERGROWN, flatShading: true })),
    board: curve(new THREE.MeshLambertMaterial({ color: PALETTE.BOARD })),
    stone: curve(new THREE.MeshLambertMaterial({ color: 0x8b8378 })),
    lantern: new THREE.MeshBasicMaterial({ color: 0xffe6a8 }),
    blob: new THREE.MeshBasicMaterial({
      map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.85,
    }),
    puddle: new THREE.MeshBasicMaterial({
      map: puddleTexture(), transparent: true, depthWrite: false,
      color: 0x9fb4c4, opacity: 0.5, blending: THREE.NormalBlending,
    }),
  };
  return shared;
}

/** A flat painted shadow under a prop. */
function blob(size, y = 0.03) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), materials().blob);
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
}

/** An unlit plate with painted lettering, facing +Z in its own local space. */
function plate(texture, w, h) {
  const mat = curve(new THREE.MeshLambertMaterial({ map: texture, transparent: true }));
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
}

// ── ground and lane ─────────────────────────────────────────────────────────

/**
 * The grass. One big plane, heavily subdivided — the subdivision is not decoration,
 * it is what lets the curvature shader bend it (curvature.js, trap 1).
 */
export function buildGround() {
  const g = new THREE.PlaneGeometry(360, 360, GROUND_SEGMENTS, GROUND_SEGMENTS);
  const mesh = new THREE.Mesh(g, materials().grass);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.02;
  mesh.renderOrder = -2;
  return mesh;
}

/**
 * The cobbled lane, as a ribbon following the layout's polyline.
 *
 * Built as a strip rather than painted onto the ground so the cobbles follow the
 * bends exactly and the texture runs ALONG the road, which is what makes it read
 * as a thoroughfare rather than a texture swap. Four vertices across gives the
 * curvature something to bend at distance.
 */
export function buildLane(town) {
  const pts = town.lane.pts;
  const lens = town.lane.lens;
  const limit = town.laneLength;
  const ACROSS = 4;

  const positions = [];
  const uvs = [];
  const indices = [];
  let rows = 0;

  for (let i = 0; i < pts.length; i++) {
    if (lens[i] > limit) break;
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const mag = Math.hypot(dx, dz) || 1;
    dx /= mag; dz /= mag;
    const nx = -dz;
    const nz = dx;

    // The lane widens into a circle at the square, so the head of the road reads
    // as a place rather than as the end of a strip.
    const squareBulge = Math.max(0, 1 - lens[i] / (LAYOUT.SQUARE_RADIUS * 1.6));
    const halfWidth = (LANE_WIDTH / 2) * (1 + squareBulge * 1.15);

    for (let j = 0; j <= ACROSS; j++) {
      const t = j / ACROSS;
      const off = (t - 0.5) * 2 * halfWidth;
      positions.push(p.x + nx * off, 0, p.z + nz * off);
      // Both axes are metres/TILE, not 0..1 — a normalised u would stretch the
      // stones sideways exactly where the lane widens into the square, which is
      // the one place you stand still and look at them.
      uvs.push((off + halfWidth) / COBBLE_TILE, lens[i] / COBBLE_TILE);
    }
    rows++;
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let j = 0; j < ACROSS; j++) {
      const a = r * (ACROSS + 1) + j;
      const b = a + 1;
      const c = a + (ACROSS + 1);
      const d = c + 1;
      // Winding matters: `across × along` is +Y, so the cobbles face the sky.
      // The other order normals the ribbon downward and back-face culling makes
      // the whole road invisible from where you stand on it.
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, materials().cobble);
  mesh.position.y = 0.012;
  mesh.renderOrder = -1;
  return mesh;
}

/** Puddles, scattered along the lane. Only on the cobbles, where water would sit. */
export function buildPuddles(town, count = 26) {
  const group = new THREE.Group();
  const pts = town.lane.pts;
  const lens = town.lane.lens;
  for (let i = 0; i < count; i++) {
    const s = (i + 0.5) * (town.laneLength / count);
    let idx = 0;
    while (idx < lens.length - 1 && lens[idx] < s) idx++;
    const p = pts[idx];
    if (!p) continue;
    const jitterX = (hashUnit(`pud${i}`, 'x') - 0.5) * LANE_WIDTH * 0.72;
    const jitterZ = (hashUnit(`pud${i}`, 'z') - 0.5) * 4;
    const size = 1.4 + hashUnit(`pud${i}`, 's') * 2.6;

    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 0.72), materials().puddle);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = hashUnit(`pud${i}`, 'r') * Math.PI;
    m.position.set(p.x + jitterX, 0.02, p.z + jitterZ);
    group.add(m);
  }
  return group;
}

// ── a house ─────────────────────────────────────────────────────────────────

/**
 * One project's house.
 *
 * Every dimension that varies is derived from the project id (houseStyle), so a
 * project's house is the same house on every visit. That is the whole point of the
 * building being a building: you learn to recognise it.
 *
 * Returns the group with a `village` bag of live handles on it — the window
 * materials and the mailbox flag pivot — so data.js can light the windows and
 * raise the flag without rebuilding anything.
 */
export function buildHouse(plot) {
  const style = houseStyle(plot.ctxId, HOUSE_SCHEMES.length);
  const scheme = HOUSE_SCHEMES[style.scheme];
  const mat = materials();

  const group = new THREE.Group();
  group.position.set(plot.position.x, 0, plot.position.z);
  group.rotation.y = plot.rotation;

  const W = plot.width;
  const D = plot.depth;
  const wallH = style.storeys === 2 ? 5.0 : 3.5;
  const roofH = (W / 2) * style.roofPitch;
  const eaves = 0.55;

  const wallTex = wallTexture(scheme, style.scheme);
  wallTex.repeat.set(2, style.storeys === 2 ? 1.6 : 1.1);
  const wallMat = curve(new THREE.MeshLambertMaterial({ map: wallTex }));

  // --- walls
  const walls = new THREE.Mesh(new THREE.BoxGeometry(W, wallH, D, 2, 2, 2), wallMat);
  walls.position.y = wallH / 2;
  group.add(walls);

  // --- roof: ridge runs along Z, so the gable faces the lane — the signature
  //     front-on steep triangle.
  const slope = Math.hypot(W / 2 + eaves, roofH);
  const roofTex = roofTexture(scheme, style.scheme);
  roofTex.repeat.set(D / 2.2, slope / 1.7);
  const roofMat = curve(new THREE.MeshLambertMaterial({ map: roofTex }));

  for (const sign of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(slope, 0.26, D + eaves * 2, 3, 1, 3), roofMat);
    panel.position.set(sign * (W / 4 + eaves / 2), wallH + roofH / 2, 0);
    panel.rotation.z = sign * -Math.atan2(roofH, W / 2 + eaves);
    group.add(panel);
  }

  // Gable triangles, filling the ends under the roof.
  const gable = new THREE.Shape();
  gable.moveTo(-W / 2, 0);
  gable.lineTo(W / 2, 0);
  gable.lineTo(0, roofH);
  gable.lineTo(-W / 2, 0);
  const gableGeo = new THREE.ShapeGeometry(gable);
  for (const sign of [-1, 1]) {
    const g = new THREE.Mesh(gableGeo, wallMat);
    g.position.set(0, wallH, sign * (D / 2 + 0.005));
    if (sign < 0) g.rotation.y = Math.PI;
    group.add(g);
  }

  // --- arched door on the lane-facing wall (+Z in local space)
  const door = buildDoor(scheme);
  door.position.set(0, 0, D / 2 + 0.06);
  group.add(door);

  // --- windows, split either side of the door, plus dormers upstairs
  const windowMats = [];
  const winY = style.storeys === 2 ? [1.9, 4.0] : [2.0];
  for (const y of winY) {
    for (let i = 0; i < style.windows; i++) {
      const spread = W * 0.29;
      const x = style.windows === 2
        ? (i === 0 ? -spread : spread)
        : (i - 1) * spread;
      const win = buildWindow(scheme);
      win.position.set(x, y, D / 2 + 0.07);
      group.add(win);
      windowMats.push(win.userData.glass);

      // Matching window on the back wall, so the house isn't hollow from behind.
      const back = buildWindow(scheme);
      back.position.set(-x, y, -D / 2 - 0.07);
      back.rotation.y = Math.PI;
      group.add(back);
      windowMats.push(back.userData.glass);
    }
  }

  if (style.dormer) {
    const dormer = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.5, 1.9), wallMat);
    dormer.position.set(0, wallH + roofH * 0.42, D * 0.18);
    group.add(dormer);
    const dwin = buildWindow(scheme);
    dwin.scale.setScalar(0.72);
    dwin.position.set(0, wallH + roofH * 0.44, D * 0.18 + 1.0);
    group.add(dwin);
    windowMats.push(dwin.userData.glass);
  }

  if (style.chimney) {
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.2, 0.9), mat.brick);
    chimney.position.set(W * 0.26, wallH + roofH * 0.62, -D * 0.22);
    group.add(chimney);
  }

  // --- the project's name, on a board above the door
  const sign = plate(
    labelTexture(shortName(plot.name), { width: 256, height: 48, size: 20 }),
    W * 0.62, W * 0.62 * (48 / 256),
  );
  sign.position.set(0, wallH + 0.22, D / 2 + 0.12);
  group.add(sign);

  // --- the project's own icon, hung beside the door like a shop sign
  const icon = buildIconPlaque(plot.ctx);
  icon.position.set(W * 0.34, 2.35, D / 2 + 0.14);
  group.add(icon);

  group.add(blob(W * 1.5, 0.04));

  group.userData.village = {
    windows: windowMats,
    scheme,
    style,
    litColor: new THREE.Color(PALETTE.WINDOW_LIT),
    darkColor: new THREE.Color(PALETTE.WINDOW_DARK),
  };

  return group;
}

/** An arched wooden door — a rectangle capped with a semicircle, extruded. */
function buildDoor(scheme) {
  const w = 1.5;
  const h = 2.5;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(-w / 2, h - w / 2);
  shape.absarc(0, h - w / 2, w / 2, Math.PI, 0, true);
  shape.lineTo(w / 2, 0);
  shape.lineTo(-w / 2, 0);

  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: false, curveSegments: 8 });
  const doorTex = woodTexture(scheme.door, `door:${scheme.door}`);
  doorTex.repeat.set(1, 1);
  const mesh = new THREE.Mesh(geo, curve(new THREE.MeshLambertMaterial({ map: doorTex })));

  const group = new THREE.Group();
  group.add(mesh);

  // A brass knob, because the door is the thing you walk up to and look at.
  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 8, 6),
    curve(new THREE.MeshLambertMaterial({ color: 0xd8b25a })),
  );
  knob.position.set(w * 0.31, h * 0.44, 0.2);
  group.add(knob);

  // A stone step, so the door meets the ground properly.
  const step = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.14, 0.7), materials().stone);
  step.position.set(0, 0.07, 0.34);
  group.add(step);

  return group;
}

/** A shuttered window. userData.glass is the material data.js re-tints when lit. */
function buildWindow(scheme) {
  const group = new THREE.Group();
  const mat = materials();

  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.16, 1.32, 0.12), mat.white);
  group.add(frame);

  const glassMat = new THREE.MeshLambertMaterial({
    color: PALETTE.WINDOW_DARK,
    emissive: 0x000000,
  });
  curve(glassMat);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 1.0), glassMat);
  glass.position.z = 0.075;
  group.add(glass);

  // Mullions — the cross that makes it read as a cottage window at a glance.
  const barV = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.02, 0.03), mat.white);
  barV.position.z = 0.1;
  group.add(barV);
  const barH = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.09, 0.03), mat.white);
  barH.position.z = 0.1;
  group.add(barH);

  const shutterMat = curve(new THREE.MeshLambertMaterial({ color: scheme.timber }));
  for (const sign of [-1, 1]) {
    const sh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.32, 0.08), shutterMat);
    sh.position.set(sign * 0.73, 0, 0.06);
    group.add(sh);
  }

  group.userData.glass = glassMat;
  return group;
}

/**
 * The project's own icon, as a hanging plaque. Follows the same fallback chain the
 * projects rail uses (public/js/context-views.js:654): uploaded image, then emoji,
 * then a monogram derived from the name.
 *
 * An uploaded SVG goes through an <img> onto a canvas and never into the document
 * — server.js:5382 is explicit that an icon must not be inlined, and a mod page is
 * same-origin, so that rule is ours to keep too.
 */
function buildIconPlaque(ctx) {
  const group = new THREE.Group();
  const SIZE = 0.92;

  const backing = new THREE.Mesh(new THREE.BoxGeometry(SIZE + 0.14, SIZE + 0.14, 0.08), materials().woodDark);
  group.add(backing);

  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(SIZE, SIZE),
    curve(new THREE.MeshLambertMaterial({ map: iconTexture(ctx), transparent: true })),
  );
  face.position.z = 0.05;
  group.add(face);

  // A little bracket, so it hangs rather than floats.
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.3), materials().woodDark);
  arm.position.set(0, SIZE * 0.62, -0.1);
  group.add(arm);

  return group;
}

/** Canvas for a project icon: uploaded image, else emoji, else monogram. */
function iconTexture(ctx) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');

  g.fillStyle = '#f4efe2';
  g.fillRect(0, 0, S, S);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const drawGlyph = (glyph, emoji) => {
    g.fillStyle = '#f4efe2';
    g.fillRect(0, 0, S, S);
    g.fillStyle = '#3a2a1c';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = emoji
      ? `${Math.round(S * 0.62)}px system-ui, "Apple Color Emoji", sans-serif`
      : `${Math.round(S * 0.5)}px "Press Start 2P", monospace`;
    g.fillText(glyph, S / 2, S / 2 + 2);
    tex.needsUpdate = true;
  };

  if (ctx && ctx.iconImage) {
    const img = new Image();
    img.onload = () => {
      g.fillStyle = '#f4efe2';
      g.fillRect(0, 0, S, S);
      g.drawImage(img, 0, 0, S, S);
      tex.needsUpdate = true;
    };
    img.onerror = () => drawGlyph(monogram(ctx.name), false);
    img.src = `/api/contexts/${encodeURIComponent(ctx.id)}/icon`;
    drawGlyph(monogram(ctx?.name), false);
  } else if (ctx && ctx.icon) {
    drawGlyph(ctx.icon, true);
  } else {
    drawGlyph(monogram(ctx?.name), false);
  }

  return tex;
}

function monogram(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  const parts = s.split(/[\s\-_./]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function shortName(name) {
  const s = String(name || '').trim();
  return s.length > 18 ? `${s.slice(0, 17)}…` : s.toUpperCase();
}

// ── mailbox, fence, tree ────────────────────────────────────────────────────

/**
 * A red POST mailbox. userData.village.flag is the pivot data.js rotates when the
 * project has unread agent-chat.
 */
export function buildMailbox() {
  const group = new THREE.Group();
  const mat = materials();

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 1.05, 8), mat.woodDark);
  post.position.y = 0.52;
  group.add(post);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.36, 0.66), mat.post);
  body.position.y = 1.22;
  group.add(body);

  // Rounded lid — a half cylinder lying along Z.
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.66, 10, 1, false, 0, Math.PI), mat.post);
  lid.rotation.z = Math.PI / 2;
  lid.rotation.y = Math.PI / 2;
  lid.position.y = 1.40;
  group.add(lid);

  const post_label = plate(
    labelTexture('POST', { width: 128, height: 40, size: 20, bg: '#f4efe2', fg: '#c0392b' }),
    0.4, 0.4 * (40 / 128),
  );
  post_label.position.set(0, 1.24, 0.34);
  group.add(post_label);

  // The flag, on a pivot at its base so it swings up as one piece.
  const flagPivot = new THREE.Group();
  flagPivot.position.set(0.24, 1.16, -0.1);
  const flagArm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.05), mat.white);
  flagArm.position.y = 0.17;
  flagPivot.add(flagArm);
  const flagBlade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.26), mat.post);
  flagBlade.position.set(0, 0.3, 0.14);
  flagPivot.add(flagBlade);
  flagPivot.rotation.x = FLAG_DOWN;
  group.add(flagPivot);

  group.add(blob(1.1, 0.03));
  group.userData.village = { flag: flagPivot };
  return group;
}

export const FLAG_DOWN = -Math.PI / 2.1;
export const FLAG_UP = 0;

/** White picket fence along the front of a lot, with a gap for the path. */
export function buildFence(plot) {
  const style = houseStyle(plot.ctxId, HOUSE_SCHEMES.length);
  const group = new THREE.Group();
  const mat = materials();

  const span = plot.width + 3.2;
  const count = 17;
  const gapAt = 7 + style.fenceGap; // where the path breaks the run
  const picket = new THREE.BoxGeometry(0.14, 0.92, 0.07);

  for (let i = 0; i < count; i++) {
    if (i >= gapAt && i <= gapAt + 2) continue;
    const x = -span / 2 + (i / (count - 1)) * span;
    const p = new THREE.Mesh(picket, mat.white);
    p.position.set(x, 0.46, 0);
    group.add(p);
    // The pointed cap.
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.16, 4), mat.white);
    cap.rotation.y = Math.PI / 4;
    cap.position.set(x, 0.99, 0);
    group.add(cap);
  }

  // Two rails, broken at the gap.
  for (const y of [0.28, 0.72]) {
    for (const seg of [[0, gapAt - 1], [gapAt + 3, count - 1]]) {
      const x0 = -span / 2 + (seg[0] / (count - 1)) * span;
      const x1 = -span / 2 + (seg[1] / (count - 1)) * span;
      const len = x1 - x0;
      if (len <= 0.1) continue;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.09, 0.05), mat.white);
      rail.position.set(x0 + len / 2, y, 0);
      group.add(rail);
    }
  }

  return group;
}

/** A chunky low-poly tree. */
export function buildTree(seed, overgrown = false) {
  const group = new THREE.Group();
  const mat = materials();
  const h = 2.2 + hashUnit(seed, 'th') * 1.4;

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.26, h, 7), mat.trunk);
  trunk.position.y = h / 2;
  group.add(trunk);

  const leafMat = overgrown ? mat.overgrown : mat.leaf;
  const blobs = 3;
  for (let i = 0; i < blobs; i++) {
    const r = 1.15 - i * 0.24 + hashUnit(seed, `r${i}`) * 0.3;
    const ball = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r, 0),
      i === 1 ? (overgrown ? mat.overgrown : mat.leafLight) : leafMat,
    );
    ball.position.set(
      (hashUnit(seed, `x${i}`) - 0.5) * 0.7,
      h + 0.3 + i * 0.62,
      (hashUnit(seed, `z${i}`) - 0.5) * 0.7,
    );
    ball.rotation.set(hashUnit(seed, `a${i}`) * 3, hashUnit(seed, `b${i}`) * 3, 0);
    group.add(ball);
  }

  group.add(blob(2.6, 0.03));
  return group;
}

/** Long grass and a couple of boards — what an archived project's lot grows. */
export function buildOvergrowth(plot) {
  const group = new THREE.Group();
  const mat = materials();

  for (let i = 0; i < 22; i++) {
    const a = hashUnit(`${plot.ctxId}g${i}`, 'a') * Math.PI * 2;
    const d = 1.5 + hashUnit(`${plot.ctxId}g${i}`, 'd') * (plot.width * 0.8);
    const hgt = 0.5 + hashUnit(`${plot.ctxId}g${i}`, 'h') * 0.8;
    const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.3, hgt, 4), mat.overgrown);
    tuft.position.set(Math.cos(a) * d, hgt / 2, Math.sin(a) * d);
    tuft.rotation.y = a;
    group.add(tuft);
  }

  // Boards nailed across the door.
  for (let i = 0; i < 2; i++) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.26, 0.1), mat.wood);
    board.position.set(0, 1.1 + i * 0.9, plot.depth / 2 + 0.24);
    board.rotation.z = (i === 0 ? 1 : -1) * 0.16;
    group.add(board);
  }

  return group;
}

// ── the square ──────────────────────────────────────────────────────────────

/**
 * The brick NOTICE board.
 *
 * Notices are added and removed by data.js — one sheet of paper per session that is
 * waiting for input, which is the same `waitingForInput` flag the Action Required
 * mod reads. userData.village.pinboard is the group they go in.
 */
/**
 * A project's name, on a marker that floats above its roof.
 *
 * The name board over each door was unreadable from the lane, so finding one
 * particular project meant walking the whole town reading doors. This is the
 * wayfinding layer: big, billboarded, and visible right down the lane, so you
 * spot the house you want from where you are standing instead of hunting.
 *
 * Billboarded on the CPU, which is rotation only and therefore safe under the
 * curvature shader (curvature.js, trap 3 — it is *positions* that must not be
 * computed CPU-side, and this mesh's position is a plain world coordinate).
 */
export function buildNameMarker(name) {
  const group = new THREE.Group();

  const tex = labelTexture(String(name || '?').toUpperCase(), {
    width: 512, height: 96, size: 34,
    bg: '#2f2419', fg: '#ffeec4', border: '#ffeec4',
    key: `marker:${name}`,
  });
  const W = 5.0;
  const sign = plate(tex, W, W * (96 / 512));
  group.add(sign);

  // A small pin below it, so the label reads as planted on the house rather than
  // hovering unattached above it.
  const pin = new THREE.Mesh(
    new THREE.ConeGeometry(0.26, 0.62, 4),
    curve(new THREE.MeshLambertMaterial({ color: 0x2f2419 })),
  );
  pin.position.y = -W * (96 / 512) / 2 - 0.28;
  pin.rotation.y = Math.PI / 4;
  pin.rotation.x = Math.PI;
  group.add(pin);

  group.userData.village = { sign, pin };
  return group;
}

/**
 * A project's board: the same posted, framed, hooded thing as the square's notice
 * board, because the village already has one idiom for "something you stand and
 * read" and a live session is exactly that. What is behind the glass is a screen
 * rather than pinned paper.
 *
 * Built dark. Exactly one board in the town is lit at a time — see lightBoard().
 */
export function buildProjectBoard() {
  const group = new THREE.Group();
  const mat = materials();
  const W = SCREEN.WIDTH;
  const H = SCREEN.HEIGHT;
  const midY = SCREEN.SILL + H / 2;
  const postH = SCREEN.SILL + H + 0.34;

  const posts = [];
  for (const sign of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, postH, 0.24), mat.woodDark);
    post.position.set(sign * (W / 2 + 0.3), postH / 2, -0.08);
    group.add(post);
    posts.push({ mesh: post, sign });
  }

  // Frame, hood and panel live under one node and are scaled together, so the
  // woodwork hugs the terminal whatever shape it turns out to be. Fixed woodwork
  // around a letterboxed panel reads as a mounting error, not as a board.
  const rig = new THREE.Group();
  rig.position.y = midY;
  group.add(rig);

  const frame = new THREE.Mesh(new THREE.BoxGeometry(W + 0.44, H + 0.44, 0.2, 3, 3, 1), mat.wood);
  frame.position.z = -0.12;
  rig.add(frame);

  // A shallow hood. It is raining in this village, and an unhooded screen in the
  // rain reads as a mistake rather than as a fixture.
  const hood = new THREE.Mesh(new THREE.BoxGeometry(W + 0.8, 0.16, 0.66), mat.woodDark);
  hood.position.set(0, H / 2 + 0.34, 0.12);
  hood.rotation.x = -0.2;
  rig.add(hood);

  // The panel. Tessellated deliberately — curvature.js trap 1: a two-triangle
  // plane has no interior vertices for the bend to move, so it tilts out of the
  // world instead of sitting in it. MeshBasic because a screen emits its own
  // light; a Lambert panel would go grey under the overcast sky.
  const panelMat = curve(new THREE.MeshBasicMaterial({ color: PALETTE.WINDOW_DARK }));
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(W, H, 8, 6), panelMat);
  panel.position.z = 0.015;
  rig.add(panel);

  group.add(blob(W * 1.15, 0.03));

  // fitW/fitH are what the panel currently measures in metres. The camera reads
  // them to work out how far back to stand, so they are state, not decoration.
  group.userData.village = { panel, panelMat, rig, posts, postH, midY, fitW: W, fitH: H };
  fitBoard(group.userData.village, W, H);
  return group;
}

/** Resize the woodwork and the glass together to a panel of w × h metres. */
function fitBoard(bag, w, h) {
  bag.rig.scale.set(w / SCREEN.WIDTH, h / SCREEN.HEIGHT, 1);
  const top = bag.midY + h / 2 + 0.4;
  for (const p of bag.posts) {
    p.mesh.scale.y = top / bag.postH;
    p.mesh.position.y = top / 2;
    p.mesh.position.x = p.sign * (w / 2 + 0.3);
  }
  bag.fitW = w;
  bag.fitH = h;
}

/**
 * Put a live terminal behind the glass.
 *
 * `aspect` is the mirror canvas's own width/height, and the panel is fitted to it
 * inside the WIDTH×HEIGHT box — letterboxed, never stretched. A terminal squashed
 * to someone else's rectangle is a terminal you cannot read, and the session's
 * geometry is not ours to choose.
 */
export function lightBoard(board, texture, aspect) {
  const bag = board.userData.village;
  if (!bag) return;
  bag.panelMat.map = texture;
  bag.panelMat.color.set(0xffffff);
  bag.panelMat.needsUpdate = true;

  if (aspect > 0) {
    const boxAspect = SCREEN.WIDTH / SCREEN.HEIGHT;
    const w = aspect >= boxAspect ? SCREEN.WIDTH : SCREEN.HEIGHT * aspect;
    const h = aspect >= boxAspect ? SCREEN.WIDTH / aspect : SCREEN.HEIGHT;
    fitBoard(bag, w, h);
  }
}

/** Back to dark glass — the board you just walked away from. */
export function darkenBoard(board) {
  const bag = board.userData.village;
  if (!bag) return;
  bag.panelMat.map = null;
  bag.panelMat.color.set(PALETTE.WINDOW_DARK);
  bag.panelMat.needsUpdate = true;
  fitBoard(bag, SCREEN.WIDTH, SCREEN.HEIGHT);
}

export function buildNoticeBoard() {
  const group = new THREE.Group();
  const mat = materials();

  const W = 3.6;
  const H = 2.4;

  for (const sign of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.28, 2.5, 0.28), mat.woodDark);
    post.position.set(sign * (W / 2 - 0.2), 1.25, 0);
    group.add(post);
  }

  const brickTex = brickTexture();
  brickTex.repeat.set(2.2, 1.5);
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(W, H, 0.22, 3, 2, 1),
    curve(new THREE.MeshLambertMaterial({ map: brickTex })),
  );
  back.position.y = 2.0;
  group.add(back);

  // Wooden frame around the brick.
  const frameMat = mat.woodDark;
  for (const [w, h, x, y] of [[W + 0.3, 0.22, 0, H + 0.9], [W + 0.3, 0.22, 0, 2.0 - H / 2 - 0.11]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.3), frameMat);
    bar.position.set(x, y, 0);
    group.add(bar);
  }
  for (const sign of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.22, H + 0.44, 0.3), frameMat);
    bar.position.set(sign * (W / 2 + 0.04), 2.0, 0);
    group.add(bar);
  }

  // A little shingled hood, so notices stay dry-ish.
  const hood = new THREE.Mesh(new THREE.BoxGeometry(W + 0.8, 0.16, 0.9), mat.wood);
  hood.position.set(0, H + 1.05, 0.3);
  hood.rotation.x = -0.22;
  group.add(hood);

  const title = plate(
    labelTexture('NOTICE', { width: 256, height: 56, size: 26, bg: '#4a3018', fg: '#f4efe2', border: null }),
    1.9, 1.9 * (56 / 256),
  );
  title.position.set(0, H + 0.9, 0.17);
  group.add(title);

  const pinboard = new THREE.Group();
  pinboard.position.z = 0.13;
  group.add(pinboard);

  group.add(blob(4.6, 0.03));
  group.userData.village = { pinboard, width: W, height: H };
  return group;
}

/** One paper notice, sized to sit on the board. */
export function buildNotice(variant) {
  const w = 0.52;
  const h = 0.72;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    curve(new THREE.MeshLambertMaterial({ map: noticeTexture(variant % 4), transparent: true })),
  );
  return mesh;
}

/** A lamp post with an always-on lantern — the square's warm point in the rain. */
export function buildLamp() {
  const group = new THREE.Group();
  const mat = materials();

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 3.4, 8), mat.woodDark);
  post.position.y = 1.7;
  group.add(post);

  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.08), mat.woodDark);
  arm.position.set(0, 3.4, 0);
  group.add(arm);

  const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.42), mat.lantern);
  lantern.position.y = 3.18;
  group.add(lantern);

  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.28, 4), mat.woodDark);
  cap.rotation.y = Math.PI / 4;
  cap.position.y = 3.56;
  group.add(cap);

  const glow = new THREE.PointLight(0xffd9a0, 12, 14, 2);
  glow.position.y = 3.18;
  group.add(glow);

  group.add(blob(1.4, 0.03));
  return group;
}

/** A signpost at the head of the lane. Sets the tone before you start walking. */
export function buildTownSign(text) {
  const group = new THREE.Group();
  const mat = materials();

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2.1, 8), mat.woodDark);
  post.position.y = 1.05;
  group.add(post);

  const board = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.72, 0.12), mat.wood);
  board.position.y = 1.9;
  group.add(board);

  for (const sign of [-1, 1]) {
    const face = plate(
      labelTexture(text, { width: 256, height: 64, size: 22, bg: '#8a6134', fg: '#f9f2e2', border: '#4a3018' }),
      2.3, 2.3 * (64 / 256),
    );
    face.position.set(0, 1.9, sign * 0.07);
    if (sign < 0) face.rotation.y = Math.PI;
    group.add(face);
  }

  group.add(blob(1.5, 0.03));
  return group;
}

/** Free the shared materials. Called on teardown. */
export function disposeProps() {
  if (!shared) return;
  for (const m of Object.values(shared)) m.dispose?.();
  shared = null;
}
