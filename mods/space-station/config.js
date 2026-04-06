// ── Constants & shared state ────────────────────────────────────────────────

export const ROBOT_COLORS = [
  { body: 0x4488cc, accent: 0x336699, hex: '#4488cc' }, // steel blue
  { body: 0x999999, accent: 0x777777, hex: '#999999' }, // silver
  { body: 0xcc6633, accent: 0x994422, hex: '#cc6633' }, // copper
  { body: 0x44cc88, accent: 0x339966, hex: '#44cc88' }, // green metal
  { body: 0xcc4444, accent: 0x993333, hex: '#cc4444' }, // red alloy
  { body: 0xcccc44, accent: 0x999933, hex: '#cccc44' }, // gold
  { body: 0x8844cc, accent: 0x663399, hex: '#8844cc' }, // purple alloy
  { body: 0x44cccc, accent: 0x339999, hex: '#44cccc' }, // teal
];

export const MODE_ORBIT = 0;
export const MODE_FIRST = 1;

export const GRAV_INTERIOR = 0;
export const GRAV_EVA = 1;
export const GRAV_HULL = 2;

export const STATION_W = 40, STATION_H = 10, STATION_D = 40;
export const STATION_HALF_W = STATION_W / 2;
export const STATION_HALF_D = STATION_D / 2;

export const ROBOT_RADIUS = 0.35;
export const ROBOT_HEIGHT = 1.8;

export const DOOR_INTERACT_DIST = 3;
export const DOOR_AUTO_CLOSE = 5;

export const PHYSICS = {
  gravity: 9.8,
  jumpForce: 7,
  maxSpeed: 12,
  friction: 0.92,
  jetpackForce: 14,
  jetpackFuelMax: 100,
  jetpackBurnRate: 25,
  jetpackRechargeRate: 15,
  evaDamping: 0.97,
};

// ── Shared mutable state ────────────────────────────────────────────────────

export const state = {
  sessions: [],
  viewMode: MODE_ORBIT,
  followId: null,
  physPanelOpen: false,
};

export const robotState = {};

export const input = {
  w: false, a: false, s: false, d: false,
  space: false, shift: false, e: false, click: false,
};
