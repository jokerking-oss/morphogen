// Load map.js -- which assigns window.MORPHOGEN_MAP -- inside Node, so the ridge
// math can be tested against the real baked sweep and not a copy of it.
//
// The page loads it with a plain <script> tag, where `window` already exists. Here
// there is no window, so we supply the smallest one that lets the assignment land,
// read the source straight off disk, and run it. No build step, no dependency.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

const cache = new Map();

/**
 * Evaluate a browser-global-style module and return the globals it set.
 * `rel` is relative to the repo root, e.g. 'map.js'.
 */
export function loadGlobalScript(rel) {
  const abs = path.resolve(ROOT, rel);
  if (cache.has(abs)) return cache.get(abs);
  const src = fs.readFileSync(abs, 'utf8');
  const sandbox = { window: {}, document: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: abs });
  const out = sandbox.window;
  cache.set(abs, out);
  return out;
}

/** The real baked sweep, exactly what ships to the browser. Throws if map.js is gone. */
export function loadMap() {
  const w = loadGlobalScript('map.js');
  const map = w.MORPHOGEN_MAP;
  if (!map) throw new Error('loadMap: map.js did not set window.MORPHOGEN_MAP');
  return w;
}

/** Loads ridge.js in Node. It publishes via module.exports, so require() picks it up. */
export async function importRidge() {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const abs = path.resolve(ROOT, 'ridge.js');
  // Bust the require cache so an edit between test runs is always picked up.
  delete req.cache[abs];
  return req(abs);
}
