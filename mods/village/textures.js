// Every texture in the Village is drawn here, at runtime, onto a small 2D canvas.
//
// Two reasons, and the second one is a hard constraint rather than a preference:
//
//   1. The look. Deliberately sixth-generation-console: chunky, low-resolution texels that
//      read as SOFT, not crisp. That is a small canvas magnified with ordinary
//      bilinear filtering — three.js's default. It is worth being explicit that
//      this is NOT the nearest-neighbour pixel-art look; nearest would give hard
//      square texels, which is the opposite of what the issue's reference asks for.
//
//   2. release.sh:227 embeds a mod's files through a text heredoc, flat, with no
//      recursion. A binary asset or a subdirectory is silently dropped from the
//      curl installer while working fine in dev. So a mod that wants art has to
//      generate it.
//
// Everything is cached by key — a town of twelve houses shares six wall textures.

import * as THREE from 'three';
import { PALETTE } from './config.js';

const cache = new Map();

function hex(n) {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** Mix two 0xRRGGBB colours, t=0 → a, t=1 → b. */
function mix(a, b, t) {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  return (
    ((ar + (br - ar) * t) << 16) |
    ((ag + (bg - ag) * t) << 8) |
    (ab + (bb - ab) * t)
  );
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Wrap a draw call so anything it paints near an edge is repeated on the opposite
 * one. Cheap way to make a hand-drawn pattern tile without seams: draw it nine
 * times, offset by the canvas size in each direction.
 */
function tiled(ctx, w, h, draw) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      ctx.save();
      ctx.translate(ox * w, oy * h);
      draw(ctx);
      ctx.restore();
    }
  }
}

/**
 * Finish a canvas into a texture. Linear filtering with mipmaps is the whole point
 * (see the header) — do not "fix" this to NearestFilter.
 */
function finish(c, { repeat = null, key = null } = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if (repeat) tex.repeat.set(repeat[0], repeat[1]);
  if (key) cache.set(key, tex);
  return tex;
}

function cached(key, build) {
  if (cache.has(key)) return cache.get(key);
  const tex = build();
  cache.set(key, tex);
  return tex;
}

// Deterministic per-texture jitter, so a texture looks the same every reload.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ── the lane ────────────────────────────────────────────────────────────────

/**
 * Hex cobblestone. Four columns by four rows on a 128px tile, odd rows offset by
 * half a cell, which is a hexagonal packing and tiles exactly. The cells are 32×32
 * rather than a true 1:sqrt(3) hexagon so the tile stays square and every call
 * site can use a uniform repeat; the stones read as hexes regardless.
 */
export function cobbleTexture() {
  return cached('cobble', () => {
    const S = 128;
    const CELL = 32;
    const c = canvas(S, S);
    const ctx = c.getContext('2d');

    ctx.fillStyle = hex(PALETTE.COBBLE_DARK);
    ctx.fillRect(0, 0, S, S);

    const rand = rng(0x51ce);
    tiled(ctx, S, S, (g) => {
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const cx = col * CELL + (row % 2 ? CELL / 2 : 0) + CELL / 2;
          const cy = row * CELL + CELL / 2;
          const r = CELL * 0.56;
          const tone = mix(PALETTE.COBBLE, PALETTE.COBBLE_DARK, rand() * 0.55);

          g.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i + Math.PI / 6;
            const px = cx + Math.cos(a) * r;
            const py = cy + Math.sin(a) * r * 0.92;
            if (i === 0) g.moveTo(px, py);
            else g.lineTo(px, py);
          }
          g.closePath();
          g.fillStyle = hex(tone);
          g.fill();
          g.strokeStyle = 'rgba(52,46,40,0.55)';
          g.lineWidth = 2.5;
          g.stroke();

          // A lighter fleck on some stones so the surface isn't uniform.
          if (rand() > 0.6) {
            g.fillStyle = 'rgba(255,255,255,0.10)';
            g.beginPath();
            g.ellipse(cx - r * 0.2, cy - r * 0.25, r * 0.3, r * 0.2, 0, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
    });

    return finish(c, { key: 'cobble' });
  });
}

/** Grass: two greens in soft blotches, saturated and hand-painted. */
export function grassTexture() {
  return cached('grass', () => {
    const S = 128;
    const c = canvas(S, S);
    const ctx = c.getContext('2d');

    ctx.fillStyle = hex(PALETTE.GRASS);
    ctx.fillRect(0, 0, S, S);

    const rand = rng(0x6a5d);
    tiled(ctx, S, S, (g) => {
      for (let i = 0; i < 90; i++) {
        const x = rand() * S;
        const y = rand() * S;
        const r = 4 + rand() * 11;
        g.fillStyle = rand() > 0.5
          ? `rgba(${(PALETTE.GRASS_DARK >> 16) & 255},${(PALETTE.GRASS_DARK >> 8) & 255},${PALETTE.GRASS_DARK & 255},0.5)`
          : 'rgba(150,200,90,0.38)';
        g.beginPath();
        g.ellipse(x, y, r, r * 0.7, rand() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
      // A few blade flecks for texture at close range.
      g.strokeStyle = 'rgba(40,80,25,0.32)';
      g.lineWidth = 1.5;
      for (let i = 0; i < 60; i++) {
        const x = rand() * S;
        const y = rand() * S;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (rand() - 0.5) * 4, y - 3 - rand() * 4);
        g.stroke();
      }
    });

    return finish(c, { key: 'grass' });
  });
}

// ── houses ──────────────────────────────────────────────────────────────────

/** Half-timbered plaster: a pale wall with painted cross-braces. */
export function wallTexture(scheme, schemeIndex) {
  return cached(`wall:${schemeIndex}`, () => {
    const S = 128;
    const c = canvas(S, S);
    const ctx = c.getContext('2d');

    ctx.fillStyle = hex(scheme.wall);
    ctx.fillRect(0, 0, S, S);

    // Plaster mottle — small and low contrast, this is what stops it reading flat.
    const rand = rng(0x1100 + schemeIndex);
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.02 + rand() * 0.035})`;
      ctx.beginPath();
      ctx.arc(rand() * S, rand() * S, 3 + rand() * 9, 0, Math.PI * 2);
      ctx.fill();
    }

    // Timbers: a frame plus a St Andrew's cross, the classic half-timbered shape.
    ctx.strokeStyle = hex(scheme.timber);
    ctx.lineCap = 'square';
    tiled(ctx, S, S, (g) => {
      g.lineWidth = 13;
      g.strokeRect(6, 6, S - 12, S - 12);
      g.lineWidth = 10;
      g.beginPath();
      g.moveTo(10, 10); g.lineTo(S - 10, S - 10);
      g.moveTo(S - 10, 10); g.lineTo(10, S - 10);
      g.stroke();
    });

    // Grain on the timbers.
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 24; i++) {
      const y = rand() * S;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(S, y + (rand() - 0.5) * 5);
      ctx.stroke();
    }

    return finish(c, { key: `wall:${schemeIndex}` });
  });
}

/** Steep roof tiles: overlapping scalloped courses. */
export function roofTexture(scheme, schemeIndex) {
  return cached(`roof:${schemeIndex}`, () => {
    const S = 128;
    const c = canvas(S, S);
    const ctx = c.getContext('2d');

    ctx.fillStyle = hex(mix(scheme.roof, 0x000000, 0.28));
    ctx.fillRect(0, 0, S, S);

    const rand = rng(0x2200 + schemeIndex);
    const ROWS = 8;
    const rowH = S / ROWS;
    tiled(ctx, S, S, (g) => {
      for (let row = 0; row < ROWS; row++) {
        const y = row * rowH;
        const off = row % 2 ? rowH * 0.8 : 0;
        for (let col = -1; col < 8; col++) {
          const x = col * rowH * 1.6 + off;
          g.fillStyle = hex(mix(scheme.roof, 0xffffff, rand() * 0.16));
          g.beginPath();
          g.moveTo(x, y + rowH);
          g.lineTo(x, y + rowH * 0.45);
          g.quadraticCurveTo(x + rowH * 0.8, y - rowH * 0.25, x + rowH * 1.6, y + rowH * 0.45);
          g.lineTo(x + rowH * 1.6, y + rowH);
          g.closePath();
          g.fill();
          g.strokeStyle = 'rgba(50,20,15,0.4)';
          g.lineWidth = 1.6;
          g.stroke();
        }
      }
    });

    return finish(c, { key: `roof:${schemeIndex}` });
  });
}

/** Vertical planks with a couple of iron bands — doors, shutters, the board frame. */
export function woodTexture(color = PALETTE.WOOD, key = 'wood') {
  return cached(key, () => {
    const S = 64;
    const c = canvas(S, S);
    const ctx = c.getContext('2d');

    ctx.fillStyle = hex(color);
    ctx.fillRect(0, 0, S, S);

    const rand = rng(0x3300 ^ color);
    tiled(ctx, S, S, (g) => {
      g.strokeStyle = 'rgba(0,0,0,0.34)';
      g.lineWidth = 2;
      for (let x = 0; x <= S; x += 16) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, S);
        g.stroke();
      }
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 30; i++) {
      const x = rand() * S;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (rand() - 0.5) * 3, S);
      ctx.stroke();
    }

    return finish(c, { key });
  });
}

/** Brick courses for the notice board. */
export function brickTexture() {
  return cached('brick', () => {
    const S = 128;
    const c = canvas(S, S);
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#7d6b60';
    ctx.fillRect(0, 0, S, S);

    const rand = rng(0x44b1);
    const ROWS = 8;
    const rowH = S / ROWS;
    tiled(ctx, S, S, (g) => {
      for (let row = 0; row < ROWS; row++) {
        const y = row * rowH;
        const off = row % 2 ? rowH : 0;
        for (let col = -1; col < 5; col++) {
          const x = col * rowH * 2 + off;
          g.fillStyle = hex(mix(PALETTE.BRICK, rand() > 0.5 ? 0xffffff : 0x000000, rand() * 0.22));
          g.fillRect(x + 2, y + 2, rowH * 2 - 4, rowH - 4);
        }
      }
    });

    return finish(c, { key: 'brick' });
  });
}

/** A soft-edged puddle mask: white in the middle, transparent at the rim. */
export function puddleTexture() {
  return cached('puddle', () => {
    const S = 64;
    const c = canvas(S, S);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    cache.set('puddle', tex);
    return tex;
  });
}

/** A round soft blob for the painted shadows that stand in for shadow maps. */
export function blobTexture() {
  return cached('blob', () => {
    const S = 64;
    const c = canvas(S, S);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.42)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    cache.set('blob', tex);
    return tex;
  });
}

// ── lettering ───────────────────────────────────────────────────────────────

/**
 * Painted lettering on a plate — POST on a mailbox, NOTICE on the board, a project
 * name on a house sign. These are meshes in the world rather than DOM overlays,
 * which is deliberate: see the note in curvature.js about CPU-side projection.
 */
export function labelTexture(text, opts = {}) {
  const {
    width = 256,
    height = 64,
    bg = '#f4efe2',
    fg = '#3a2a1c',
    border = '#4a3018',
    font = 'Press Start 2P',
    size = 22,
    key = null,
  } = opts;

  const cacheKey = key || `label:${text}:${width}x${height}:${bg}:${fg}:${size}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const c = canvas(width, height);
  const ctx = c.getContext('2d');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.max(3, height * 0.08);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth);
  }

  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Shrink to fit rather than clipping: a long project name must still be readable.
  let px = size;
  ctx.font = `${px}px "${font}", monospace`;
  while (px > 7 && ctx.measureText(text).width > width * 0.86) {
    px -= 1;
    ctx.font = `${px}px "${font}", monospace`;
  }
  ctx.fillText(text, width / 2, height / 2 + 1);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  cache.set(cacheKey, tex);
  return tex;
}

/**
 * A pinned paper notice. Text is drawn as ruled ink lines rather than words: the
 * board carries one of these per session waiting on you, and at the distance you
 * read the board from, lines say "a notice" more clearly than 5px type would.
 */
export function noticeTexture(variant = 0) {
  return cached(`notice:${variant}`, () => {
    const W = 64;
    const H = 88;
    const c = canvas(W, H);
    const ctx = c.getContext('2d');

    ctx.fillStyle = hex(PALETTE.PAPER);
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    const rand = rng(0x9900 + variant);
    ctx.fillStyle = '#4a3a2a';
    ctx.fillRect(9, 11, W - 18, 5);
    for (let i = 0; i < 7; i++) {
      const y = 26 + i * 8;
      ctx.fillStyle = 'rgba(74,58,42,0.55)';
      ctx.fillRect(9, y, (W - 20) * (0.5 + rand() * 0.5), 3);
    }
    // The pin.
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.arc(W / 2, 6, 4, 0, Math.PI * 2);
    ctx.fill();

    return finish(c, { key: `notice:${variant}` });
  });
}

/** Drop every cached texture. Called on teardown so a re-open starts clean. */
export function disposeTextures() {
  for (const tex of cache.values()) tex.dispose();
  cache.clear();
}
