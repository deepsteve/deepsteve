// Where the town puts things. PURE — no three.js, no DOM, no globals.
//
// The issue's requirement is that the map is generated from the project list, not
// hand-placed: adding a project must add a building without anyone editing a map.
// This file is that generator, and it is kept dependency-free so it can be driven
// directly from a plain Node unit test (test/unit/village-layout.test.js).
//
// The one property worth stating outright, because it is easy to lose and hard to
// notice: **the lane does not depend on how many projects there are.** Control
// points come from a fixed formula over an unbounded index, and house k sits at a
// fixed arc length along it. So registering a new project appends a house at the
// end and moves nothing that was already there. Normalising the curve to the
// project count — the obvious alternative — would reshuffle the whole town every
// time you registered a repo, and your village would never be the same place twice.

import { LAYOUT } from './config.js';

// ── deterministic hashing ───────────────────────────────────────────────────
// FNV-1a. A house's look is derived from its project id, so it is stable across
// reloads, across machines, and across whatever order /api/contexts returns.

export function hashStr(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A stable 0..n-1 pick for `id`, varied by `salt` so one id can drive several choices. */
export function hashPick(id, salt, n) {
  return hashStr(`${salt}:${id}`) % n;
}

/** A stable float in [0,1) for `id`/`salt`. */
export function hashUnit(id, salt) {
  return hashStr(`${salt}:${id}`) / 0x100000000;
}

// ── the lane ────────────────────────────────────────────────────────────────

/**
 * Control point i of the lane. Runs away down -Z, wandering in X.
 * A pure function of i alone — that is what keeps existing houses put.
 */
function controlPoint(i) {
  return {
    x: Math.sin(i * LAYOUT.WANDER_RATE) * LAYOUT.WANDER,
    z: -i * LAYOUT.CONTROL_SPACING,
  };
}

/** Catmull-Rom (uniform, tension 0.5) through p0..p3 at t. */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) };
}

/**
 * Sample the lane into a dense polyline with cumulative arc length, long enough to
 * cover `needLength` metres. `stepsPerSpan` fixes the sampling density, so the
 * samples for a given arc length are identical no matter how long the town is.
 */
function sampleLane(needLength, stepsPerSpan = 12) {
  const pts = [];
  const lens = [0];
  let total = 0;
  let span = 0;

  pts.push(controlPoint(0));
  while (total < needLength && span < 4096) {
    const p0 = controlPoint(span - 1);
    const p1 = controlPoint(span);
    const p2 = controlPoint(span + 1);
    const p3 = controlPoint(span + 2);
    for (let s = 1; s <= stepsPerSpan; s++) {
      const pt = catmullRom(p0, p1, p2, p3, s / stepsPerSpan);
      const prev = pts[pts.length - 1];
      total += Math.hypot(pt.x - prev.x, pt.z - prev.z);
      pts.push(pt);
      lens.push(total);
    }
    span++;
  }
  return { pts, lens, total };
}

/** Position and unit tangent at arc length `s` along a sampled lane. */
function atLength(lane, s) {
  const { pts, lens } = lane;
  const target = Math.max(0, Math.min(s, lens[lens.length - 1]));

  let lo = 0;
  let hi = lens.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (lens[mid] <= target) lo = mid;
    else hi = mid;
  }

  const segLen = lens[hi] - lens[lo] || 1;
  const t = (target - lens[lo]) / segLen;
  const a = pts[lo];
  const b = pts[hi];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const mag = Math.hypot(dx, dz) || 1;

  return {
    point: { x: a.x + dx * t, z: a.z + dz * t },
    tangent: { x: dx / mag, z: dz / mag },
  };
}

// ── the town ────────────────────────────────────────────────────────────────

/**
 * Build the whole town from the project list.
 *
 * @param {Array} contexts  /api/contexts rows: {id, name, dirs, icon, iconImage, archived}
 * @param {Object} opts     { showArchived }
 * @returns {Object} { lane, plots, square, spawn, bounds }
 *
 * Ordering note: the live list is used as-is for the main lane, so the town matches
 * the order of the projects rail. Archived lots are pulled out and hung off the far
 * end of the lane instead, which is what makes an archived project read as "still
 * here, just not somewhere you go".
 */
export function buildTown(contexts, opts = {}) {
  const showArchived = opts.showArchived !== false;
  const list = Array.isArray(contexts) ? contexts.filter((c) => c && c.id) : [];

  const active = list.filter((c) => !c.archived);
  const archived = showArchived ? list.filter((c) => c.archived) : [];

  // Long enough for every active house, the archived spur, and a tail of empty road.
  const activeSpan = LAYOUT.FIRST_PLOT_AT + Math.max(0, active.length - 1) * LAYOUT.PLOT_SPACING;
  const archivedSpan = archived.length
    ? LAYOUT.PLOT_SPACING + archived.length * LAYOUT.ARCHIVED_SPACING
    : 0;
  const needed = activeSpan + archivedSpan + LAYOUT.TAIL;

  const lane = sampleLane(needed + LAYOUT.CONTROL_SPACING);
  const plots = [];

  active.forEach((ctx, i) => {
    const s = LAYOUT.FIRST_PLOT_AT + i * LAYOUT.PLOT_SPACING;
    // Alternate sides so the lane always has a house facing a house.
    plots.push(makePlot(ctx, lane, s, i % 2 === 0 ? -1 : 1, LAYOUT.PLOT_OFFSET, i, false));
  });

  archived.forEach((ctx, i) => {
    const s = activeSpan + LAYOUT.PLOT_SPACING + i * LAYOUT.ARCHIVED_SPACING;
    plots.push(makePlot(ctx, lane, s, i % 2 === 0 ? 1 : -1, LAYOUT.ARCHIVED_OFFSET, active.length + i, true));
  });

  const head = atLength(lane, 0);
  // Spawn a few metres INTO the lane rather than at its very start, so you arrive
  // standing on the cobbled square looking down the road, not on the grass behind it.
  const start = atLength(lane, LAYOUT.SQUARE_RADIUS * 0.55);
  const bounds = boundsOf(lane, plots);

  return {
    lane,
    plots,
    laneLength: activeSpan + archivedSpan + LAYOUT.TAIL,
    square: { x: head.point.x, z: head.point.z, radius: LAYOUT.SQUARE_RADIUS },
    // Facing down the lane, so the first thing you see is the town.
    spawn: {
      x: start.point.x,
      z: start.point.z,
      heading: Math.atan2(start.tangent.x, start.tangent.z),
    },
    bounds,
  };
}

/** One lot: the house box, where its door is, and which way it faces. */
function makePlot(ctx, lane, s, side, offset, index, archived) {
  const { point, tangent } = atLength(lane, s);
  // Left normal of the tangent in the XZ plane.
  const nx = -tangent.z;
  const nz = tangent.x;

  const x = point.x + nx * offset * side;
  const z = point.z + nz * offset * side;

  // Face the lane: the house's +Z points back at the road.
  const towardLaneX = -nx * side;
  const towardLaneZ = -nz * side;
  const rotation = Math.atan2(towardLaneX, towardLaneZ);

  const half = LAYOUT.HOUSE_DEPTH / 2;
  return {
    ctxId: ctx.id,
    name: ctx.name || ctx.id,
    ctx,
    index,
    archived,
    side,
    laneAt: s,
    position: { x, z },
    rotation,
    width: LAYOUT.HOUSE_WIDTH,
    depth: LAYOUT.HOUSE_DEPTH,
    // The door sits on the lane-facing wall; `facing` points from it out to the road.
    door: { x: x + towardLaneX * half, z: z + towardLaneZ * half },
    facing: { x: towardLaneX, z: towardLaneZ },
    // Where you must stand for the card to open — a step out from the door.
    stand: { x: x + towardLaneX * (half + 2.4), z: z + towardLaneZ * (half + 2.4) },
    lanePoint: point,
  };
}

function boundsOf(lane, plots) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const eat = (x, z, pad) => {
    minX = Math.min(minX, x - pad);
    maxX = Math.max(maxX, x + pad);
    minZ = Math.min(minZ, z - pad);
    maxZ = Math.max(maxZ, z + pad);
  };
  for (const p of lane.pts) eat(p.x, p.z, LAYOUT.PLOT_OFFSET);
  for (const p of plots) eat(p.position.x, p.position.z, Math.max(p.width, p.depth));
  if (!plots.length) eat(0, 0, LAYOUT.SQUARE_RADIUS * 2);
  return { minX, maxX, minZ, maxZ };
}

/**
 * Distance from (x,z) to the centre-line of the lane. Used to decide where cobbles
 * stop and grass starts, and to keep puddles on the road.
 */
export function distanceToLane(lane, x, z) {
  let best = Infinity;
  const pts = lane.pts;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = len2 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/** The house's look, derived from its project id so it never changes under you. */
export function houseStyle(ctxId, schemeCount) {
  return {
    scheme: hashPick(ctxId, 'scheme', schemeCount),
    roofPitch: 0.82 + hashUnit(ctxId, 'pitch') * 0.5,
    windows: 2 + hashPick(ctxId, 'windows', 2),
    chimney: hashUnit(ctxId, 'chimney') > 0.35,
    dormer: hashUnit(ctxId, 'dormer') > 0.55,
    storeys: hashUnit(ctxId, 'storeys') > 0.62 ? 2 : 1,
    fenceGap: hashPick(ctxId, 'gap', 3),
    treeSide: hashUnit(ctxId, 'tree') > 0.5 ? 1 : -1,
    hasTree: hashUnit(ctxId, 'hastree') > 0.3,
  };
}
