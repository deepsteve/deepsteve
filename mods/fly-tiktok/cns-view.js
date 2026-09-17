// Draws cns.js's layout with three.js: each neuron a point that flares when it spikes, inside a
// see-through shell. One model, shown twice: on its own canvas, where it can be turned and zoomed,
// and inside the fly on the phone, seen through the fly's body.
//
//   const model = createCnsModel(layoutCns(circuit, flyMeta), { band, colors, emphasis });
//   net.onSpike(i => model.spike(i));
//   const view = createCnsView(canvas, model, { frame }); // fills frame, an element over the canvas
//   thorax.add(cnsInFly(model).group);
//   // each frame: model.fade(now); view.render(now); inFly.fit(renderer, camera)

import * as THREE from 'three';

const FLARE_MS = 250; // a spike's light is down to a tenth after this long

export function createCnsModel(cns, { band, colors, emphasis = () => 1 }) {
  const N = cns.positions.length / 3;
  const tint = new Float32Array(N * 3);
  const size = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    new THREE.Color(colors[band[i]]).toArray(tint, i * 3); // sRGB as given, like the raster's
    size[i] = emphasis(i);
  }
  const activity = new Float32Array(N);
  const activityAttribute = new THREE.BufferAttribute(activity, 1).setUsage(THREE.DynamicDrawUsage);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(cns.positions, 3));
  geometry.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
  geometry.setAttribute('emphasis', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('activity', activityAttribute);

  const shellGeometry = new THREE.BufferGeometry();
  shellGeometry.setAttribute('position', new THREE.BufferAttribute(cns.shell.positions, 3));
  shellGeometry.setAttribute('normal', new THREE.BufferAttribute(cns.shell.normals, 3));
  shellGeometry.setIndex(new THREE.BufferAttribute(cns.shell.indices, 1));
  shellGeometry.computeBoundingSphere();
  geometry.boundingSphere = shellGeometry.boundingSphere.clone();

  let lastFade = null;
  return {
    geometry, shellGeometry,
    bounds: shellGeometry.boundingSphere, // MuJoCo thorax frame, cm
    spike(i) {
      activity[i] = 1;
      activityAttribute.needsUpdate = true;
    },
    fade(now) {
      const dt = lastFade === null ? 0 : Math.min(250, now - lastFade);
      lastFade = now;
      const keep = Math.exp((-dt / FLARE_MS) * 2.3);
      let lit = false;
      for (let i = 0; i < N; i++) {
        if (activity[i] === 0) continue;
        activity[i] = activity[i] < 0.004 ? 0 : activity[i] * keep;
        lit = true;
      }
      if (lit) activityAttribute.needsUpdate = true;
    },
  };
}

// Points sized in the world, so they grow as you zoom, but never smaller than a few pixels.
function neuronMaterial({ xray = false, worldSize, minPixels, rest = 0.5 }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      pixelsPerUnit: { value: 1 },
      worldSize: { value: worldSize },
      minPixels: { value: minPixels },
      rest: { value: rest },
    },
    vertexShader: /* glsl */ `
      attribute vec3 tint;
      attribute float emphasis;
      attribute float activity;
      uniform float pixelsPerUnit;
      uniform float worldSize;
      uniform float minPixels;
      varying vec3 vTint;
      varying float vActivity;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float pixels = worldSize * emphasis * (1.0 + 1.4 * activity) * pixelsPerUnit / max(1e-6, -mv.z);
        gl_PointSize = clamp(pixels, minPixels * emphasis, 96.0);
        vTint = tint;
        vActivity = activity;
      }`,
    fragmentShader: /* glsl */ `
      uniform float rest;
      varying vec3 vTint;
      varying float vActivity;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        float body = 1.0 - smoothstep(0.45, 1.0, r);
        float halo = (1.0 - r) * (1.0 - r);
        vec3 color = vTint * (rest + 2.6 * vActivity) + vec3(1.0) * vActivity * vActivity * halo;
        gl_FragColor = vec4(color, body * (0.55 + 0.45 * halo));
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: !xray,
    blending: THREE.AdditiveBlending,
  });
}

// Bright where the surface turns away from the eye, nearly clear where it faces it: glass. Dark
// glass inside the fly, where clear glass over the fly's orange body wouldn't show at all.
function shellMaterial({ xray = false, dark = false }) {
  return new THREE.ShaderMaterial({
    uniforms: { tint: { value: new THREE.Color('#7fa6d9') }, dark: { value: dark ? 1 : 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 tint;
      uniform float dark;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float rim = pow(1.0 - facing, 2.5);
        if (dark > 0.5) gl_FragColor = vec4(mix(vec3(0.015, 0.03, 0.06), tint, rim), 0.72 + 0.28 * rim);
        else gl_FragColor = vec4(tint, 0.035 + 0.5 * rim);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: !xray,
    blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
}

// How many drawing-buffer pixels a unit at distance 1 covers, for the point sizes.
function pixelsPerUnit(renderer, camera) {
  const height = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  return height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

// Its own canvas: it holds still, drag to turn it, scroll or pinch to zoom, double-click to put it
// back. It doesn't turn by itself; that only made it harder to look at.
//
// At zoom 1 it fills `frame` (default: the canvas), as tightly as its shape from that angle allows,
// centred there. The canvas can be bigger than the frame, so turning or zooming spills past the
// frame instead of being cut off at it.
const FILL = 0.94; // of the frame's height or width, whichever runs out first
export function createCnsView(canvas, model, { frame = canvas } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.001, 10);
  const holder = new THREE.Group();
  holder.rotation.x = -Math.PI / 2; // MuJoCo's z up is three.js's y up, as for the fly
  const points = new THREE.Points(model.geometry, neuronMaterial({ worldSize: 0.0009, minPixels: 2.5 }));
  const shell = new THREE.Mesh(model.shellGeometry, shellMaterial({}));
  holder.add(shell, points);
  scene.add(holder);
  holder.updateMatrixWorld(true);
  const target = model.bounds.center.clone().applyMatrix4(holder.matrixWorld);

  // Straight on from in front of the fly and a little below: both halves of the brain side by side,
  // and the nerve cord hanging beneath it on the neck. At zoom 1 it fits the canvas from any angle.
  const home = { azimuth: 0, elevation: -0.35, zoom: 1 };
  const view = { ...home };

  // How far away the camera must be for the whole shell to fit the frame, seen from home. Exact for
  // a perspective camera: each vertex needs its depth toward the camera plus its sideways offset
  // over the tangent of the half-angle it may use.
  const vertices = model.shellGeometry.getAttribute('position').array;
  function fitDistance(frameWidth, frameHeight, canvasHeight) {
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanX = (t * frameWidth / canvasHeight) * FILL;
    const tanY = (t * frameHeight / canvasHeight) * FILL;
    const back = new THREE.Vector3(Math.cos(home.elevation) * Math.cos(home.azimuth), Math.sin(home.elevation), Math.cos(home.elevation) * Math.sin(home.azimuth));
    const right = new THREE.Vector3(0, 1, 0).cross(back).normalize();
    const up = back.clone().cross(right);
    let distance = 0;
    const p = new THREE.Vector3();
    for (let v = 0; v < vertices.length; v += 3) {
      p.set(vertices[v], vertices[v + 2], -vertices[v + 1]).sub(target); // MuJoCo to three.js, as the holder turns it
      const depth = p.dot(back);
      distance = Math.max(distance, depth + Math.abs(p.dot(right)) / tanX, depth + Math.abs(p.dot(up)) / tanY);
    }
    return distance;
  }
  let fitted = { key: '', distance: 1 };
  let drag = null;

  canvas.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    view.azimuth -= (e.clientX - drag.x) * 0.008;
    view.elevation = THREE.MathUtils.clamp(view.elevation + (e.clientY - drag.y) * 0.008, -1.45, 1.45);
    drag = { x: e.clientX, y: e.clientY };
  });
  const release = () => {
    drag = null;
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rate = e.ctrlKey ? 0.012 : 0.0015; // a trackpad pinch arrives as a wheel with ctrl held
    view.zoom = THREE.MathUtils.clamp(view.zoom * Math.exp(-e.deltaY * rate), 0.6, 8);
  }, { passive: false });
  canvas.addEventListener('dblclick', () => Object.assign(view, home));

  return {
    view, // azimuth and elevation in radians, and zoom; the page's debug hook can set them
    render() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      const ratio = renderer.getPixelRatio();
      if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
        renderer.setSize(w, h, false);
      }
      const c = canvas.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const key = `${w}x${h} ${Math.round(f.width)}x${Math.round(f.height)}`;
      if (key !== fitted.key && f.width > 0 && f.height > 0) fitted = { key, distance: fitDistance(f.width, f.height, h) };
      // Centred on the frame, not the canvas: the camera's view is shifted rather than turned.
      camera.aspect = w / h;
      camera.setViewOffset(w, h, w / 2 - (f.left - c.left + f.width / 2), h / 2 - (f.top - c.top + f.height / 2), w, h);
      const distance = fitted.distance / view.zoom;
      camera.position.set(
        target.x + distance * Math.cos(view.elevation) * Math.cos(view.azimuth),
        target.y + distance * Math.sin(view.elevation),
        target.z + distance * Math.cos(view.elevation) * Math.sin(view.azimuth),
      );
      camera.near = Math.max(1e-5, distance - model.bounds.radius * 3);
      camera.far = distance + model.bounds.radius * 3;
      camera.updateProjectionMatrix();
      camera.lookAt(target);
      points.material.uniforms.pixelsPerUnit.value = pixelsPerUnit(renderer, camera);
      renderer.render(scene, camera);
    },
  };
}

// The same model inside the fly, drawn over its body. Add `group` to the thorax body.
export function cnsInFly(model) {
  const group = new THREE.Group();
  const points = new THREE.Points(model.geometry, neuronMaterial({ xray: true, worldSize: 0.0006, minPixels: 2, rest: 0.9 }));
  const shell = new THREE.Mesh(model.shellGeometry, shellMaterial({ xray: true, dark: true }));
  shell.renderOrder = 10; // after the fly, since they ignore its depth
  points.renderOrder = 11;
  group.add(shell, points);
  return {
    group,
    fit(renderer, camera) {
      points.material.uniforms.pixelsPerUnit.value = pixelsPerUnit(renderer, camera);
    },
  };
}
