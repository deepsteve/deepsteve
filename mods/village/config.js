// Every number that decides how the Village looks and feels, in one file.
//
// The *feel* is what carries this mod, so the values that
// shape it — walk acceleration, the long lens, the camera spring, the curvature
// strength — are collected here rather than buried at their use sites. Tune here.

// ── the lane and the lots ───────────────────────────────────────────────────
// Consumed by layout.js, which is deliberately three.js-free so it can be unit
// tested in plain Node. Distances are in metres; the villager is ~1.5m tall.

export const LAYOUT = {
  // Spacing of the spline's control points down the lane, and how far the lane
  // wanders sideways. Together these set how much the road winds.
  CONTROL_SPACING: 26,
  WANDER: 9.5,
  WANDER_RATE: 0.62,

  // The square sits at the head of the lane; the first house is this far along it.
  // Everything here was pulled in after the first walk-through: the town was
  // correct and much too spread out, so getting anywhere was a hike and you could
  // not see the next house from the one you were at. A house is 8.4m wide, so
  // PLOT_SPACING at 11 puts same-side neighbours ~22m apart — close enough that
  // two or three are always in frame, far enough that the gardens do not merge.
  SQUARE_RADIUS: 8,
  FIRST_PLOT_AT: 14,
  PLOT_SPACING: 11,

  // How far a house sits off the centre-line of the lane, and how far past the
  // last house the cobbles run out.
  PLOT_OFFSET: 9.5,
  TAIL: 14,

  // Archived projects live on a spur past the end of the lane: further out, more
  // spread apart, so the outskirts read as outskirts.
  ARCHIVED_OFFSET: 14,
  ARCHIVED_SPACING: 15,

  HOUSE_WIDTH: 8.4,
  HOUSE_DEPTH: 7.2,
};

// ── movement ────────────────────────────────────────────────────────────────
// This started as a slow walk with no sprint and no jump, on the grounds that all
// three are what make a thing read as an FPS. Tried, and it was simply too slow to
// get anywhere in, so sprint and jump are in. The unhurried feel now lives in the
// acceleration curve rather than in the top speed: you still lean into a walk
// instead of snapping to full pace.

export const MOVE = {
  WALK_SPEED: 5.2,       // m/s, top speed at a walk
  SPRINT_SPEED: 9.4,     // m/s while Shift is held
  ACCEL: 13.0,           // m/s² toward the target velocity
  DAMPING: 9.0,          // exponential decay when no key is held
  TURN_RATE: 11.0,       // rad/s the avatar's body swings toward its heading
  RADIUS: 0.55,          // collision radius
  STEP_LENGTH: 1.5,      // metres per footstep, drives the walk cycle and audio

  // The jump. Apex is v²/2g and airtime is 2v/g, so these two numbers are
  // ~1.2m up and ~0.8s in the air — high enough to clear a picket fence by
  // eye, slow enough to read as a hop rather than a twitch.
  JUMP_SPEED: 6.2,       // m/s upward impulse
  GRAVITY: 16.0,         // m/s² down
  AIR_CONTROL: 0.45,     // fraction of ground acceleration available airborne
};

// ── camera ──────────────────────────────────────────────────────────────────
// Third person (the user's choice over the issue's first-person ask). The long
// lens and the spring are the two things doing the work: a 38° FOV flattens the
// town the way a long lens does in any toy-scale world, and a critically damped
// spring is what
// "eases toward where you're looking instead of snapping 1:1" means in practice.

export const CAMERA = {
  FOV: 38,
  NEAR: 0.1,
  FAR: 260,

  DISTANCE: 9.2,         // metres behind the villager
  HEIGHT: 4.3,           // metres above their feet
  LOOK_HEIGHT: 1.55,     // the point on the villager the camera aims at

  // A jump the camera followed exactly would be a jump you could not see — the
  // villager would sit still in the frame while the world dropped. Following
  // most of it keeps them in shot; the rest is what you actually read as height.
  JUMP_FOLLOW: 0.72,

  // Sprinting opens the lens a few degrees. SPRINT_FOV_AT is in m/s and sits
  // above the walk top speed, so only a real sprint triggers it.
  SPRINT_FOV: 45,
  SPRINT_FOV_AT: 6.2,
  FOV_RATE: 4.0,

  // Spring stiffness for position and for the aim point. Higher = tighter.
  // Both are critically damped, so neither ever overshoots.
  POS_STIFFNESS: 3.6,
  AIM_STIFFNESS: 7.5,

  MOUSE_SENSITIVITY: 0.0022,

  // The pitch band, and the two numbers that make looking UP actually possible.
  //
  // The first pass allowed -0.22..0.44 rad, which sounds like a band but was not
  // one: the camera sits at HEIGHT + sin(pitch)·DISTANCE, so even at the most
  // upward pitch it was still 2.3m up and aiming at a point 1.55m up — always
  // looking slightly DOWN. There was no pitch in range that showed you the sky.
  //
  // MIN_HEIGHT stops the widened band burying the camera underground, and
  // PITCH_LIFT raises the aim point as you pitch up, which is what actually tilts
  // the view skyward rather than just lowering the camera.
  PITCH_MIN: -0.62,
  PITCH_MAX: 0.80,
  MIN_HEIGHT: 1.25,      // metres; the camera never goes below this
  PITCH_LIFT: 7.0,       // metres the aim rises at full upward pitch

  // Yaw drifts to sit behind the direction of travel while you walk, so the
  // camera "settles" without you touching the mouse. Suppressed briefly after
  // any real mouse input so it never fights the player.
  AUTO_YAW_RATE: 0.9,
  AUTO_YAW_DELAY: 1.4,   // seconds of no mouse before the drift resumes

  BOB_AMOUNT: 0.055,     // metres — gentle, low amplitude, per the issue
  BOB_RATE: 2.0,         // bobs per step
};

// ── world curvature ─────────────────────────────────────────────────────────
// The signature curved horizon. Distant geometry bends down and away so the town
// reads as sitting on a small sphere. See curvature.js for the mechanism.

export const CURVE = {
  STRENGTH: 0.0016,      // metres of drop per metre² of view-space distance
  FOG_NEAR: 42,
  FOG_FAR: 155,
};

// ── interaction ─────────────────────────────────────────────────────────────

export const INTERACT = {
  // A doorstep sits ~6.5m off the centre of the lane, so anything under that means
  // you have to leave the road and aim at the door before the village admits the
  // house is there. Walking down the lane past a house should offer it to you.
  DOOR_RANGE: 7.5,       // metres from a doorstep before its card can open
  CLOSE_RANGE: 10.5,     // walk past this and an open card closes itself
};

// ── the project board ───────────────────────────────────────────────────────
// A session is read *in* the village, on a board in the project's front garden,
// and never by handing you over to the flat terminal — that hand-off is what made
// the mod feel like a launcher instead of a place. The two distances below are the
// whole design: walking near lights a board, working at one dollies the camera in
// until 80 columns are actually readable, and both are the same camera the whole
// time, so the village stays behind you rather than being left.

export const SCREEN = {
  // The panel is a box the terminal is fitted INTO, preserving its aspect — a
  // session's geometry is its own business (80×24, or 200×50 in a wide window),
  // and stretching it to a fixed rectangle is how you get unreadable glyphs.
  // Sized as a garden noticeboard, not a billboard. The first pass at 5.2×3.0
  // was wider than a house's frontage and, once the town was tightened up, the
  // boards lined the lane and you could not see past them. Shrinking costs no
  // legibility at all, because READ_FILL below derives the camera distance FROM
  // this size — a smaller board simply means standing closer to read it.
  WIDTH: 3.6,            // metres — the widest the panel gets
  HEIGHT: 2.1,           // metres — the tallest
  SILL: 1.0,             // ground to the bottom of the frame

  // Where the board stands in the plot's own frame: beside the path rather than
  // across it, on the opposite side from the mailbox, angled back at the doorstep.
  OFFSET_X: -1.1,        // metres beyond the house's flank
  OFFSET_Z: 1.6,         // metres out from the front wall
  YAW: 0.38,

  // The mirror terminal. Only ever one exists — see screen.js.
  COLS: 80,
  ROWS: 24,
  FONT_SIZE: 18,
  REFRESH_MS: 120,       // how often it is re-rendered and re-sampled

  // Working at a board. The reading distance is DERIVED, not fixed: it is
  // whatever puts the panel across this fraction of the frame, given the panel's
  // fitted size, the 38° lens and the window's aspect. A fixed distance cannot do
  // this job — the panel's shape follows the session's, so one number that framed
  // an 80×24 board correctly buried the village entirely under a taller one.
  //
  // Strictly below 1: the margin is the point. You are meant to be able to see
  // the town around the thing you are reading, and a board that fills the frame
  // is the flat terminal view with extra steps.
  READ_FILL: 0.78,

  LIGHT_RANGE: 9.0,      // walk inside this and the nearest board wakes up
};

// ── palette ─────────────────────────────────────────────────────────────────
// Saturated, hand-painted, no PBR. Greens push toward yellow so wet grass still
// reads as green under an overcast sky.

export const PALETTE = {
  GRASS: 0x6ba03c,
  GRASS_DARK: 0x4e7d2c,
  COBBLE: 0x9a9086,
  COBBLE_DARK: 0x6f665d,
  SKY_TOP: 0x8d9fae,
  SKY_BOTTOM: 0xc3cbd0,
  FOG: 0xa8b4bc,

  TRUNK: 0x6b4a2f,
  LEAF: 0x4f8a30,
  LEAF_LIGHT: 0x6fa843,

  BRICK: 0x9c5a44,
  PAPER: 0xf6efdc,
  WOOD: 0x7a5230,
  WOOD_DARK: 0x4a3018,
  POST_RED: 0xc0392b,
  WHITE: 0xf4efe2,

  WINDOW_DARK: 0x3a4750,
  WINDOW_LIT: 0xffd98a,

  OVERGROWN: 0x5f6b4a,
  BOARD: 0x8a7a63,
};

// Six house schemes. Every registered project gets one, picked by hashing its id,
// so a project's house is the same house every time you walk down the lane —
// which is what lets a building be recognised at a glance.
export const HOUSE_SCHEMES = [
  { roof: 0xb4392e, wall: 0xf2e9d8, timber: 0x8c3f30, door: 0x7a4a28 },
  { roof: 0xc4552f, wall: 0xefe4cd, timber: 0x6d4526, door: 0x5e3a20 },
  { roof: 0xa32f3c, wall: 0xf6efe0, timber: 0x93372f, door: 0x83512c },
  { roof: 0xcc6a34, wall: 0xeee0c6, timber: 0x7d4a2a, door: 0x6a4023 },
  { roof: 0x99323a, wall: 0xf4ecdc, timber: 0x5f3c24, door: 0x7f4d2a },
  { roof: 0xbe4630, wall: 0xf0e6d0, timber: 0x86402c, door: 0x5c3820 },
];

// ── weather ─────────────────────────────────────────────────────────────────

export const RAIN = {
  COUNT: 2600,
  RADIUS: 26,            // cylinder around the camera the drops live in
  TOP: 17,
  FALL_SPEED: 22,
  STREAK: 0.85,          // metres of vertical smear per drop
  SLANT: 1.6,            // horizontal drift, so it isn't falling dead straight
};
