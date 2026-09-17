// Circuits: the connectome data a network is built from.
//
// A circuit file (circuits/*.json, written by scripts/fetch-circuit.mjs) holds every neuron of
// one seed cell type, its direct partners at >= minWeight synapses, and every such connection
// among all of them. selectCircuit() narrows it to a higher threshold; group() names neurons.

export const MAX_NEURONS = 500;

const ROLES = ['seed', 'upstream', 'downstream', 'both'];

// Fetch a circuit file. A relative URL resolves against this module, so
// loadCircuit('circuits/dnge104.json') works from any page that imports the component.
export async function loadCircuit(url) {
  const res = await fetch(new URL(url, import.meta.url));
  if (!res.ok) throw new Error(`loadCircuit(${url}): HTTP ${res.status}`);
  return res.json();
}

// The circuit at one weight threshold: the seed neurons, their direct partners connected by
// >= minWeight synapses, and every >= minWeight connection among all of them. Each neuron is
// copied with a role: 'seed', 'upstream' (synapses onto a seed), 'downstream' (receives from
// one) or 'both'.
export function selectCircuit(data, minWeight = data.minWeight) {
  if (minWeight < data.minWeight) {
    throw new RangeError(`this circuit file only has connections of >= ${data.minWeight} synapses`);
  }
  const all = data.neurons;
  const isSeed = all.map(n => n.type === data.seedType);
  const up = new Uint8Array(all.length);
  const down = new Uint8Array(all.length);
  const E = data.edges;
  for (let k = 0; k < E.length; k += 3) {
    if (E[k + 2] < minWeight) continue;
    if (isSeed[E[k + 1]] && !isSeed[E[k]]) up[E[k]] = 1;
    if (isSeed[E[k]] && !isSeed[E[k + 1]]) down[E[k + 1]] = 1;
  }

  const index = new Int32Array(all.length).fill(-1);
  const neurons = [];
  all.forEach((n, i) => {
    if (!isSeed[i] && !up[i] && !down[i]) return;
    const role = isSeed[i] ? 'seed' : up[i] && down[i] ? 'both' : up[i] ? 'upstream' : 'downstream';
    index[i] = neurons.length;
    neurons.push({ ...n, role });
  });

  const pre = [], post = [], weight = [];
  let synapses = 0;
  for (let k = 0; k < E.length; k += 3) {
    const i = index[E[k]], j = index[E[k + 1]];
    if (i < 0 || j < 0 || E[k + 2] < minWeight) continue;
    pre.push(i);
    post.push(j);
    weight.push(E[k + 2]);
    synapses += E[k + 2];
  }

  const roles = Object.fromEntries(ROLES.map(r => [r, 0]));
  for (const n of neurons) roles[n.role]++;
  return {
    seedType: data.seedType, minWeight, ntFields: data.ntFields, source: data.source,
    neurons, pre, post, weight, synapses, roles,
  };
}

// The smallest threshold whose circuit has at most `max` neurons.
export function fitThreshold(data, max = MAX_NEURONS) {
  let heaviest = 0;
  for (let k = 2; k < data.edges.length; k += 3) heaviest = Math.max(heaviest, data.edges[k]);
  for (let w = data.minWeight; w <= heaviest; w++) {
    if (selectCircuit(data, w).neurons.length <= max) return w;
  }
  return heaviest + 1; // only the seeds are left
}

// Indices of the neurons a selector names, in circuit order. A selector is a role ('upstream'),
// several roles (['upstream', 'both']), an object whose every key must match
// ({ type: 'DNge104' }, { bodyId: [12781, 556329] }), or a (neuron, index) => boolean.
export function group(circuit, selector) {
  const match = matcher(selector);
  const out = [];
  circuit.neurons.forEach((n, i) => { if (match(n, i)) out.push(i); });
  return Int32Array.from(out);
}

function matcher(selector) {
  if (typeof selector === 'function') return selector;
  if (typeof selector === 'string' || Array.isArray(selector)) {
    const roles = [selector].flat();
    for (const r of roles) {
      if (!ROLES.includes(r)) throw new Error(`unknown role "${r}" (roles are ${ROLES.join(', ')})`);
    }
    return n => roles.includes(n.role);
  }
  if (selector && typeof selector === 'object') {
    const wanted = Object.entries(selector).map(([key, value]) => [key, [value].flat()]);
    return n => wanted.every(([key, values]) => values.includes(n[key]));
  }
  throw new TypeError('a group selector is a role, an array of roles, a { field: value } object or a function');
}
