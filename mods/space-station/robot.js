import * as THREE from 'three';
import { ROBOT_COLORS } from './config.js';

// ── Robot mesh ──────────────────────────────────────────────────────────────

export function createRobotMesh(colorIdx) {
  const group = new THREE.Group();
  const c = ROBOT_COLORS[colorIdx % ROBOT_COLORS.length];
  const bodyMat = new THREE.MeshPhongMaterial({ color: c.body, shininess: 80 });
  const accentMat = new THREE.MeshPhongMaterial({ color: c.accent, shininess: 60 });
  const visorMat = new THREE.MeshPhongMaterial({
    color: 0x00ddff, emissive: 0x00ddff, emissiveIntensity: 0.5,
    transparent: true, opacity: 0.7, shininess: 100,
  });

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 0.5), bodyMat);
  torso.position.y = 0.9; torso.castShadow = true; group.add(torso);

  // Chest plate
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.05), accentMat);
  chest.position.set(0, 0.9, 0.26); group.add(chest);

  // Head
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.45), bodyMat);
  head.position.set(0, 1.6, 0); head.castShadow = true; head.name = 'head';
  group.add(head);

  // Visor
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.05), visorMat);
  visor.position.set(0, 1.6, 0.24); visor.name = 'visor';
  group.add(visor);

  // Antenna
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), accentMat);
  antenna.position.set(0, 1.97, 0); group.add(antenna);

  // Antenna tip (glowing)
  const antennaTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 8, 8),
    new THREE.MeshPhongMaterial({ color: 0x00ddff, emissive: 0x00ddff, emissiveIntensity: 0.8 })
  );
  antennaTip.position.set(0, 2.15, 0); antennaTip.name = 'antennaTip';
  group.add(antennaTip);

  // Arms
  const armGeo = new THREE.BoxGeometry(0.18, 0.5, 0.18);
  const forearmGeo = new THREE.BoxGeometry(0.16, 0.45, 0.16);
  for (const [side, sign] of [['left', -1], ['right', 1]]) {
    const upper = new THREE.Mesh(armGeo, bodyMat);
    upper.position.set(sign * 0.5, 0.95, 0); upper.castShadow = true;
    upper.name = side + 'UpperArm'; group.add(upper);

    const fore = new THREE.Mesh(forearmGeo, accentMat);
    fore.position.set(sign * 0.5, 0.48, 0); fore.castShadow = true;
    fore.name = side + 'Forearm'; group.add(fore);
  }

  // Legs
  const legGeo = new THREE.BoxGeometry(0.22, 0.4, 0.22);
  for (const [side, sign] of [['left', -1], ['right', 1]]) {
    const leg = new THREE.Mesh(legGeo, accentMat);
    leg.position.set(sign * 0.2, 0.3, 0); leg.castShadow = true;
    leg.name = side + 'Leg'; group.add(leg);
  }

  // Jetpack body
  const jetpack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.2), accentMat);
  jetpack.position.set(0, 0.9, -0.35); group.add(jetpack);

  // Jetpack nozzles
  const nozzleMat = new THREE.MeshPhongMaterial({ color: 0x666677, shininess: 60 });
  for (const [side, sign] of [['left', -1], ['right', 1]]) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.15, 8), nozzleMat);
    nozzle.position.set(sign * 0.15, 0.7, -0.3);
    nozzle.name = side + 'Nozzle'; group.add(nozzle);
  }

  // Ground shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 1.0),
    new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.2 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.02, 0);
  shadow.name = 'shadow';
  group.add(shadow);

  return group;
}

// ── Animation ───────────────────────────────────────────────────────────────

export function animateRobot(m, now) {
  const mesh = m.mesh;
  const speed = Math.sqrt(m.vel.x * m.vel.x + m.vel.z * m.vel.z);
  const t = now * 0.003;
  const walkAmp = Math.min(speed / 8, 1) * 0.35;
  const walkFreq = speed * 0.5;

  for (const child of mesh.children) {
    switch (child.name) {
      case 'leftUpperArm':  child.rotation.x = Math.sin(t * walkFreq) * walkAmp; break;
      case 'rightUpperArm': child.rotation.x = -Math.sin(t * walkFreq) * walkAmp; break;
      case 'leftForearm':   child.rotation.x = Math.sin(t * walkFreq) * walkAmp * 0.7 - 0.15; break;
      case 'rightForearm':  child.rotation.x = -Math.sin(t * walkFreq) * walkAmp * 0.7 - 0.15; break;
      case 'leftLeg':       child.rotation.x = -Math.sin(t * walkFreq) * walkAmp * 0.5; break;
      case 'rightLeg':      child.rotation.x = Math.sin(t * walkFreq) * walkAmp * 0.5; break;
      case 'head':          child.position.y = 1.6 + Math.sin(t * 2) * 0.01; break;
      case 'antennaTip':    child.material.emissiveIntensity = 0.4 + Math.sin(t * 3) * 0.4; break;
      case 'shadow':
        child.position.y = 0.02 - m.pos.y;
        child.material.opacity = Math.max(0.02, 0.2 - m.pos.y * 0.02);
        break;
      case 'leftNozzle':
      case 'rightNozzle':
        if (m.jetpackActive) {
          child.material = child.material.clone();
          child.material.emissive = new THREE.Color(0xff6600);
          child.material.emissiveIntensity = 0.5 + Math.sin(t * 20) * 0.3;
        }
        break;
    }
  }

  mesh.rotation.z = speed < 0.5 ? Math.sin(t * 0.5) * 0.02 : 0;
}

// ── Name labels ─────────────────────────────────────────────────────────────

export function createLabel(name, colorIdx) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const ctx = c.getContext('2d');
  updateLabel(ctx, name, colorIdx);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(4, 0.75, 1);
  sprite.position.y = 2.2;
  sprite._canvas = c; sprite._ctx = ctx;
  return sprite;
}

export function updateLabel(ctx, name, colorIdx) {
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  const display = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
  const hex = ROBOT_COLORS[colorIdx % ROBOT_COLORS.length].hex;
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  const tw = Math.max(display.length * 18 + 30, 80), x = (c.width - tw) / 2;
  _roundRect(ctx, x, 10, tw, 44, 12); ctx.fill();
  ctx.strokeStyle = hex; ctx.lineWidth = 3;
  _roundRect(ctx, x, 10, tw, 44, 12); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '22px "Press Start 2P", monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(display, c.width / 2, 32);
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
