// Structural checks on the main.js hookup.
//
// These are deliberately NOT behavioural tests -- they assert that the seam exists and
// that the things the spec promised left untouched really are untouched. Behaviour of
// the maths itself lives in ridge.test.mjs, which runs it for real in Node.
//
// Why grep-based: main.js is a single 840-line IIFE with no exports. Loading it needs
// a browser (canvas, WebGL, requestAnimationFrame). Rewriting it into modules just to
// make it testable would be exactly the kind of large diff the spec forbids. So we
// assert on the shape of the hookup instead, and cover correctness in ridge.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Strip comments only.
//
// An earlier version also blanked string and template literals, which was wrong twice
// over: it destroyed the very literals these checks match on, and it left braces
// behind that broke the `[^}]*` extraction of the uniform block. Comment-stripping is
// what actually matters -- it stops prose from satisfying a regex that is meant to
// describe code.
const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

test('index.html loads ridge.js before main.js', () => {
  const html = read('index.html');
  const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
  const iRidge = scriptSrcs.findIndex(s => s.startsWith('ridge.js'));
  const iMain = scriptSrcs.findIndex(s => s.startsWith('main.js'));
  assert.ok(iRidge >= 0, 'ridge.js is referenced by index.html');
  assert.ok(iMain >= 0, 'main.js is referenced by index.html');
  assert.ok(iRidge < iMain, 'ridge.js must load before main.js uses it');
});

test('main.js builds the ridge and exposes it on state()', () => {
  const src = code(read('main.js'));
  assert.match(src, /RG\.buildRidge\(MAP\)/,
    'main.js must build the ridge from the same MAP it already loaded');
  assert.match(src, /ridgeReading/,
    'the reading must be computed somewhere accessible to probe() and drawHUD()');
  // `ridge` must live INSIDE the object state() returns, not merely somewhere in the
  // file. An earlier version of this check only looked for `ridge: {` anywhere, and
  // duly passed while the field had been added to `api` instead of to `state()` --
  // so the browser got `morphogen.ridge` and `state().ridge` was undefined. Anchor on
  // the state arrow function and require ridge to appear before its closing brace.
  const stateStart = src.indexOf('state: () => ({');
  assert.ok(stateStart > 0, 'found the state() arrow');
  const stateEnd = src.indexOf('})', stateStart);
  assert.ok(stateEnd > stateStart, 'found the end of the state() object');
  const stateBody = src.slice(stateStart, stateEnd);
  assert.match(stateBody, /ridge:\s*\{/,
    'ridge must be a property of the object state() returns');
  assert.match(stateBody, /crests:/, 'and it must carry the crest count with it');
});

test('main.js never feeds the ridge back into the simulation uniforms', () => {
  const src = code(read('main.js'));
  // The GPU uniform block is the Gray-Scott step itself. Adding a ridge term there
  // would change what grows -- which the spec rules out. Pull the block, then assert.
  const uni = src.match(/const uni = \{[^}]*\}/);
  assert.ok(uni, 'found the simulation uniform block');
  assert.doesNotMatch(uni[0], /ridge|crest|climb|lifeAt/,
    'simulation uniforms must stay exactly as upstream had them');
  assert.match(uni[0], /u_F:/, 'u_F is still there');
  assert.match(uni[0], /u_k:/, 'u_k is still there');
});

test('no shader source was modified for this feature', () => {
  const src = code(read('shaders.js'));
  assert.doesNotMatch(src, /ridge|crest|RIDGE_MIN|lifeAt/,
    'shaders.js must not know about the ridge layer at all');
});

test('the named places are untouched', () => {
  // Transcribed from upstream main.js, where each place is `{ F: x, k: y, what: ... }`.
  // If any of these ever changes that is a real decision and should be an argument,
  // not a silent drift -- so the numbers are pinned here.
  const src = code(read('main.js'));
  const expected = {
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
  for (const [name, [F, k]] of Object.entries(expected)) {
    // Match the digits wherever they appear in that place's line, so upstream's own
    // spacing (or a trailing zero added later) does not read as a change of value.
    const line = src.match(new RegExp(`${name}:\\s*\\{[^}]*\\}`));
    assert.ok(line, `found PLACES.${name}`);
    assert.match(line[0], new RegExp(`F:\\s*${String(F).replace('.', '\\.')}`),
      `PLACES.${name}.F should still be ${F}`);
    assert.match(line[0], new RegExp(`k:\\s*${String(k).replace('.', '\\.')}`),
      `PLACES.${name}.k should still be ${k}`);
  }
});

test('ridge.js never reaches for a browser global', () => {
  // It is loaded by a plain <script> in the page AND imported by Node in the tests.
  // Direct `window.` in the maths would break one of the two -- the whole reason the
  // module is written pure. The bridge at the bottom of the file is deliberate and the
  // only exception, so it is carved off here rather than allowed to blur the rule.
  const src = code(read('ridge.js'));
  // Anchor on the code, not on the comment above it: `code()` strips comments, so any
  // prose-based marker is gone by the time this runs. The guard clause is the bridge.
  const bridge = src.indexOf('typeof window');
  assert.ok(bridge > 0, 'found the bridge guard clause');
  const bridgeEnd = src.indexOf('\n}', bridge);
  assert.ok(bridgeEnd > bridge, 'found the end of the bridge block');
  const before = src.slice(0, bridge);
  const after = src.slice(bridgeEnd);
  assert.doesNotMatch(before, /\bwindow\b/, 'no window reference in the maths above the bridge');
  assert.doesNotMatch(after, /\bwindow\b/, 'no window reference after the bridge either');
  // And the bridge itself must stay a plain publish -- no reading of page state.
  const b = src.slice(bridge, bridgeEnd);
  assert.match(b, /window\.MorphogenRidge\s*=/, 'the bridge publishes the module');
  assert.doesNotMatch(b, /localStorage|location\.|requestAnimationFrame|\$\(/,
    'the bridge must not touch anything else on the page');
});

test('there is no leftover actions workflow trying to write upstream', () => {
  const wf = path.join(ROOT, '.github', 'workflows', 'guestbook.yml');
  if (!fs.existsSync(wf)) return; // already removed: criterion satisfied
  const body = fs.readFileSync(wf, 'utf8');
  // `on:` disabled by making it a manual-only trigger with zero path to secrets.
  assert.match(body, /workflow_dispatch/,
    'guestbook.yml must not run on schedule/push if it still exists');
  assert.doesNotMatch(body, /\n\s*schedule:/, 'no scheduled run against upstream');
});
