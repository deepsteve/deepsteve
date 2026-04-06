import {
  PHYSICS, ROBOT_COLORS, DOOR_INTERACT_DIST,
  GRAV_INTERIOR, GRAV_EVA, GRAV_HULL,
  MODE_ORBIT, MODE_FIRST,
  robotState, state,
} from './config.js';
import { getNearestDoorDist } from './environment.js';
import * as THREE from 'three';

const _v = new THREE.Vector3();

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function gravLabel(m) {
  if (!m) return '';
  switch (m.gravMode) {
    case GRAV_INTERIOR: return 'INTERIOR';
    case GRAV_EVA: return 'EVA';
    case GRAV_HULL: return 'HULL-WALK';
    default: return '';
  }
}

export function updateHUD(hud, { enterFirstPerson, exitFirstPerson }) {
  let html = '';
  const playerM = state.followId ? robotState[state.followId] : null;
  const robotCount = Object.keys(robotState).length;

  // ── Header ────────────────────────────────────────────────────────────────
  html += '<div id="header"><div style="display:flex;align-items:center;gap:12px">';
  html += '<h1>SPACE STATION</h1>';
  html += `<span class="robot-count">${robotCount} ROBOT${robotCount !== 1 ? 'S' : ''}</span>`;
  html += '</div><div style="display:flex;align-items:center;gap:10px">';
  if (state.viewMode === MODE_FIRST) html += '<button id="back-btn" class="hud-btn back">BACK</button>';
  html += '</div></div>';

  // ── Mode badge ────────────────────────────────────────────────────────────
  if (state.viewMode === MODE_FIRST && playerM) {
    html += `<div id="mode-badge">${gravLabel(playerM)}</div>`;
  }

  // ── Fuel gauge ────────────────────────────────────────────────────────────
  if (state.viewMode === MODE_FIRST && playerM) {
    const pct = (playerM.fuel / PHYSICS.jetpackFuelMax) * 100;
    const cls = pct < 25 ? ' low' : '';
    html += `<div id="fuel-gauge"><div class="fuel-label">JETPACK FUEL</div>`;
    html += `<div class="fuel-track"><div class="fuel-fill${cls}" style="width:${pct}%"></div></div></div>`;
  }

  // ── Door prompt ───────────────────────────────────────────────────────────
  if (state.viewMode === MODE_FIRST && playerM) {
    const doorDist = getNearestDoorDist(_v.copy(playerM.pos));
    if (doorDist < DOOR_INTERACT_DIST) {
      html += '<div id="door-prompt">Press E to open/close door</div>';
    }
  }

  // ── Orbit hint ────────────────────────────────────────────────────────────
  if (state.viewMode === MODE_ORBIT && robotCount > 0) {
    html += '<div id="hint">Click a robot to become it!</div>';
  }

  // ── Crew panel ────────────────────────────────────────────────────────────
  if (robotCount > 0) {
    html += '<div id="crew-panel"><div class="title">CREW</div>';
    for (const [id, m] of Object.entries(robotState)) {
      const sess = state.sessions.find(s => s.id === id);
      const name = sess ? sess.name : id;
      const dn = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
      const c = ROBOT_COLORS[m.colorIdx % ROBOT_COLORS.length];
      const active = id === state.followId ? 'active' : '';
      const status = sess && !sess.waitingForInput ? 'WORKING' : 'IDLE';
      html += `<div class="row ${active}" data-robot-id="${id}">`;
      html += `<div class="dot" style="background:${c.hex}"></div>`;
      html += `<span class="name">${esc(dn)}</span>`;
      html += `<span class="status">${status}</span></div>`;
    }
    html += '</div>';
  }

  // ── No sessions ───────────────────────────────────────────────────────────
  if (state.sessions.length === 0) {
    html += '<div id="no-robots"><div class="big">NO ROBOTS</div>';
    html += '<div class="small">Open some Claude sessions to see them power up!</div></div>';
  }

  // ── Controls hint ─────────────────────────────────────────────────────────
  if (state.viewMode === MODE_FIRST && playerM) {
    const hints = {
      [GRAV_INTERIOR]: 'WASD move / Space jump / E door / ESC back',
      [GRAV_EVA]: 'WASD thrust / Space up / Shift down / F hull-walk / ESC back',
      [GRAV_HULL]: 'WASD walk on hull / F detach / ESC back',
    };
    html += `<div id="hint">${hints[playerM.gravMode] || ''}</div>`;
  }

  // ── Physics panel ─────────────────────────────────────────────────────────
  html += buildPhysicsPanel();

  hud.innerHTML = html;

  // ── Bind events ───────────────────────────────────────────────────────────
  document.getElementById('back-btn')?.addEventListener('click', exitFirstPerson);
  document.querySelectorAll('[data-robot-id]').forEach(el => {
    el.addEventListener('click', () => enterFirstPerson(el.dataset.robotId));
  });
  document.getElementById('phys-toggle')?.addEventListener('click', () => {
    state.physPanelOpen = !state.physPanelOpen;
    updateHUD(hud, { enterFirstPerson, exitFirstPerson });
  });
  for (const key of Object.keys(PHYSICS)) {
    const slider = document.getElementById('phys-' + key);
    if (slider) {
      slider.addEventListener('input', () => {
        PHYSICS[key] = parseFloat(slider.value);
        const valEl = document.getElementById('phys-val-' + key);
        if (valEl) valEl.textContent = PHYSICS[key].toFixed(1);
      });
    }
  }
}

function buildPhysicsPanel() {
  let html = '<div id="physics-panel">';
  html += `<div class="panel-header" id="phys-toggle"><span>SYSTEMS</span><span>${state.physPanelOpen ? '\u25B2' : '\u25BC'}</span></div>`;
  if (state.physPanelOpen) {
    html += '<div class="panel-body">';
    for (const { key, label, min, max, step } of [
      { key: 'gravity', label: 'Gravity', min: 0, max: 20, step: 0.5 },
      { key: 'jumpForce', label: 'Jump Force', min: 3, max: 15, step: 0.5 },
      { key: 'maxSpeed', label: 'Max Speed', min: 5, max: 30, step: 1 },
      { key: 'friction', label: 'Friction', min: 0.5, max: 1, step: 0.01 },
      { key: 'jetpackForce', label: 'Jetpack', min: 5, max: 25, step: 1 },
      { key: 'jetpackBurnRate', label: 'Burn Rate', min: 5, max: 50, step: 5 },
      { key: 'evaDamping', label: 'EVA Damp', min: 0.9, max: 1, step: 0.005 },
    ]) {
      html += '<div class="slider-row">';
      html += `<label>${label}</label>`;
      html += `<input type="range" id="phys-${key}" min="${min}" max="${max}" step="${step}" value="${PHYSICS[key]}">`;
      html += `<span class="val" id="phys-val-${key}">${PHYSICS[key].toFixed(1)}</span>`;
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}
