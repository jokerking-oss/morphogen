// ridge.js -- read the baked sweep and find where the pattern actually lives.
//
// morphogen already ships its whole parameter sweep in map.js: for each of 28x28
// tiles it baked, from 2400 steps each, two numbers -- std, how much structure the
// field ended up holding, and act, how much of it was still moving at the end.
// The page drew that map in the corner of the HUD and never read it again. Nothing
// in the walk used it.
//
// This module reads it back and answers a question the walker was guessing at:
// given where it stands, which way lies more life, and how far can it go before
// the pattern thins out? Upstream answered that with four hardcoded nudges in
// probe() (k -= 0.0003 when dying, k += 0.0003 when uniform) and, in protocol.json,
// a "crescent" of three hand-picked points. Those work. They are also blind: they
// encode what someone once noticed about one part of the box, not what the sweep
// actually measured.
//
// The ridge is what the sweep says: walk up-gradient on life while the local
// neighbourhood agrees, and stop (turn along) once it stops improving. Everything
// here is pure and has no WebGL in it, so it runs in the page and in Node alike.
//
// Terminology, because two words do a lot of work below:
//   life   = how much structure AND how much motion, together. Structure alone is
//            a fossil; the field froze into stripes and stopped. Motion alone is
//            noise. What we want is both. See LIFE_W.
//   agree  = whether the tiles around us point the same way. A single tile with a
//            high reading is usually a fluke of the bake; nine neighbours leaning
//            the same direction is a slope you can trust. See radAgree().

// std and act enter as 0..255 from the bake and were normalised by these divisors,
// recorded at the top of map.js. Dividing brings them back to real units.
const STD_FULL = 0.18;
const ACT_FULL = 0.1;

// The blend: structure weighted against the part still twitching. std carries more
// because at the edges of the box std collapses hard while act wanders, and a dead
// field can still show a flicker of activity as its last ripples even out.
const LIFE_W = Object.freeze({ std: 0.68, act: 0.32 });

// Below this, life is indistinguishable from the bake's own floor. map.js wrote a
// great many literal zeros; they mean "nothing survived here", not "a very small
// amount survived". Treating them as small numbers invents slopes out of absence.
const LIFE_FLOOR = 0.02;

// Each climb hop covers this fraction of whichever axis it travels along. Kept as a
// fraction of the axis' own span rather than an absolute length, precisely so neither
// axis can be over-stepped relative to the other.
const STEP_FRAC = 1/28;

// Higher-frequency floor for the ridgeline itself, and how many steps we allow
// climbing it. A crossing is a bit over half the grid -- enough to traverse a real
// basin, not enough to wander off the map.
const RIDGE_MIN = 0.16;
const RIDGE_MAX_STEPS = 34;


const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Bring the baked bytes back into the open and precompute life for every tile.
 * Pure: the same MAP always yields the same box.
 */
function buildRidge(MAP) {
  if (!MAP || !(MAP.G > 0)) return null;
  const G = MAP.G, n = G*G;
  // Guard on real length, not truthiness: `[]` is truthy, so a map carrying empty
  // arrays would sail through and hand back a box of NaNs instead of admitting it had
  // nothing to read. Every downstream divide then poisons silently, which is the one
  // failure this module must never have. Also insist std/act are indexable at all.
  if (!MAP.std || !MAP.act || MAP.std.length < n || MAP.act.length < n) return null;
  if (![MAP.F0, MAP.F1, MAP.k0, MAP.k1].every(v => Number.isFinite(v))) return null;
  const life = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const std = MAP.std[i]/255, act = MAP.act[i]/255;
    // Below floor -> 0 exactly, so gradients across dead ground are flat rather
    // than slightly, misleadingly sloped.
    const l = LIFE_W.std*std + LIFE_W.act*act;
    life[i] = l < LIFE_FLOOR ? 0 : l;
  }
  return {
    G, life,
    F0: MAP.F0, F1: MAP.F1, k0: MAP.k0, k1: MAP.k1,
    // Tile -> parameter. +0.5 puts it at the tile's centre, not its corner.
    fAt: tx => MAP.F0 + (MAP.F1 - MAP.F0)*((tx + 0.5)/G),
    kAt: ty => MAP.k0 + (MAP.k1 - MAP.k0)*((ty + 0.5)/G),
    txAt: F => clamp01((F - MAP.F0)/(MAP.F1 - MAP.F0))*G - 0.5,
    tyAt: k => clamp01((k - MAP.k0)/(MAP.k1 - MAP.k0))*G - 0.5,
  };
}

/** Bilinear read between tile centres. Outside the box -> 0 (nothing was measured there). */
function lifeAt(r, F, k) {
  if (!r) return 0;
  const tx = clamp01((F - r.F0)/(r.F1 - r.F0))*r.G - 0.5;
  const ty = clamp01((k - r.k0)/(r.k1 - r.k0))*r.G - 0.5;
  const x0 = Math.floor(tx), y0 = Math.floor(ty);
  const fx = tx - x0, fy = ty - y0;
  const at = (x, y) => (x < 0 || y < 0 || x >= r.G || y >= r.G) ? 0 : r.life[y*r.G + x];
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return a*(1 - fx)*(1 - fy) + b*fx*(1 - fy) + c*(1 - fx)*fy + d*fx*fy;
}

/**
 * Central-difference gradient of life at a point, measured in parameter units.
 * Returns [dLife/dF, dLife/dk] -- the direction, in the box, in which life rises
 * fastest from where you stand.
 */
function gradAt(r, F, k, hF, hk, span) {
  if (!r) return [0, 0];
  // A third of a tile. Smaller than this and the differences are quantisation;
  // larger and we round off the very ridges we came to find.
  const dF = (hF || (r.F1 - r.F0)/r.G/3), dk = (hk || (r.k1 - r.k0)/r.G/3);
  const gF = (lifeAt(r, F + dF, k) - lifeAt(r, F - dF, k))/(2*dF);
  const gk = (lifeAt(r, F, k + dk) - lifeAt(r, F, k - dk))/(2*dk);
  // The two axes span wildly different ranges -- F travels 0.086, k only 0.036 --
  // so an unscaled gradient is almost entirely dF/dF. Dividing by each axis' span
  // makes the two components comparable, which is what "which way is up" needs.
  const sF = span ? span.F : (r.F1 - r.F0), sk = span ? span.k : (r.k1 - r.k0);
  return [gF*sF, gk*sk];
}

/**
 * Does the neighbourhood point the same way as the gradient here, or is the local
 * reading a fluke? Samples a ring of six directions and keeps the components that
 * agree with the centre.
 *
 * Returns trust in 0..1. This is the piece that stops the walker chasing noise: the
 * bake is one run per tile, and single tiles do disagree with their neighbours.
 */
function radAgree(r, F, k, rad) {
  if (!r) return 0;
  const Rd = rad || (r.F1 - r.F0)/r.G*1.5;
  const Rk = rad || (r.k1 - r.k0)/r.G*1.5;
  const [cx, cy] = gradAt(r, F, k);
  const mag = Math.hypot(cx, cy);
  if (mag < 1e-9) return 0;
  let hit = 0, tot = 0;
  for (let i = 0; i < 6; i++) {
    const a = i*Math.PI/3;
    const [gx, gy] = gradAt(r, F + Math.cos(a)*Rd, k + Math.sin(a)*Rk);
    if (Math.hypot(gx, gy) < 1e-9) continue;
    tot++;
    if ((cx*gx + cy*gy)/(mag*Math.hypot(gx, gy)) > 0.25) hit++;
  }
  return tot ? hit/tot : 0;
}

/**
 * Ascend one step: from the gradients around us, where is life going up?
 * Returns { F, k, gain, agree } for the best sample we found, or null on dead ground.
 */
function stepUp(r, F, k, opts) {
  if (!r) return null;
  const hopF = (opts && opts.hopF) || (r.F1 - r.F0)/r.G*1.15;
  const hopk = (opts && opts.hopk) || (r.k1 - r.k0)/r.G*1.15;
  const here = lifeAt(r, F, k);
  const agree = radAgree(r, F, k);
  let best = { F, k, gain: 0, agree };
  for (let i = 0; i < 8; i++) {
    const a = i*Math.PI/4;
    const nF = F + Math.cos(a)*hopF, nk = k + Math.sin(a)*hopk;
    if (nF < r.F0 || nF > r.F1 || nk < r.k0 || nk > r.k1) continue;
    const g = lifeAt(r, nF, nk) - here;
    if (g > best.gain) best = { F: nF, k: nk, gain: g, agree: radAgree(r, nF, nk) };
  }
  return best;
}

/**
 * Walk up-gradient until it stops improving, carrying with us the agreed direction
 * rather than each the step's own local whim -- which is what makes the result a
 * line instead of a drunk stagger over the top of the same hill.
 */
function climb(r, F, k, opts) {
  if (!r) return null;
  const maxSteps = (opts && opts.maxSteps) || RIDGE_MAX_STEPS;
  const minGain = (opts && opts.minGain) || 0.004;
  const path = [{ F, k, life: lifeAt(r, F, k) }];
  let cF = F, ck = k, agreed = null;
  for (let s = 0; s < maxSteps; s++) {
    const st = stepUp(r, cF, ck, opts);
    if (!st || st.gain <= minGain) break;
    // Keep a running mean of direction so one contrary tile does not flip us. The
    // vector is carried in *normalised* units (fractions of each axis' span), which
    // is what makes it comparable to itself from step to step; see stepUp().
    const vx = (st.F - cF)/(r.F1 - r.F0), vy = (st.k - ck)/(r.k1 - r.k0);
    if (!agreed) agreed = [vx, vy]; else { agreed[0] = agreed[0]*0.6 + vx*0.4; agreed[1] = agreed[1]*0.6 + vy*0.4; }
    const m = Math.hypot(agreed[0], agreed[1]) || 1;
    // Step along each axis scaled by that axis' OWN span. F travels 0.086 and k only
    // 0.036, so a single shared step length would move k two-and-a-half times further
    // in real terms every hop -- which walked the labyrinth clean out of the top of
    // the box into dead ground while still reporting "up". Fixed here, and asserted
    // in the tests so it cannot come back.
    const hopFrac = m ? 1/m : 0;
    cF = cF + agreed[0]*hopFrac*(r.F1 - r.F0)*STEP_FRAC;
    ck = ck + agreed[1]*hopFrac*(r.k1 - r.k0)*STEP_FRAC;
    if (cF < r.F0 || cF > r.F1 || ck < r.k0 || ck > r.k1) break;
    path.push({ F: cF, k: ck, life: lifeAt(r, cF, ck) });
  }
  const last = path[path.length - 1];
  return { path, top: last, gain: last.life - path[0].life, steps: path.length - 1 };
}

/**
 * The crest: every tile above RIDGE_MIN whose eight neighbours are all below it.
 * This is the measured answer to the hand-drawn three-point crescent in
 * protocol.json -- the same claim, derived from the bake instead of remembered.
 */
function crest(r) {
  if (!r) return [];
  const G = r.G, out = [];
  for (let ty = 0; ty < G; ty++) for (let tx = 0; tx < G; tx++) {
    const v = r.life[ty*G + tx];
    if (v < RIDGE_MIN) continue;
    let top = true;
    for (let dy = -1; dy <= 1 && top; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = tx + dx, ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
      if (r.life[ny*G + nx] > v) { top = false; break; }
    }
    if (top) out.push({ F: r.fAt(tx), k: r.kAt(ty), life: v });
  }
  return out.sort((a, b) => b.life - a.life);
}

/** Nearest crest tile to a point, or null when nothing was ever crest here. */
function nearestCrest(r, crests, F, k) {
  if (!crests || !crests.length) return null;
  let best = null, bd = Infinity;
  for (const c of crests) {
    const d = Math.hypot((c.F - F)/(r.F1 - r.F0), (c.k - k)/(r.k1 - r.k0));
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/** Plain-language reading of where this point sits, for `state()` and the letter. */
function readLine(r, crests, F, k) {
  if (!r) return 'no sweep baked, nothing to read';
  const l = lifeAt(r, F, k);
  const c = nearestCrest(r, crests, F, k);
  const agree = radAgree(r, F, k);
  const band = l < LIFE_FLOOR ? 'dead ground'
    : l < 0.10 ? 'thin'
    : l < RIDGE_MIN ? 'sparse but growing'
    : l < 0.26 ? 'living'
    : 'dense';
  const toward = c ? `crest ${((c.k - k) >= 0 ? 'above' : 'below')}, ${(Math.hypot((c.F - F)/(r.F1 - r.F0), (c.k - k)/(r.k1 - r.k0))*100).toFixed(0)}% away` : 'no crest in reach';
  return `${band} · life ${l.toFixed(3)} · ${toward} · agreement ${(agree*100).toFixed(0)}%`;
}

// ---- how this file is delivered to both runtimes -------------------------------
//
// It is one source file, loaded two ways:
//   in the page : a plain <script> tag, where `export` is a syntax error, so the
//                 functions are published on window.MorphogenRidge instead
//   in the tests: require()'d by Node, which picks up module.exports below
//
// The alternative -- keeping an ESM copy and a script copy -- is two copies of the
// same maths that drift apart. This is one copy with one footer.
//
// The guard order matters: check for `module` first. In Node there is no `window`, and
// in the page there is no `module`; whichever exists takes the exports.
(function publish() {
  var api = {
    buildRidge: buildRidge, lifeAt: lifeAt, gradAt: gradAt, radAgree: radAgree,
    stepUp: stepUp, climb: climb, crest: crest, nearestCrest: nearestCrest,
    readLine: readLine,
    STD_FULL: STD_FULL, ACT_FULL: ACT_FULL, LIFE_W: LIFE_W, LIFE_FLOOR: LIFE_FLOOR,
    STEP_FRAC: STEP_FRAC, RIDGE_MIN: RIDGE_MIN, RIDGE_MAX_STEPS: RIDGE_MAX_STEPS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MorphogenRidge = api;
})();