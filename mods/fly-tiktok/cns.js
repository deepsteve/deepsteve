// The fly's central nervous system as an object: every neuron of the circuit at its own soma
// position from the connectome, inside a rough shell of the brain and nerve cord, at true scale in
// the model fly. No DOM and no three.js, so tests run it in Node (test/cns.test.mjs).
//
//   const cns = layoutCns(brain.circuit, flyMeta);
//   cns.positions  // Float32Array: x, y, z per neuron, cm, in the model's thorax frame
//   cns.shell      // { positions, normals, indices }, the same frame
//
// The thorax frame is MuJoCo's, as in fly.json: x forward, y to the fly's left, z up.
//
// Where each part comes from:
//
// - Positions are neuPrint's somaLocation (the circuit files keep it as `soma`), in voxels of
//   source.voxelSize nm. In male-cns:v1.0, x grows toward the fly's left, y ventrally and z
//   posteriorly, judged by anatomy rather than assumed: DNp01(GF)_R sits at a lower x than
//   DNp01(GF)_L; neurons of the superior neuropils (SMP, SLP, SIP) have their somas at a lower y than
//   the gnathal and saddle ones (GNG, SAD, PRW); and anterior ventrolateral ones (AVLP) at a lower z
//   than posterior ventrolateral ones (PVLP) and lobula projection neurons (LC, LPLC). The test
//   checks all of it, so a dataset laid out differently fails there instead of drawing a brain
//   upside down or mirrored.
// - A few neurons have no soma in the volume, mostly sensory neurons, whose cell bodies are outside
//   the nervous system. They sit at the synapse-weighted centre of their partners, pushed a little
//   apart so they don't stack. `placed` says which.
// - The brain and nerve cord are split where the somas have a long empty stretch along the body
//   axis: the neck.
// - flybody's fly is modelled in cm at real size, so a micron is 0.0001 cm and the brain comes out
//   at its own size. Its centre goes to the middle of the model's eyes, where the optic lobes are.
//   The sample's brain and nerve cord keep their relative position, which lands the cord in the
//   front of the thorax, where a fly's is.
// - The shell is not traced anatomy. Insect cell bodies sit in a rind around the neuropil, so the
//   somas outline the surface: the brain is an ellipsoid around them, with an optic lobe on each
//   side, a neck, and a nerve cord of three thoracic neuromeres and an abdominal tail.

export const CM_PER_UM = 1e-4;
export const BRAIN = 0;
export const CORD = 1;
const NECK_GAP_UM = 150; // no somas along this much of the body axis: the neck
const SHELL_STEP_UM = 10;

export function layoutCns(circuit, flyMeta) {
  const { neurons } = circuit;
  const N = neurons.length;
  const nm = circuit.source?.voxelSize?.[0] ?? 8;
  const um = new Float64Array(N * 3);
  const placed = new Uint8Array(N);
  const hasSoma = new Uint8Array(N);
  neurons.forEach((n, i) => {
    if (!Array.isArray(n.soma)) return;
    hasSoma[i] = 1;
    for (let k = 0; k < 3; k++) um[i * 3 + k] = (n.soma[k] * nm) / 1000;
  });

  // Neurons without a soma: among their partners.
  const sum = new Float64Array(N * 4);
  for (let c = 0; c < circuit.pre.length; c++) {
    const a = circuit.pre[c], b = circuit.post[c], w = circuit.weight[c];
    for (const [self, other] of [[a, b], [b, a]]) {
      if (hasSoma[self] || !hasSoma[other]) continue;
      for (let k = 0; k < 3; k++) sum[self * 4 + k] += w * um[other * 3 + k];
      sum[self * 4 + 3] += w;
    }
  }
  const somaIdx = [...Array(N).keys()].filter(i => hasSoma[i]);
  const mean = k => somaIdx.reduce((s, i) => s + um[i * 3 + k], 0) / Math.max(1, somaIdx.length);
  for (let i = 0; i < N; i++) {
    if (hasSoma[i]) continue;
    placed[i] = 1;
    const random = mulberry32(neurons[i].bodyId >>> 0);
    for (let k = 0; k < 3; k++) {
      const w = sum[i * 4 + 3];
      um[i * 3 + k] = (w > 0 ? sum[i * 4 + k] / w : mean(k)) + (random() * 2 - 1) * 14;
    }
  }

  // Brain and nerve cord, split at the neck.
  const zs = [...Array(N).keys()].map(i => um[i * 3 + 2]).sort((a, b) => a - b);
  let neckZ = Infinity;
  let widest = NECK_GAP_UM;
  for (let k = 1; k < zs.length; k++) {
    if (zs[k] - zs[k - 1] > widest) {
      widest = zs[k] - zs[k - 1];
      neckZ = (zs[k] + zs[k - 1]) / 2;
    }
  }
  const region = new Uint8Array(N);
  for (let i = 0; i < N; i++) region[i] = um[i * 3 + 2] > neckZ ? CORD : BRAIN;

  // Grown until it holds every soma, since an ellipsoid fitted to a box misses the box's corners:
  // each time along the one axis the worst-placed soma sticks out on, and toward it, so the shell
  // neither balloons nor grows away from the soma it is reaching for.
  const scale = [[1, 1, 1], [1, 1, 1]];
  const shift = [[0, 0, 0], [0, 0, 0]];
  let field;
  for (let attempt = 0; attempt < 60; attempt++) {
    field = shellField(um, region, scale, shift);
    const worst = [null, null];
    for (let i = 0; i < N; i++) {
      const f = field.at(um[i * 3], um[i * 3 + 1], um[i * 3 + 2]);
      if (f >= -3 && (!worst[region[i]] || f > worst[region[i]].f)) worst[region[i]] = { i, f };
    }
    if (!worst[BRAIN] && !worst[CORD]) break;
    for (const r of [BRAIN, CORD]) {
      if (!worst[r]) continue;
      const { centre, radii } = field.fitted[r];
      const q = [0, 1, 2].map(k => (um[worst[r].i * 3 + k] - centre[k]) / radii[k]);
      const k = q.map(Math.abs).indexOf(Math.max(...q.map(Math.abs)));
      scale[r][k] *= 1.02;
      shift[r][k] += Math.sign(q[k]) * 0.02 * radii[k];
    }
  }
  const anchor = eyeCentre(flyMeta);
  const centre = field.brainCentre;
  const toFly = (x, y, z, out, o) => {
    out[o] = anchor[0] - (z - centre[2]) * CM_PER_UM;
    out[o + 1] = anchor[1] + (x - centre[0]) * CM_PER_UM;
    out[o + 2] = anchor[2] - (y - centre[1]) * CM_PER_UM;
  };

  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) toFly(um[i * 3], um[i * 3 + 1], um[i * 3 + 2], positions, i * 3);

  const mesh = surfaceNets(field.at, field.lo, field.hi, SHELL_STEP_UM);
  const shellPositions = new Float32Array(mesh.positions.length);
  const shellNormals = new Float32Array(mesh.normals.length);
  for (let v = 0; v < mesh.positions.length; v += 3) {
    toFly(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2], shellPositions, v);
    // The same turn as the positions, which is a rotation, so normals keep their length.
    shellNormals[v] = -mesh.normals[v + 2];
    shellNormals[v + 1] = mesh.normals[v];
    shellNormals[v + 2] = -mesh.normals[v + 1];
  }

  return {
    positions, region, placed, um, anchor,
    fieldAt: field.at, // µm, in the sample's frame; below zero is inside the shell
    shell: { positions: shellPositions, normals: shellNormals, indices: mesh.indices },
  };
}

// The rough shell, as a signed distance-like function in µm: negative inside. Sized to hold every
// soma, since they are the surface. `scale` grows the brain's and the nerve cord's parts, per axis.
export function shellField(um, region, scale = [[1, 1, 1], [1, 1, 1]], shift = [[0, 0, 0], [0, 0, 0]]) {
  const brain = [], cord = [];
  for (let i = 0; i < region.length; i++) (region[i] === CORD ? cord : brain).push(i);
  const box = members => [0, 1, 2].map(k => {
    let lo = Infinity, hi = -Infinity;
    for (const i of members) {
      lo = Math.min(lo, um[i * 3 + k]);
      hi = Math.max(hi, um[i * 3 + k]);
    }
    return { mid: (lo + hi) / 2, half: (hi - lo) / 2 };
  });

  const shapes = [];
  let blend = 40; // how softly each part joins the ones before it, µm
  const ellipsoid = (c, r) => shapes.push({ capsule: false, a: c, r, blend });
  const b = box(brain);
  const c = b.map(a => a.mid);
  const fitted = b.map(a => a.half + 25);
  const r = fitted.map((v, k) => v * scale[BRAIN][k]); // only the central brain grows; the lobes stay put
  const lobe = [0.42 * fitted[0], 0.95 * fitted[1], 0.72 * fitted[2]];
  ellipsoid(c.map((v, k) => v + shift[BRAIN][k]), r);
  ellipsoid([c[0] - 1.02 * fitted[0], c[1], c[2] + 0.1 * fitted[2]], lobe);
  ellipsoid([c[0] + 1.02 * fitted[0], c[1], c[2] + 0.1 * fitted[2]], lobe);
  const fittedParts = [{ centre: c.map((v, k) => v + shift[BRAIN][k]), radii: r }];
  const lo = [c[0] - 1.6 * r[0], c[1] - 1.2 * r[1], c[2] - 1.2 * r[2]];
  const hi = [c[0] + 1.6 * r[0], c[1] + 1.2 * r[1], c[2] + 1.2 * r[2]];

  if (cord.length) {
    blend = 22; // the neuromeres stay distinct
    const d = box(cord);
    const v = d.map((a, k) => a.mid + shift[CORD][k]);
    const h = d.map(a => a.half);
    const neuromere = [(h[0] + 25) * scale[CORD][0], (h[1] + 25) * scale[CORD][1], (0.4 * h[2] + 25) * scale[CORD][2]];
    ellipsoid([v[0], v[1], v[2] - 0.66 * h[2]], neuromere);
    ellipsoid(v, [0.92 * neuromere[0], 0.92 * neuromere[1], neuromere[2]]);
    ellipsoid([v[0], v[1], v[2] + 0.66 * h[2]], [0.82 * neuromere[0], 0.85 * neuromere[1], neuromere[2]]);
    ellipsoid([v[0], v[1], v[2] + 1.25 * h[2]], [0.4 * neuromere[0], 0.45 * neuromere[1], 0.5 * neuromere[2]]);
    fittedParts[CORD] = { centre: v, radii: [neuromere[0], neuromere[1], h[2] + 25] };
    shapes.push({ capsule: true, a: [c[0], c[1] + 0.55 * r[1], c[2] + 0.45 * r[2]], b: [v[0], v[1] - 0.3 * h[1], v[2] - 0.9 * h[2]], radius: 32, blend: 30 });
    lo[0] = Math.min(lo[0], v[0] - neuromere[0] - 30);
    hi[0] = Math.max(hi[0], v[0] + neuromere[0] + 30);
    lo[1] = Math.min(lo[1], v[1] - neuromere[1] - 30);
    hi[1] = Math.max(hi[1], v[1] + neuromere[1] + 30);
    hi[2] = Math.max(hi[2], v[2] + 1.25 * h[2] + 0.5 * neuromere[2] + 30);
    lo[2] = Math.min(lo[2], v[2] - 0.66 * h[2] - neuromere[2] - 30);
  }

  const at = (x, y, z) => {
    let d = Infinity;
    for (const shape of shapes) {
      const e = shape.capsule ? capsuleAt(x, y, z, shape) : ellipsoidAt(x, y, z, shape.a, shape.r);
      d = d === Infinity ? e : smoothMin(d, e, shape.blend);
    }
    return d;
  };
  return { at, lo, hi, brainCentre: c, fitted: fittedParts };
}

// Where the brain's centre goes: the middle of the model's eyes, in the thorax frame.
export function eyeCentre(flyMeta) {
  const head = flyMeta.bodies.findIndex(b => b.name === 'head');
  const eyes = flyMeta.parts.filter(p => p.body === head && p.material === 'red');
  if (head < 0 || !eyes.length) throw new Error('fly.json has no head with eyes');
  const local = [0, 1, 2].map(k => (Math.min(...eyes.map(p => p.min[k])) + Math.max(...eyes.map(p => p.max[k]))) / 2);
  return toThorax(flyMeta, head, local);
}

// A point in a body's own frame, in the thorax (root) frame.
export function toThorax(flyMeta, body, point) {
  let p = point;
  for (let b = body; b >= 0 && flyMeta.bodies[b].parent >= 0; b = flyMeta.bodies[b].parent) {
    const { pos, quat } = flyMeta.bodies[b];
    p = rotate(quat, p).map((v, k) => v + pos[k]);
  }
  return p;
}

// The reverse: a thorax-frame point in a body's own frame.
export function fromThorax(flyMeta, body, point) {
  const chain = [];
  for (let b = body; b >= 0 && flyMeta.bodies[b].parent >= 0; b = flyMeta.bodies[b].parent) chain.unshift(b);
  let p = point;
  for (const b of chain) {
    const { pos, quat } = flyMeta.bodies[b];
    p = rotate([quat[0], -quat[1], -quat[2], -quat[3]], p.map((v, k) => v - pos[k]));
  }
  return p;
}

// MuJoCo quaternions are w, x, y, z.
function rotate([w, x, y, z], [px, py, pz]) {
  const tx = 2 * (y * pz - z * py), ty = 2 * (z * px - x * pz), tz = 2 * (x * py - y * px);
  return [px + w * tx + (y * tz - z * ty), py + w * ty + (z * tx - x * tz), pz + w * tz + (x * ty - y * tx)];
}

// A closed triangle mesh of where `field` crosses zero, by surface nets on a grid: one vertex per
// cell the surface passes through, one quad per grid edge it crosses. Faces point outward.
export function surfaceNets(field, lo, hi, step) {
  const n = [0, 1, 2].map(k => Math.ceil((hi[k] - lo[k]) / step) + 1);
  const [nx, ny, nz] = n;
  const values = new Float32Array(nx * ny * nz);
  const idx = (i, j, k) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) values[idx(i, j, k)] = field(lo[0] + i * step, lo[1] + j * step, lo[2] + k * step);
    }
  }

  const cellIdx = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const vertexOf = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const positions = [];
  const normals = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = values[idx(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
          if (v[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0, sy = 0, sz = 0, count = 0;
        for (const [a, b] of edges) {
          if ((v[a] < 0) === (v[b] < 0)) continue;
          const t = v[a] / (v[a] - v[b]);
          sx += corners[a][0] + t * (corners[b][0] - corners[a][0]);
          sy += corners[a][1] + t * (corners[b][1] - corners[a][1]);
          sz += corners[a][2] + t * (corners[b][2] - corners[a][2]);
          count++;
        }
        const x = lo[0] + (i + sx / count) * step;
        const y = lo[1] + (j + sy / count) * step;
        const z = lo[2] + (k + sz / count) * step;
        vertexOf[cellIdx(i, j, k)] = positions.length / 3;
        positions.push(x, y, z);
        const e = step / 4;
        const g = [field(x + e, y, z) - field(x - e, y, z), field(x, y + e, z) - field(x, y - e, z), field(x, y, z + e) - field(x, y, z - e)];
        const len = Math.hypot(...g) || 1;
        normals.push(g[0] / len, g[1] / len, g[2] / len);
      }
    }
  }

  const indices = [];
  const quad = (a, b, c, d, outwardFirst) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (outwardFirst) indices.push(a, b, c, a, c, d);
    else indices.push(a, c, b, a, d, c);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const here = values[idx(i, j, k)] < 0;
        // The edge along x from this sample, shared by the four cells around it; and so on for y, z.
        if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1 && here !== (values[idx(i + 1, j, k)] < 0)) {
          quad(vertexOf[cellIdx(i, j - 1, k - 1)], vertexOf[cellIdx(i, j, k - 1)], vertexOf[cellIdx(i, j, k)], vertexOf[cellIdx(i, j - 1, k)], here);
        }
        if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1 && here !== (values[idx(i, j + 1, k)] < 0)) {
          quad(vertexOf[cellIdx(i - 1, j, k - 1)], vertexOf[cellIdx(i - 1, j, k)], vertexOf[cellIdx(i, j, k)], vertexOf[cellIdx(i, j, k - 1)], here);
        }
        if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && here !== (values[idx(i, j, k + 1)] < 0)) {
          quad(vertexOf[cellIdx(i - 1, j - 1, k)], vertexOf[cellIdx(i, j - 1, k)], vertexOf[cellIdx(i, j, k)], vertexOf[cellIdx(i - 1, j, k)], here);
        }
      }
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

// Inigo Quilez's ellipsoid distance bound: exact on the surface, close near it.
function ellipsoidAt(x, y, z, c, r) {
  const qx = (x - c[0]) / r[0], qy = (y - c[1]) / r[1], qz = (z - c[2]) / r[2];
  const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  const sx = qx / r[0], sy = qy / r[1], sz = qz / r[2];
  const k1 = Math.sqrt(sx * sx + sy * sy + sz * sz);
  return k1 === 0 ? -Math.min(r[0], r[1], r[2]) : (k0 * (k0 - 1)) / k1;
}

function capsuleAt(x, y, z, { a, b, radius }) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = x - a[0], apy = y - a[1], apz = z - a[2];
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / (abx * abx + aby * aby + abz * abz)));
  const dx = apx - t * abx, dy = apy - t * aby, dz = apz - t * abz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - radius;
}

function smoothMin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

function mulberry32(seed) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
