// Village — walk a small town where every house is one of your projects.
//
// Entry point: builds the scene, owns the loop, and wires the town to the host.
//
// The pieces live next door: layout.js decides where things go (and is pure, so it
// is unit tested), props.js builds them, curvature.js bends them, camera-rig.js and
// villager.js carry the feel, data.js knows what your projects are doing, hud.js is
// the only DOM.

import * as THREE from 'three';
import { CAMERA, INTERACT, PALETTE, SCREEN } from './config.js';
import { buildTown, distanceToLane } from './layout.js';
import { applyFog, curve } from './curvature.js';
import {
  buildGround, buildLane, buildPuddles, buildHouse, buildMailbox, buildFence,
  buildTree, buildOvergrowth, buildNoticeBoard, buildNotice, buildLamp,
  buildTownSign, buildProjectBoard, buildNameMarker, lightBoard, darkenBoard,
  disposeProps, FLAG_UP, FLAG_DOWN,
} from './props.js';
import { TerminalMirror } from './screen.js';
import { encodeKey } from './input.js';
import { buildVillager, Walker, makeCollider } from './villager.js';
import { ChaseCamera } from './camera-rig.js';
import { buildSky, buildLights, Rain, FOG } from './weather.js';
import { labelTexture, disposeTextures } from './textures.js';
import { TownData } from './data.js';
import { Hud } from './hud.js';
import {
  startAudio, startAmbient, setAmbientEnabled, setRainAudio,
  playFootstep, playDoorChime, playEnter, disposeAudio,
} from './audio.js';

// ── renderer, scene ─────────────────────────────────────────────────────────

const canvas = document.getElementById('scene');
// Focusable, so the iframe actually receives keydown. Without this the parent
// document keeps focus after any chrome interaction and WASD goes nowhere — the
// same reason space-station.js:17 and monkey-code.js:93 do it.
canvas.tabIndex = -1;
canvas.style.outline = 'none';

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(PALETTE.FOG);

const scene = new THREE.Scene();
applyFog(scene, FOG.color);

const camera = new THREE.PerspectiveCamera(
  CAMERA.FOV, window.innerWidth / window.innerHeight, CAMERA.NEAR, CAMERA.FAR,
);

const sky = buildSky();
scene.add(sky);
scene.add(buildLights());
scene.add(buildGround());

const rain = new Rain();
scene.add(rain.mesh);

// ── the town ────────────────────────────────────────────────────────────────

// Everything rebuilt when the project list changes lives under this one node, so a
// rebuild is "empty this and refill it" rather than bookkeeping.
const townRoot = new THREE.Group();
scene.add(townRoot);

let town = null;                 // the layout
let spawned = false;             // whether the villager has been placed yet
let collide = () => ({ x: 0, z: 0 });
const houses = new Map();        // ctxId → { group, plot, mailbox, prompt }
let noticeBoard = null;
let promptMesh = null;
let nearPlot = null;

// The one mirrored terminal in the town, and which board is currently showing it.
// A session is read here, on a board, and never by handing the browser over to the
// flat terminal view — see screen.js for why there is only ever one of these.
const mirror = new TerminalMirror();
let litPlot = null;
let working = false;

const walker = new Walker({ x: 0, z: 6, heading: Math.PI });
const villager = buildVillager();
scene.add(villager);

const rig = new ChaseCamera({ heading: walker.heading });

/** Free a subtree's geometries. Materials are shared, so props.js owns those. */
function disposeSubtree(root) {
  root.traverse((obj) => {
    if (obj.isMesh || obj.isLineSegments) obj.geometry?.dispose();
  });
}

function rebuildTown(contexts, settings) {
  disposeSubtree(townRoot);
  townRoot.clear();
  houses.clear();

  town = buildTown(contexts, { showArchived: settings.showArchived !== false });
  collide = makeCollider(town);

  townRoot.add(buildLane(town));
  townRoot.add(buildPuddles(town));

  // The square: a notice board, a lamp, and a sign naming the place.
  noticeBoard = buildNoticeBoard();
  noticeBoard.position.set(town.square.x - 4.4, 0, town.square.z - 3.2);
  noticeBoard.rotation.y = 0.42;
  townRoot.add(noticeBoard);

  const lamp = buildLamp();
  lamp.position.set(town.square.x + 4.6, 0, town.square.z - 2.6);
  townRoot.add(lamp);

  const sign = buildTownSign('VILLAGE');
  sign.position.set(town.square.x + 3.4, 0, town.square.z + 3.6);
  sign.rotation.y = -0.5;
  townRoot.add(sign);

  for (const plot of town.plots) {
    const group = plot.archived ? buildArchivedHouse(plot) : buildHouse(plot);
    townRoot.add(group);

    // The fence and the mailbox stand between the house and the lane, in the
    // house's own frame so they turn with it.
    const front = new THREE.Group();
    front.position.set(plot.position.x, 0, plot.position.z);
    front.rotation.y = plot.rotation;

    const fence = buildFence(plot);
    fence.position.z = plot.depth / 2 + 3.0;
    front.add(fence);

    const mailbox = buildMailbox();
    mailbox.position.set(plot.width / 2 + 0.8, 0, plot.depth / 2 + 2.6);
    mailbox.rotation.y = -0.5;
    front.add(mailbox);

    // The project's board, opposite the mailbox and inside the fence: beside the
    // path to the door rather than across it, angled back at whoever is standing
    // on the doorstep.
    const board = buildProjectBoard();
    board.position.set(-plot.width / 2 + SCREEN.OFFSET_X, 0, plot.depth / 2 + SCREEN.OFFSET_Z);
    board.rotation.y = SCREEN.YAW;
    front.add(board);

    townRoot.add(front);

    // A tree beside the lot. Archived lots get the drab, overgrown foliage.
    const tree = buildTree(plot.ctxId, plot.archived);
    tree.position.set(
      plot.position.x - Math.sin(plot.rotation + Math.PI / 2) * (plot.width / 2 + 2.4),
      0,
      plot.position.z - Math.cos(plot.rotation + Math.PI / 2) * (plot.width / 2 + 2.4),
    );
    townRoot.add(tree);

    // The name, floating over the roof, readable from down the lane.
    // Above the ridge, not level with it: a two-storey house tops out near 8.8m,
    // and a marker buried in a roof is worse than no marker.
    const marker = buildNameMarker(plot.name);
    marker.position.set(plot.position.x, plot.archived ? 8.4 : 9.6, plot.position.z);
    townRoot.add(marker);

    houses.set(plot.ctxId, { group, plot, mailbox, board, marker });
  }

  // The town was just rebuilt, so the board the mirror was on no longer exists.
  // Drop the lit state and let updateProximity() re-light from scratch; keeping
  // the mirror mounted means a rebuild does not interrupt a session you are
  // reading, only the mesh it was being drawn on.
  litPlot = null;

  // Trees down the far side of the lane, to close the view in.
  scatterTrees();

  if (!spawned) {
    // Only ever on the FIRST build. A later rebuild (a project registered, archived
    // lots toggled) must leave you exactly where you were standing — being
    // teleported back to the square because someone added a repo would be absurd.
    spawned = true;
    walker.position.set(town.spawn.x, 0, town.spawn.z);
    walker.heading = town.spawn.heading;
    walker.bodyYaw = town.spawn.heading;
    rig.yaw = town.spawn.heading;
    rig.initialised = false;
  }

  // Keep the villager out of anything the rebuild may have put on top of them.
  const fixed = collide(walker.position.x, walker.position.z);
  walker.position.x = fixed.x;
  walker.position.z = fixed.z;
}

/** An archived project: a shuttered house, gone to grass. */
function buildArchivedHouse(plot) {
  const group = buildHouse(plot);
  const bag = group.userData.village;
  // Windows boarded rather than dark, so it reads as "left" not "asleep".
  for (const mat of bag.windows) {
    mat.color.set(0x5b5347);
    mat.emissive.set(0x000000);
  }
  group.add(buildOvergrowth(plot));
  bag.archived = true;
  return group;
}

function scatterTrees() {
  const pts = town.lane.pts;
  const lens = town.lane.lens;
  for (let i = 0; i < pts.length; i += 9) {
    if (lens[i] > town.laneLength) break;
    for (const side of [-1, 1]) {
      const seed = `tree${i}${side}`;
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const dx = p.x - prev.x;
      const dz = p.z - prev.z;
      const m = Math.hypot(dx, dz) || 1;
      const nx = -dz / m;
      const nz = dx / m;
      const off = 22 + ((i * 7 + (side > 0 ? 3 : 0)) % 9);
      const x = p.x + nx * off * side;
      const z = p.z + nz * off * side;
      // Never in the road, never on a lot.
      if (distanceToLane(town.lane, x, z) < 12) continue;
      if (town.plots.some((pl) => Math.hypot(pl.position.x - x, pl.position.z - z) < 12)) continue;
      const tree = buildTree(seed);
      tree.position.set(x, 0, z);
      townRoot.add(tree);
    }
  }
}

// ── the "press E" prompt ────────────────────────────────────────────────────
// A mesh, not a DOM element, so it is displaced by the curvature shader along with
// the door it is pointing at. Billboarded on the CPU, which is rotation only and
// therefore safe (curvature.js, trap 3).

function buildPrompt() {
  const tex = labelTexture('PRESS  E', {
    width: 256, height: 56, size: 22, bg: '#4a3018', fg: '#f9f2e2', border: '#f9f2e2',
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 1.7 * (56 / 256)),
    curve(new THREE.MeshLambertMaterial({ map: tex, transparent: true })),
  );
  mesh.visible = false;
  return mesh;
}

promptMesh = buildPrompt();
scene.add(promptMesh);

// ── live data ───────────────────────────────────────────────────────────────

let settings = { rain: true, ambientAudio: true, showArchived: true };
let model = { byCtx: new Map(), waiting: [], active: [] };
// The set of buildings the town was last built for; a rebuild is skipped unless it
// actually changed (see below).
let lastBuiltKey = '';

const data = new TownData((next, flags) => {
  model = next;

  if (flags.settingsChanged || !town) {
    const s = window.deepsteve?.getSettings?.() || {};
    const wasShowArchived = settings.showArchived;
    settings = { rain: s.rain !== false, ambientAudio: s.ambientAudio !== false, showArchived: s.showArchived !== false };
    rain.setEnabled(settings.rain);
    setRainAudio(settings.rain && settings.ambientAudio);
    setAmbientEnabled(settings.ambientAudio);
    if (town && wasShowArchived !== settings.showArchived) flags.layoutChanged = true;
  }

  // Rebuild only when the set of buildings actually changed — the model recomputes
  // on every session poll, and rebuilding the town three times a second would be
  // both wasteful and visibly stuttery.
  const wanted = [...model.byCtx.values()]
    .filter((e) => settings.showArchived || !e.ctx.archived)
    .map((e) => e.ctx.id).join('|');
  if (flags.layoutChanged || wanted !== lastBuiltKey) {
    lastBuiltKey = wanted;
    rebuildTown(data.contexts, settings);
  }

  paintTown();
  hud.setEmpty(data.contexts.length === 0);
  hud.setSubtitle(subtitleFor());

  // Keep an open card current, so a session starting while you stand at the door
  // appears in the list rather than after you walk away and back.
  if (nearPlot && hud.isDoorOpen) hud.refresh(nearPlot, model.byCtx.get(nearPlot.ctxId));
});

function subtitleFor() {
  const n = data.contexts.length;
  if (!n) return 'no projects registered';
  const waiting = model.waiting.length;
  const parts = [`${n} ${n === 1 ? 'house' : 'houses'}`];
  if (waiting) parts.push(`${waiting} waiting on you`);
  return parts.join('  ·  ');
}

/** Push the live model onto the town: lights, flags, notices. */
function paintTown() {
  for (const [ctxId, house] of houses) {
    const entry = model.byCtx.get(ctxId);
    const bag = house.group.userData.village;

    if (!bag.archived) {
      // Lights on = this project has sessions running, anywhere — the real
      // population, not just this window's tabs.
      const lit = entry ? entry.sessions.length > 0 : false;
      const waiting = entry ? entry.waiting.length > 0 : false;
      for (const mat of bag.windows) {
        mat.color.copy(lit ? bag.litColor : bag.darkColor);
        // A house with something waiting on you burns a touch brighter.
        mat.emissive.setHex(lit ? (waiting ? 0x6a4a12 : 0x3d2a08) : 0x000000);
      }
    }

    const unread = entry ? entry.unread : 0;
    house.mailbox.userData.village.flag.rotation.x = unread ? FLAG_UP : FLAG_DOWN;
  }

  paintNotices();
}

/**
 * One paper notice per session waiting for input — the same `waitingForInput` flag
 * the Action Required mod reads (mods/action-required/action-required.jsx:340).
 */
function paintNotices() {
  if (!noticeBoard) return;
  const bag = noticeBoard.userData.village;
  const pinboard = bag.pinboard;
  const wanted = Math.min(model.waiting.length, 12);

  while (pinboard.children.length > wanted) {
    const child = pinboard.children[pinboard.children.length - 1];
    pinboard.remove(child);
    child.geometry.dispose();
  }
  while (pinboard.children.length < wanted) {
    pinboard.add(buildNotice(pinboard.children.length));
  }

  // Lay them out in rows across the board, with a little tilt each so they read as
  // pinned paper rather than as a texture atlas.
  const perRow = 4;
  pinboard.children.forEach((notice, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    notice.position.set(
      (col - (perRow - 1) / 2) * 0.72,
      2.0 + bag.height / 2 - 0.52 - row * 0.8,
      0,
    );
    notice.rotation.z = ((i * 37) % 11 - 5) * 0.016;
  });
}

// ── the door card ───────────────────────────────────────────────────────────

const hud = new Hud({
  onPickSession: (ctx, session) => {
    // This used to call focusSession(), which swapped the whole mod out for the
    // flat terminal — you clicked something in the village and the village was
    // gone. The session now goes onto the house's board and the camera steps up
    // to it, so picking a session is a move within the town, not an exit from it.
    //
    // setActiveContext() must NOT be called here either, however tempting it is to
    // have the projects rail follow you around. It ends in applyFilter()
    // (context-views.js:258), which switches tabs when the active one is hidden by
    // the new filter — and switching to a terminal tab hides the fullscreen mod.
    // Same ejection, one level further down. It belongs only on the path that is
    // meant to leave, which is onOpenAsTab below.
    playEnter();
    const house = houses.get(ctx.id);
    if (!house) return;

    // Move the mirror onto this house's board, whatever it was on before, and pin
    // boardShowing to the session that was actually clicked — otherwise the next
    // proximity tick would helpfully replace it with the house's default one.
    if (litPlot && litPlot.ctxId !== ctx.id) {
      const prev = houses.get(litPlot.ctxId);
      if (prev) darkenBoard(prev.board);
    }
    litPlot = house.plot;
    boardShowing = `s:${session.id}`;

    const err = mirror.mount(session.id);
    if (err) mirror.showNotice(err.toLowerCase());
    if (mirror.live) lightBoard(house.board, mirror.texture, mirror.aspect);
    else darkenBoard(house.board);
    if (!err) startWorking(house.plot);
  },

  // The deliberate way out: the real tab, in the real terminal view.
  onOpenAsTab: () => {
    const id = mirror.sessionId;
    if (!id) return;
    if (litPlot) window.deepsteve?.setActiveContext?.(litPlot.ctxId);
    window.deepsteve?.focusSession?.(id);
  },
  // A new session has to become a real tab — there is no session without one —
  // but it opens in the BACKGROUND (#600's flag, added for exactly this: "so the
  // user isn't yanked out of what they were doing"). Without it the host focuses
  // the new tab, which hides the mod, and you have moved into a house only to be
  // thrown out of the village. The board picks the session up on the next poll.
  onNewSession: (ctx) => {
    const cwd = (ctx.dirs || [])[0];
    if (!cwd) return;
    playEnter();
    window.deepsteve?.createSession?.(cwd, { background: true });
    closeCard();
  },
});

hud.onVeilClick(() => enterPointerLock());

function openCard() {
  if (!nearPlot) return;
  data.markRead(nearPlot.ctxId);
  if (hud.showDoor(nearPlot, model.byCtx.get(nearPlot.ctxId))) playDoorChime();
  // Release the pointer so the rows can actually be clicked. Walking is suspended
  // while the card is up, which is the right trade: you are standing at a door.
  if (document.pointerLockElement) document.exitPointerLock();
  hud.setVeil(false);
}

function closeCard() {
  hud.hideDoor();
  if (!document.pointerLockElement) hud.setVeil(true);
}

// ── input ───────────────────────────────────────────────────────────────────

const input = {
  forward: false, back: false, left: false, right: false, sprint: false, jump: false,
};
const IDLE = {
  forward: false, back: false, left: false, right: false, sprint: false, jump: false,
};

function setKey(code, down, shift) {
  // Sprint rides on the shift state of every key event rather than on its own
  // keydown, so tapping Shift mid-stride works and releasing it never sticks on.
  input.sprint = !!shift;
  switch (code) {
    case 'KeyW': case 'ArrowUp': input.forward = down; return true;
    case 'KeyS': case 'ArrowDown': input.back = down; return true;
    case 'KeyA': case 'ArrowLeft': input.left = down; return true;
    case 'KeyD': case 'ArrowRight': input.right = down; return true;
    case 'ShiftLeft': case 'ShiftRight': return true;
    // Jump is an edge, not a state: it is consumed by the next update() so that
    // holding Space does not pogo, and releasing it needs no bookkeeping.
    case 'Space': if (down) input.jump = true; return true;
    default: return false;
  }
}

window.addEventListener('keydown', (e) => {
  // Working at a board: the keyboard belongs to the session, so this branch runs
  // before every binding below it and claims almost everything. The one key it
  // keeps is Shift+Esc — plain Escape has to reach the agent, because Escape is
  // how you interrupt one, and a mod that ate it would make the board useless for
  // the thing you walked over to do.
  if (working) {
    if (e.key === 'Escape' && e.shiftKey) {
      e.preventDefault();
      stopWorking();
      return;
    }
    const bytes = encodeKey(e);
    if (bytes !== null) {
      e.preventDefault();
      mirror.send(bytes);
    }
    return;
  }

  if (e.repeat) return;
  if (setKey(e.code, true, e.shiftKey)) {
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyE') {
    e.preventDefault();
    if (hud.isDoorOpen) closeCard();
    else openCard();
  } else if (e.code === 'KeyF') {
    // Straight to work at the board you are standing at, without going through
    // the card — the card is a session picker, and most houses have one session.
    e.preventDefault();
    startWorking();
  } else if (e.code === 'Escape') {
    // The browser releases pointer lock on its own; this is the card half.
    if (hud.isDoorOpen) closeCard();
  }
});

window.addEventListener('keyup', (e) => {
  if (working) return;
  if (setKey(e.code, false, e.shiftKey)) e.preventDefault();
});

function enterPointerLock() {
  startAudio();
  startAmbient();
  setAmbientEnabled(settings.ambientAudio);
  setRainAudio(settings.rain && settings.ambientAudio);
  canvas.focus();
  if (!document.pointerLockElement) canvas.requestPointerLock();
  hud.setVeil(false);
  hud.armHintFade();
}

canvas.addEventListener('click', () => {
  // At a board, a click is not a request to look around — it would only throw away
  // the keyboard you came here for. The banner's button is the way out.
  if (working) return;
  // A drag ends in a click event too. Turning the camera and then also opening a
  // door with the same gesture is not what anyone meant.
  if (dragTravel > 6) { dragTravel = 0; return; }
  if (hud.isDoorOpen) {
    closeCard();
    enterPointerLock();
    return;
  }
  if (document.pointerLockElement) {
    // Locked and standing at a door: a click is the same gesture as E.
    if (nearPlot) openCard();
    return;
  }
  enterPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) {
    // Dropping the lock must also drop the keys, or a held W walks on forever.
    input.forward = input.back = input.left = input.right = false;
    input.sprint = input.jump = false;
    // The veil is "click to look around", and it is wrong at a board: the lock was
    // released on purpose there, and a veil over a session you are typing into
    // would swallow the first click you aimed at it.
    if (!hud.isDoorOpen && !working) hud.setVeil(true);
  }
});

// Drag-to-look, for when pointer lock is not available.
//
// Mouse look used to be gated SOLELY on pointer lock, and when the mod iframe's
// sandbox was missing allow-pointer-lock the request threw, the lock never
// engaged, and the camera simply could not be turned — no error surfaced, the
// mouse just did nothing. The sandbox is fixed (mod-manager.js MOD_SANDBOX), but
// a camera with exactly one input path that can fail silently is the bug waiting
// to happen again, so dragging turns the view too.
let dragging = false;
let dragTravel = 0;

canvas.addEventListener('mousedown', () => {
  if (working) return;
  dragging = true;
  dragTravel = 0;
});

window.addEventListener('mouseup', () => { dragging = false; });

document.addEventListener('mousemove', (e) => {
  if (working) return;
  if (document.pointerLockElement === canvas) {
    rig.look(e.movementX, e.movementY);
  } else if (dragging) {
    dragTravel += Math.abs(e.movementX) + Math.abs(e.movementY);
    rig.look(e.movementX, e.movementY);
  }
});

window.addEventListener('resize', onResize);
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  // The reading distance is solved from the aspect, so a resize invalidates it.
  reframeBoard();
}

// ── proximity ───────────────────────────────────────────────────────────────

function updateProximity(dt) {
  if (!town) return;

  let best = null;
  let bestDist = Infinity;
  for (const plot of town.plots) {
    const d = Math.hypot(walker.position.x - plot.stand.x, walker.position.z - plot.stand.z);
    if (d < bestDist) {
      bestDist = d;
      best = plot;
    }
  }

  const inRange = best && bestDist <= INTERACT.DOOR_RANGE;
  nearPlot = inRange ? best : null;

  // Walking away closes an open card. The close range is deliberately wider than
  // the open range, so standing on the boundary does not flicker.
  if (hud.isDoorOpen && (!best || bestDist > INTERACT.CLOSE_RANGE)) closeCard();

  // Boards light from further out than a card opens, so a session is already
  // readable as you approach rather than snapping on at the doorstep.
  updateLitBoard(best && bestDist <= SCREEN.LIGHT_RANGE ? best : null);

  promptMesh.visible = !!nearPlot && !hud.isDoorOpen && !working;

  updateMarkers(dt);
  if (promptMesh.visible) {
    // Over the doorstep rather than the door itself: on the door it collides with
    // the house's name board and the arch, and reads as part of the building.
    promptMesh.position.set(nearPlot.stand.x, 2.45, nearPlot.stand.z);
    promptMesh.lookAt(camera.position.x, promptMesh.position.y, camera.position.z);
  }
}

/**
 * Turn every name marker to face the camera, and fade the one you have arrived at.
 *
 * The fade is the point of the marker existing: it is a wayfinding aid, so once
 * you are standing at the house it has done its job and would only be in the way
 * of the thing it led you to.
 */
function updateMarkers(dt) {
  const blend = 1 - Math.exp(-8 * dt);   // frame-rate independent, like everything else here
  for (const house of houses.values()) {
    const m = house.marker;
    if (!m) continue;
    m.lookAt(camera.position.x, m.position.y, camera.position.z);

    const d = Math.hypot(walker.position.x - m.position.x, walker.position.z - m.position.z);
    // Full strength beyond DOOR_RANGE + 4, gone by DOOR_RANGE.
    const want = Math.max(0, Math.min(1, (d - INTERACT.DOOR_RANGE) / 4));
    const bag = m.userData.village;
    const next = bag.sign.material.opacity + (want - bag.sign.material.opacity) * blend;
    bag.sign.material.opacity = next;
    bag.pin.material.opacity = next;
    bag.pin.material.transparent = true;
    m.visible = next > 0.02 && !working;
  }
}

// ── the boards ──────────────────────────────────────────────────────────────

/**
 * Which of a project's sessions a board shows when you simply walk up to it: one
 * that is waiting on you if there is one, because that is the reason to look, and
 * otherwise whichever this window has open first.
 *
 * Only `local` sessions are candidates. A session running in another browser
 * window has no xterm and no socket here, so there is nothing to mirror — data.js
 * already draws that line and hud.js already explains it on the card.
 */
function boardSessionFor(ctxId) {
  const entry = model.byCtx.get(ctxId);
  if (!entry || !entry.local.length) return null;
  return entry.local.find((s) => s.waitingForInput) || entry.local[0];
}

/** Move the one mirror onto `plot`'s board, darkening whatever had it. */
function updateLitBoard(plot) {
  if (plot === litPlot) {
    // Same board, but the session on it may have gone away (closed, or the tab
    // moved to another window) — or one may have appeared in an empty house.
    if (plot) refreshLitSession(plot);
    return;
  }

  if (litPlot) {
    const prev = houses.get(litPlot.ctxId);
    if (prev) darkenBoard(prev.board);
  }
  litPlot = plot;
  boardShowing = '';
  if (!plot) {
    mirror.unmount();
    if (working) stopWorking();
    return;
  }
  refreshLitSession(plot);
}

// What the lit board is currently showing, so the work below happens on change
// rather than on every frame. This runs out of updateProximity(), i.e. sixty times
// a second: re-seeding a terminal or re-flagging a material needsUpdate at that
// rate is the difference between a mod that idles and one that melts a laptop.
let boardShowing = '';

function refreshLitSession(plot) {
  const house = houses.get(plot.ctxId);
  if (!house) return;

  const session = boardSessionFor(plot.ctxId);
  const entry = model.byCtx.get(plot.ctxId);
  const elsewhere = entry ? entry.elsewhere : 0;
  const wanted = session ? `s:${session.id}` : `n:${elsewhere}`;
  if (wanted === boardShowing) return;
  boardShowing = wanted;

  if (!session) {
    // Nothing mirrorable. Say so on the glass rather than leaving a dead panel:
    // an unlit board beside a house with its lights on reads as broken.
    mirror.showNotice(elsewhere
      ? `${elsewhere} session${elsewhere > 1 ? 's' : ''} running in another window`
      : 'nobody home');
    if (working) stopWorking();
  } else {
    const err = mirror.mount(session.id);
    if (err) mirror.showNotice(err.toLowerCase());
    else if (working) hud.setWorking(litSessionName());
  }

  if (mirror.live) lightBoard(house.board, mirror.texture, mirror.aspect);
  else darkenBoard(house.board);
  reframeBoard();
}

/**
 * Where the camera stands to read a board.
 *
 * The distance is solved, not chosen. At a vertical field of view of `fov` the
 * frame is `2·d·tan(fov/2)` tall at distance d, and `×aspect` wide, so the d that
 * makes the panel cover READ_FILL of the frame falls straight out — taken as the
 * larger of the height-limited and width-limited answers so neither dimension
 * overflows. That is what keeps a margin of village around the board whatever
 * shape the session's terminal happens to be.
 *
 * The aim point is the CPU-side centre of the panel, which the curvature shader
 * then bends a couple of centimetres below where the camera is looking (trap 3 in
 * curvature.js; at this range it is the width of a glyph's stem). Correcting for
 * it would mean duplicating the shader's arithmetic on the CPU for no visible gain.
 */
function shotForBoard(board) {
  board.updateWorldMatrix(true, false);
  const bag = board.userData.village;
  const centre = new THREE.Vector3(0, bag.midY, 0).applyMatrix4(board.matrixWorld);
  const normal = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(board.getWorldQuaternion(new THREE.Quaternion()));
  normal.y = 0;
  normal.normalize();

  const halfFov = Math.tan((camera.fov * Math.PI) / 360);
  const fill = SCREEN.READ_FILL;
  const dForHeight = bag.fitH / (2 * fill * halfFov);
  const dForWidth = bag.fitW / (2 * fill * halfFov * camera.aspect);
  const d = Math.max(dForHeight, dForWidth);

  return {
    position: new THREE.Vector3(centre.x + normal.x * d, centre.y, centre.z + normal.z * d),
    aim: centre,
  };
}

/**
 * Re-solve the shot for the board being read. The answer depends on the window's
 * aspect and on the panel's fitted size, so it is stale after a resize and after
 * the mirror moves to a session with different geometry — both of which happen
 * while standing still, which is exactly when a stale frame is most obvious.
 */
function reframeBoard() {
  if (!working || !litPlot) return;
  const house = houses.get(litPlot.ctxId);
  if (house) rig.setFocus(shotForBoard(house.board));
}

function litSessionName() {
  if (!litPlot || !mirror.sessionId) return null;
  const entry = model.byCtx.get(litPlot.ctxId);
  const session = entry?.sessions.find((s) => s.id === mirror.sessionId);
  return session ? session.name : mirror.sessionId.slice(0, 8);
}

/**
 * Step up to the lit board and take the keyboard with you.
 *
 * Pointer lock is released on the way in — mouse-look at a board you are reading
 * is nothing but a way to lose it — which also frees Escape to be forwarded to the
 * session rather than being eaten by the browser. Stepping back out is Shift+Esc.
 */
function startWorking(plot) {
  const target = plot || litPlot;
  if (!target) return;
  const house = houses.get(target.ctxId);
  if (!house || !mirror.sessionId) return;

  working = true;
  hud.hideDoor();
  if (document.pointerLockElement) document.exitPointerLock();
  canvas.focus();
  // A key held at the moment the keyboard changes hands would otherwise still be
  // held when it changes back, and walk you across the town.
  input.forward = input.back = input.left = input.right = false;
    input.sprint = input.jump = false;
  rig.setFocus(shotForBoard(house.board));
  hud.setVeil(false);
  hud.setWorking(litSessionName());
}

function stopWorking() {
  if (!working) return;
  working = false;
  rig.setFocus(null);
  hud.setWorking(null);
  hud.setVeil(!document.pointerLockElement);
}

// ── loop ────────────────────────────────────────────────────────────────────

const clock = new THREE.Clock();

function animate() {
  // Clamped: a backgrounded tab returns with a huge delta, and an unclamped one
  // teleports the villager through the town before collision gets a look in.
  const dt = Math.min(clock.getDelta(), 0.05);

  // Standing at an open door — or at a board with the keyboard in the session —
  // means standing still.
  const active = (hud.isDoorOpen || working) ? IDLE : input;

  const footfall = walker.update(dt, active, rig.forwardYaw, collide);
  // Jump is an edge; the walker has now had its look at it.
  input.jump = false;
  walker.apply(villager);
  rig.update(dt, walker, camera);

  if (footfall && settings.ambientAudio) {
    const onCobbles = town ? distanceToLane(town.lane, walker.position.x, walker.position.z) < 4.2 : true;
    playFootstep(onCobbles);
  }

  updateProximity(dt);
  mirror.tick(performance.now());
  rain.update(dt, camera);
  sky.position.copy(camera.position);

  renderer.render(scene, camera);
  frame = requestAnimationFrame(animate);
}

let frame = requestAnimationFrame(animate);

// ── start / teardown ────────────────────────────────────────────────────────

data.start();

// Build an empty town immediately so there is something on screen before the
// bridge has answered — the injection lands on the iframe's load event, which can
// be after this module has run.
rebuildTown([], settings);
rain.setEnabled(true);
hud.setSubtitle('looking for your projects…');

function teardown() {
  cancelAnimationFrame(frame);
  data.stop();
  // Before the HUD, because the mirror lives in the PARENT document — the iframe
  // going away does not take it with it, and a leaked xterm is a leaked WebGL
  // context every time the mod is opened.
  mirror.dispose();
  hud.dispose();
  disposeAudio();
  rain.dispose();
  disposeSubtree(scene);
  disposeProps();
  disposeTextures();
  renderer.dispose();
}

// A fullscreen mod's iframe is destroyed when it is hidden, so this is the normal
// exit; the MutationObserver covers the case where the host swaps the view out
// without the iframe unloading first (mods/go-karts/go-karts.js:902 does the same).
window.addEventListener('pagehide', teardown);

try {
  const modContainer = parent.document.getElementById('mod-container');
  if (modContainer) {
    new MutationObserver(() => {
      if (modContainer.style.display === 'none') {
        if (document.pointerLockElement) document.exitPointerLock();
      }
    }).observe(modContainer, { attributes: true, attributeFilter: ['style'] });
  }
} catch {
  // Not same-origin, or no parent — nothing to observe, and nothing breaks.
}
