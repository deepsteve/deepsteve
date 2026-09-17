# connectome

A Deep Steve mod with no UI of its own, for other pages to import. It turns a circuit from a fly
connectome into a leaky integrate-and-fire network that a page keeps stepping, e.g. once per animation frame,
feeding inputs in and reading firing rates out.

```js
import {
  loadCircuit, selectCircuit, fitThreshold, group, createNetwork,
} from '/mods/connectome/index.js';

const data = await loadCircuit('circuits/dnge104.json');
const circuit = selectCircuit(data, fitThreshold(data)); // at most 500 neurons
const net = createNetwork(circuit);                       // synapse signs from predictedNt

const sensors = group(circuit, ['upstream', 'both']);
const motors = group(circuit, 'downstream');

function frame(dtMs) {
  net.setInput(sensors, encode(gameState)); // mV: one value, or one per sensor neuron
  net.step(dtMs);
  act(net.rate(motors, 50));                // Hz per neuron over the last 50 ms
}
```

`examples/raster.html` is a complete consumer: it drives DNge104's upstream partners for 200 ms
and draws every spike.

## Circuits (`circuit.js`)

- **`loadCircuit(url)`** → the circuit file's data. A relative URL resolves against this
  component, so `'circuits/dnge104.json'` works from any page.
- **`selectCircuit(data, minWeight)`** → a circuit: the seed neurons, their direct partners
  connected by at least `minWeight` synapses, and every such connection among all of them. Each
  neuron gets a `role`: `'seed'`, `'upstream'` (synapses onto a seed), `'downstream'` (receives
  from one) or `'both'`. Also carries `pre`/`post`/`weight` (parallel arrays of connections),
  `synapses` and `roles` (counts).
- **`fitThreshold(data, max = MAX_NEURONS)`** → the smallest `minWeight` giving at most `max`
  neurons.
- **`group(circuit, selector)`** → `Int32Array` of neuron indices. The selector is a role,
  an array of roles, an object whose every key must match (`{ type: 'DNge104' }`,
  `{ bodyId: [12781, 556329] }`), or `(neuron, index) => boolean`.

## Networks (`network.js`)

- **`createNetwork(circuit, { ntField, params, rateWindow })`** → a network with its own state.
  - `ntField`: which transmitter prediction signs synapses. Default: the circuit file's first
    (`predictedNt`). `null` makes every synapse excitatory.
  - `params`: overrides for `PARAMS`.
  - `rateWindow`: how far back `rate()` can look, ms (default 1000).
- **`compile(circuit, { ntField, params })`** → the parts that never change while a network
  runs. Pass it to `createNetwork` for many networks (one per game agent) sharing one circuit.
- **`net.step(ms)`** → spikes emitted. Any `ms`; fractions of a time step carry over, so frames
  of `1000 / 60` add up exactly.
- **`net.setInput(selector | indices, mV)`**: held input, as the voltage it holds the membrane
  at (R·I). Stays until changed. **`net.clearInputs()`** zeroes all of it.
- **`net.rate(selector | indices, windowMs = 50)`** → mean Hz per neuron.
  **`net.rates(…)`** → `Float64Array`, one rate per neuron, in selector order.
- **`net.onSpike((index, tMs) => …)`** → an unsubscribe function. Runs during `step()`; don't
  call `step()` from it.
- **`net.reset()`**: back to t = 0, at rest, no inputs, no history. Listeners stay.
- **`net.t`** (ms), **`net.v`** (membrane potentials, mV; read only), **`net.circuit`**,
  **`net.compiled`** (`sign` per neuron, `ntField`, `params`).
- **`record(net)`** → `{ t, i, stop() }`: every spike from now on.

## Drawing (`raster.js`)

**`drawRaster(canvas, { network, spikes, duration, stimulus, title, subtitle })`** draws a
raster over a population-rate plot. Rows are grouped by role and ordered by first spike;
excitatory, inhibitory and seed neurons are colored apart. Size the canvas with CSS.

## The model

The Brian2 model of Shiu et al., [*A Drosophila computational brain model reveals sensorimotor
processing*](https://www.nature.com/articles/s41586-024-07763-9), Nature 634 (2024), with their
`default_params`:

| | |
|---|---|
| `v0`, `vReset` | −52 mV |
| `vTh` | −45 mV |
| `tauM` | 20 ms |
| `tauSyn` | 5 ms |
| `tRef` | 2.2 ms |
| `delay` | 1.8 ms |
| `wSyn` | 0.275 mV per synapse |
| `dt` | 0.1 ms |

`dv/dt = (v0 − v + g + I) / tauM` and `dg/dt = −g / tauSyn`, both frozen while refractory,
integrated exactly per step. A spike adds `sign × synapses × wSyn` to each target's `g` after
`delay`. GABA and glutamate synapses are inhibitory; everything else, the monoamines included,
is excitatory, as in the paper. `I` is not in their model: it is this component's input.

The tests check spike times against the analytic solution, quantized to the time step.

## Circuit files

Fetched from [neuPrint](https://neuprint.janelia.org); `source` in each file records the server,
dataset and date. `circuits/dnge104.json`: dataset `male-cns:v1.0`, seed
type `DNge104` (two neurons, predicted GABA), every connection of at least 5 synapses.
`circuits/dnp01.json`: the same dataset and threshold, seed type `DNp01`, the giant fiber that
triggers the escape jump (two neurons). Its largest inputs are the looming-sensitive visual
neurons LC4 and LPLC2.

```jsonc
{
  "format": 1,
  "seedType": "DNge104",
  "minWeight": 5,
  "ntFields": ["predictedNt", "consensusNt", "celltypePredictedNt"],
  "source": { "server", "dataset", "fetchedAt", "voxelSize", "voxelUnits", "neurons", "connections", "synapses" },
  "neurons": [{ "bodyId", "type", "instance", "superclass", "nt": { "predictedNt": "gaba", … }, "soma": [x, y, z] }],
  "edges": [pre, post, synapses, …]   // flat; pre and post index neurons
}
```

`soma` is neuPrint's `somaLocation` in voxels (`voxelSize` × `voxelUnits`, 8 nm for male-cns),
or `null` where a neuron has none: positions for a 3D view.
