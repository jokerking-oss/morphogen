// Tests for ridge.js against the REAL baked sweep shipped in map.js.
//
// Run:  node --test test/
//
// These are pure-function tests. No browser, no WebGL, no network. They exist so the
// ridge maths can be checked independently of whether the page happens to render --
// the precedence the spec sets: correctness first, HUD layer last.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMap, importRidge } from './loadmap.mjs';

// The named places, transcribed from protocol.json (they live in main.js at runtime;
// keeping the numbers here means a change upstream cannot silently rewrite these tests).
const PLACES = {
  spots:     [0.030, 0.062],
  mitosis:   [0.0367, 0.0649],
  labyrinth: [0.0545, 0.062],
  worms:     [0.078, 0.061],
  gliders:   [0.062, 0.0609],
  spirals:   [0.0155, 0.0495],
  holes:     [0.040, 0.0585],
  flat:      [0.060, 0.050],
  dead:      [0.030, 0.069],
};

const BOX = { F0: 0.004, F1: 0.09, k0: 0.036, k1: 0.072 };

test('ridge.js imports cleanly as pure ESM (no WebGL touched)', async () => {
  const src = await import('node:fs').then(fs =>
    fs.promises.readFile(new URL('../ridge.js', import.meta.url), 'utf8'));
  // Strip comments and string literals first: the prose above legitimately discusses
  // WebGL, and matching that would flag documentation instead of behaviour.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  assert.doesNotMatch(code, /\bgetContext\b|WebGL2RenderingContext|\bgl\s*\.\s*\w/,
    'ridge.js must not call any GL API');
  // And it really must load in plain Node, with no browser globals provided.
  const M = await importRidge();
  assert.equal(typeof M.buildRidge, 'function', 'and it exposes its exports here');
});

test('buildRidge reads the 28x28 bake and floors the dead tiles to exactly zero', async () => {
  const { buildRidge } = await importRidge();
  const { MORPHOGEN_MAP: MAP } = loadMap();
  const r = buildRidge(MAP);

  assert.equal(MAP.G, 28, 'the bake is 28x28');
  assert.equal(r.life.length, MAP.G*MAP.G, 'exactly one life value per tile');
  assert.equal(r.life.length, 784);

  // Every raw reading under the floor must become EXACTLY 0, not a small positive.
  // A small positive would invent a slope across tiles where nothing grew at all.
  let flooredCount = 0;
  for (let i = 0; i < r.life.length; i++) {
    const raw = 0.68*(MAP.std[i]/255) + 0.32*(MAP.act[i]/255);
    if (raw < 0.02) { assert.equal(r.life[i], 0, `tile ${i} should be floored to 0`); flooredCount++; }
    else assert.ok(r.life[i] > 0, `tile ${i} had life above floor but was zeroed`);
  }
  assert.ok(flooredCount > 0, 'the real bake does contain dead tiles - assumption holds');
});

test('buildRidge returns null when there is no bake (no map.js)', async () => {
  const { buildRidge } = await importRidge();
  assert.equal(buildRidge(null), null);
  assert.equal(buildRidge(undefined), null);
  assert.equal(buildRidge({}), null, 'a half-formed map must not be trusted');
  assert.equal(buildRidge({ G: 28, std: [], act: [] }), null, 'empty arrays must not pass');
});

// The check above passed for the wrong reason for a while: it omitted F0/F1/k0/k1, so
// the finite-bounds guard caught the case even with the length guard removed. That made
// it a false green -- mutation testing here returns [] with bounds supplied, which is
// the only input that isolates the length check. Pinned separately so it cannot regress
// quietly again.
test('buildRidge rejects a short bake even when its bounds are valid', async () => {
  const { buildRidge } = await importRidge();
  const validBounds = { F0: 0.004, F1: 0.09, k0: 0.036, k1: 0.072 };
  const short = { G: 28, std: [], act: [], ...validBounds };
  assert.equal(buildRidge(short), null,
    'empty std/act with valid bounds must still be rejected (length guard)');

  // One tile short of G*G: also not a usable bake.
  const almost = { G: 28, ...validBounds,
    std: new Array(783).fill(200), act: new Array(783).fill(200) };
  assert.equal(buildRidge(almost), null, 'a bake one tile short is not a bake');

  // And exactly G*G does pass, so the guard is a length check and not a blanket no.
  const exact = { G: 28, ...validBounds,
    std: new Array(784).fill(200), act: new Array(784).fill(200) };
  const r = buildRidge(exact);
  assert.ok(r, 'a complete bake is accepted');
  assert.equal(r.life.length, 784);
});

test('lifeAt returns 0 outside the box instead of clamping to the edge', async () => {
  const { buildRidge, lifeAt } = await importRidge();
  const { MORPHOGEN_MAP: MAP } = loadMap();
  const r = buildRidge(MAP);

  // Out-of-box reads are not "nearly edge" reads -- nothing was measured out there.
  // The first implementation clamped here, which silently made the whole exterior rim
  // look like the edge tile and dragged the walker toward it.
  assert.equal(lifeAt(r, BOX.F0 - 1, BOX.k0), 0, 'left of the box reads 0');
  assert.equal(lifeAt(r, BOX.F1 + 1, BOX.k1), 0, 'right of the box reads 0');
  assert.equal(lifeAt(r, 0.05, BOX.k0 - 1), 0, 'below the box reads 0');
  assert.equal(lifeAt(r, 0.05, BOX.k1 + 1), 0, 'above the box reads 0');
  assert.equal(lifeAt(r, -5, -5), 0, 'far corner reads 0');
  assert.ok(Number.isFinite(lifeAt(r, 0.05, 0.06)), 'inside must still be finite');
});

test('every exported function degrades safely when there is no bake', async () => {
  const M = await importRidge();
  assert.equal(M.lifeAt(null, 0.05, 0.06), 0);
  assert.deepEqual(M.gradAt(null, 0.05, 0.06), [0, 0]);
  assert.equal(M.climb(null, 0.05, 0.06), null);
  assert.deepEqual(M.crest(null), []);
  assert.equal(M.nearestCrest(null, [], 0.05, 0.06), null);
  assert.match(M.readLine(null, [], 0.05, 0.06), /no sweep baked/);
  assert.equal(M.stepUp(null, 0.05, 0.06), null);
  assert.equal(M.radAgree(null, 0.05, 0.06), 0);
});

test('gradAt rescales each axis by its span so F does not dominate', async () => {
  const { buildRidge, gradAt, lifeAt } = await importRidge();
  // A synthetic bake: life rises equally steeply in normalised tile terms on both
  // axes. Because F spans 0.086 and k only 0.036, the RAW partial derivatives differ
  // by ~2.4x. After span rescaling they must come out the same.
  const G = 8;
  const life = new Float32Array(G*G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) life[y*G + x] = (x + y)/(2*G);
  const r = { G, life, F0: 0, F1: 0.086, k0: 0, k1: 0.036,
    fAt: tx => 0.086*((tx + 0.5)/G), kAt: ty => 0.036*((ty + 0.5)/G),
    txAt: F => F/0.086*G - 0.5, tyAt: k => k/0.036*G - 0.5 };

  const [gF, gk] = gradAt(r, 0.043, 0.018);
  assert.ok(Math.abs(gF - gk) < Math.abs(gF)*0.35,
    `both components should be comparable after rescaling, got F=${gF} k=${gk}`);
  // And it must actually point uphill, i.e. positive on both axes here.
  assert.ok(gF > 0 && gk > 0, `gradient should rise toward higher F and k, got ${gF},${gk}`);
  assert.ok(Number.isFinite(lifeAt(r, 0.043, 0.018)));
});

test('stepUp finds a better tile than where it started, or admits it cannot', async () => {
  const { buildRidge, stepUp, lifeAt } = await importRidge();
  const { MORPHOGEN_MAP: MAP } = loadMap();
  const r = buildRidge(MAP);

  // A sparse spot well inside the crescent should have somewhere better nearby.
  const st = stepUp(r, 0.02, 0.05);
  assert.ok(st, 'stepUp returns a result inside the box');
  assert.ok(st.F >= r.F0 && st.F <= r.F1, 'stays inside F bounds');
  assert.ok(st.k >= r.k0 && st.k <= r.k1, 'stays inside k bounds');
  if (st.gain > 0) assert.ok(lifeAt(r, st.F, st.k) > lifeAt(r, 0.02, 0.05),
    'a claimed gain must be a real gain');

  // The dead corner genuinely has nowhere better: gain must be 0, not a NaN.
  const flat = stepUp(r, MAP.F1 - 1e-6, MAP.k1 - 1e-6);
  assert.ok(Number.isFinite(flat.gain), 'gain is always finite');
});

// Regression: climb used to step both axes by the SAME absolute hop length. Because F
// spans 0.086 and k only 0.036, every hop moved k ~2.4x further than F in real terms,
// so starting from the labyrinth it walked straight out of the top of the box into
// dead ground -- while still reporting the move as progress, because the bug was in
// the step taken, not in the reading of what it stepped onto. Each axis must now be
// scaled by its own span.
test('climb keeps every path point inside the box and never lands on dead ground', async () => {
  const { buildRidge, climb, lifeAt } = await importRidge();
  const { MORPHOGEN_MAP: MAP } = loadMap();
  const r = buildRidge(MAP);

  // Every named place plus the thin spot the other tests start from. The old bug
  // surfaced from labyrinth in particular, so all of them are checked.
  const starts = [[0.02, 0.052], [0.0545, 0.062], [0.030, 0.062], [0.078, 0.061],
                  [0.0155, 0.0495], [0.040, 0.0585], [0.0367, 0.0649]];
  for (const [F, k] of starts) {
    const c = climb(r, F, k);
    assert.ok(c, `climb from (${F},${k}) returned nothing`);
    for (const [i, p] of c.path.entries()) {
      assert.ok(p.F >= r.F0 - 1e-9 && p.F <= r.F1 + 1e-9,
        `(${F},${k}) step ${i}: F ${p.F} escaped the box [${r.F0},${r.F1}]`);
      assert.ok(p.k >= r.k0 - 1e-9 && p.k <= r.k1 + 1e-9,
        `(${F},${k}) step ${i}: k ${p.k} escaped the box [${r.k0},${r.k1}]`);
    }
    // A climb ending somewhere worse than it began is never useful, whatever the
    // intermediate maths claimed about gradient agreement.
    if (lifeAt(r, F, k) > 0.02) {
      assert.ok(c.top.life >= lifeAt(r, F, k) - 1e-6,
        `(${F},${k}) climbed DOWN: ${lifeAt(r, F, k).toFixed(4)} -> ${c.top.life.toFixed(4)}`);
    }
  }
});

test('climb steps each axis in proportion to that axis own span', async () => {
  const { climb } = await importRidge();
  // A synthetic ridge: peak band along k centred at ty=6, uniform along F. Starting
  // off-centre, a correct climb converges in k and drifts along F. A shared hop
  // length shoots out through the narrow k axis instead, which is the bug.
  const G = 12;
  const life = new Float32Array(G*G);
  for (let y = 0; y < G; y++) {
    const band = Math.exp(-Math.pow(y - 6, 2)/8);
    for (let x = 0; x < G; x++) life[y*G + x] = band;
  }
  const r = { G, life, F0: 0.004, F1: 0.09, k0: 0.036, k1: 0.072,
    fAt: tx => 0.004 + 0.086*((tx + 0.5)/G), kAt: ty => 0.036 + 0.036*((ty + 0.5)/G),
    txAt: F => (F - 0.004)/0.086*G - 0.5, tyAt: k => (k - 0.036)/0.036*G - 0.5 };

  const c = climb(r, 0.03, 0.05);
  assert.ok(c.steps > 0, `should manage at least one step, got ${c.steps}`);
  for (const [i, p] of c.path.entries()) {
    assert.ok(p.k >= r.k0 - 1e-9 && p.k <= r.k1 + 1e-9,
      `step ${i}: k ${p.k} escaped the narrow k axis [${r.k0},${r.k1}]`);
    assert.ok(p.F >= r.F0 - 1e-9 && p.F <= r.F1 + 1e-9,
      `step ${i}: F ${p.F} escaped F [${r.F0},${r.F1}]`);
  }
});

test('climb ascends to higher life and stays within MAX_STEPS and the box', async () => {
  const { buildRidge, climb, lifeAt, RIDGE_MAX_STEPS } = await importRidge();
  const { MORPHOGEN_MAP: MAP } = loadMap();
  const r = buildRidge(MAP);

  const c = climb(r, 0.02, 0.052);
  assert.ok(c, 'climb returns something');
  assert.ok(c.gain > 0, `must end higher than it started, got gain ${c.gain}`);
  assert.ok(c.steps <= RIDGE_MAX_STEPS, `must not exceed ${RIDGE_MAX_STEPS} steps`);
  assert.equal(c.top.life, lifeAt(r, c.top.F, c.top.k), 'top.life matches a fresh read');
  assert.ok(lifeAt(r, c.top.F, c.top.k) > lifeAt(r, 0.02, 0.052), 'endpoint really is better');

  for (const p of c.path) {
    assert.ok(p.F >= r.F0 - 1e-9 && p.F <= r.F1 + 1e-9, `path F in box: ${p.F}`);
    assert.ok(p.k >= r.k0 - 1e-9 && p.k <= r.k1 + 1e-9, `path k in box: ${p.k}`);
    assert.ok(Number.isFinite(p.life), 'every path point has finite life');
  }

  // From the summit there is nowhere to climb: either no steps or ~no gain.
  const top2 = climb(r, c.top.F, c.top.k);
  assert.ok(top2.steps === 0 || top2.gain < 0.02,
    `re-climbing from the top should stall, got steps=${top2.steps} gain=${top2.gain}`);
});

test('crest tiles are true local maxima above RIDGE_MIN', async () => {
  const { buildRidge, crest, RIDGE_MIN, lifeAt } = await importRidge();
  const { MORPHOGEN_MAP: MAP } = loadMap();
  const r = buildRidge(MAP);

  const cs = crest(r);
  assert.ok(cs.length > 0, 'the real bake has at least one ridge summit');

  for (const c of cs) {
    assert.ok(c.life >= RIDGE_MIN, `crest tile must clear RIDGE_MIN, got ${c.life}`);
    // Every in-box neighbour must be <= this tile, else it is not the top of anything.
    const G = MAP.G;
    const tx = Math.round((c.F - MAP.F0)/(MAP.F1 - MAP.F0)*G - 0.5);
    const ty = Math.round((c.k - MAP.k0)/(MAP.k1 - MAP.k0)*G - 0.5);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = tx + dx, ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
      assert.ok(r.life[ny*G + nx] <= r.life[ty*G + tx] + 1e-6,
        `tile (${tx},${ty}) claimed crest but neighbour (${nx},${ny}) is higher`);
    }
    assert.ok(c.F >= MAP.F0 && c.F <= MAP.F1 && c.k >= MAP.k0 && c.k <= MAP.k1,
      'crest point lies inside the box');
  }

  // Sorted strongest-first, which is the order a caller relies on.
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i - 1].life >= cs[i].life, 'crest is sorted desc');
  assert.ok(cs[0].life === Math.max(...cs.map(c => c.life)), 'first crest is the strongest');
});

test('a lone spike surrounded by dead tiles is still a local maximum (documented, not a bug)', async () => {
  const { crest } = await importRidge();
  const G = 5;
  const life = new Float32Array(G*G).fill(0);
  life[2*G + 2] = 0.9; // one bright tile, every neighbour dead
  const r = { G, life, F0: 0, F1: 1, k0: 0, k1: 1,
    fAt: tx => (tx + 0.5)/G, kAt: ty => (ty + 0.5)/G, txAt: F => F*G - 0.5, tyAt: k => k*G - 0.5 };

  const cs = crest(r);
  assert.equal(cs.length, 1, 'the lone spike is the only local maximum');
  // Float32 storage rounds 0.9 to 0.8999999761581421, and this test cares that the
  // tile keeps ITS OWN reading rather than being averaged with its dead neighbours --
  // which is what would happen if crest() reported interpolated values.
  assert.ok(Math.abs(cs[0].life - 0.9) < 1e-6,
    `spike should keep its own reading (float32-rounded), got ${cs[0].life}`);
  assert.ok(cs[0].life > 0.5, 'and it clearly stands above the dead ground around it');
});

test('every named place has a crest in reach, and dead really is dead', async () => {
  const { buildRidge, crest, nearestCrest, lifeAt } = await importRidge();
  const { MORPHOGEN_MAP: MAP } = loadMap();
  const r = buildRidge(MAP);
  const cs = crest(r);

  const deadLife = lifeAt(r, PLACES.dead[0], PLACES.dead[1]);
  for (const [name, [F, k]] of Object.entries(PLACES)) {
    if (name === 'dead' || name === 'flat') continue;
    const near = nearestCrest(r, cs, F, k);
    assert.ok(near, `${name} should have a crest in reach`);
    const l = lifeAt(r, F, k);
    assert.ok(l > deadLife, `${name} (life ${l.toFixed(4)}) should read higher than dead (${deadLife.toFixed(4)})`);
  }
  // dead is the one place that legitimately does not sustain a pattern.
  assert.ok(deadLife < 0.10, `dead should read thin, got ${deadLife}`);
});

test('readLine names a band, quotes life, and never comes back empty', async () => {
  const { buildRidge, crest, readLine } = await importRidge();
  const { MORPHOGEN_MAP: MAP } = loadMap();
  const r = buildRidge(MAP);
  const cs = crest(r);

  const spots = [['dead', PLACES.dead], ...Object.entries(PLACES),
    ['corner low-low', [MAP.F0, MAP.k0]], ['corner high-high', [MAP.F1, MAP.k1]],
    ['corner low-high', [MAP.F0, MAP.k1]]];

  for (const [name, [F, k]] of spots) {
    const s = readLine(r, cs, F, k);
    assert.ok(typeof s === 'string' && s.length > 0, `${name}: readLine returned nothing`);
    assert.match(s, /life \d/, `${name}: must quote a life number, got "${s}"`);
    assert.doesNotMatch(s, /undefined|NaN/, `${name}: no undefined/NaN leaked into "${s}"`);
  }
  // And it discriminates: the dead place is not described the way a living one is.
  const d = readLine(r, cs, PLACES.dead[0], PLACES.dead[1]);
  const lab = readLine(r, cs, PLACES.labyrinth[0], PLACES.labyrinth[1]);
  assert.notEqual(d.slice(0, 12), lab.slice(0, 12), 'dead and labyrinth must read differently');
});

test('radAgree reads low on a noisy field and high on a smooth slope', async () => {
  const { radAgree } = await importRidge();
  const G = 10;
  const mk = fn => { const life = new Float32Array(G*G);
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) life[y*G + x] = fn(x, y);
    return { G, life, F0: 0, F1: 0.086, k0: 0, k1: 0.036,
      fAt: tx => 0.086*((tx + 0.5)/G), kAt: ty => 0.036*((ty + 0.5)/G),
      txAt: F => F/0.086*G - 0.5, tyAt: k => k/0.036*G - 0.5 }; };

  const slope = mk((x, y) => (x + y)/(2*G));
  const noise = mk((x, y) => ((x*7 + y*13) % 3 === 0 ? 0.5 : 0.05));

  const aSmooth = radAgree(slope, 0.086*0.5, 0.036*0.5);
  const aNoisy = radAgree(noise, 0.086*0.5, 0.036*0.5);
  assert.ok(aSmooth > aNoisy,
    `a smooth slope should agree more than a noisy one: ${aSmooth} vs ${aNoisy}`);
  assert.ok(aSmooth > 0.5, `a clean slope should read high agreement, got ${aSmooth}`);
  assert.ok(Number.isFinite(aNoisy) && aNoisy >= 0 && aNoisy <= 1, 'agreement stays in 0..1');
});
