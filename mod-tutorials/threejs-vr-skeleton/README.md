# Three.js VR Skeleton

Minimal three.js + WebXR starter template for building deepsteve VR mods.

## What's Included

- **WebGL renderer** with WebXR enabled
- **Scene** with sky background, fog, ambient + directional lighting
- **Camera rig** — the standard VR pattern for locomotion
- **VR controllers** — both hands with grip models and input event hooks
- **VR button** — "Enter VR" for WebXR-capable browsers
- **Ground plane** with shadow receiving
- **Spinning cube** — a demo object to confirm the scene is working
- **Bridge API** — polls for `window.deepsteve` and subscribes to session changes
- **Resize handling** and **animation loop** (`setAnimationLoop`)

## Usage

1. Copy this folder into `mods/`:
   ```bash
   cp -r mod-tutorials/threejs-vr-skeleton mods/my-vr-mod
   ```

2. Update `mod.json` with your mod's name, description, and toolbar label.

3. Rename `skeleton.js` and update the `<script>` tag in `index.html`.

4. Build on the skeleton — add objects, physics, interaction, HUD elements.

5. Restart deepsteve and enable your mod in Settings.

## Key Patterns

### Camera Rig

VR headsets control the camera's local transform directly. To move the player, move the **rig** (a `THREE.Group` containing the camera), not the camera itself. VR controllers must also be children of the rig.

```js
const cameraRig = new THREE.Group();
cameraRig.add(camera);
scene.add(cameraRig);

// Move the player by moving the rig
cameraRig.position.set(5, 0, 10);
```

### Animation Loop

WebXR requires `renderer.setAnimationLoop(fn)` instead of `requestAnimationFrame`. The callback receives a timestamp synchronized with the VR display's refresh rate.

### Bridge API

The deepsteve bridge (`window.deepsteve`) is injected into the mod iframe but may not be available immediately. Poll for it:

```js
const poll = setInterval(() => {
  if (window.deepsteve) {
    clearInterval(poll);
    // Use bridge methods here
  }
}, 100);
```

See the [Mods Guide](../../docs/mods.md) for the full bridge API reference.
