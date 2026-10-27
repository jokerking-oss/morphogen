# Attribution

## Upstream

This repository is a fork of **[beeswaxpat/morphogen](https://github.com/beeswaxpat/morphogen)** —
**Morphogen II**, made by [Beeswax Pat](https://github.com/beeswaxpat) with Claude.

Everything here that is not listed under "This fork's contribution" below is the
upstream author's work, carried over unchanged:

| file | upstream author |
|---|---|
| `main.js` (the walker, the guestbook, the passage) | Beeswax Pat with Claude |
| `shaders.js` (the Gray-Scott field) | Beeswax Pat with Claude |
| `engine.js` (the WebGL layer) | Beeswax Pat with Claude |
| `map.js` (the baked 28×28 parameter sweep) | Beeswax Pat with Claude |
| `index.html`, `for-models.html`, `llms.txt`, `protocol.json` | Beeswax Pat with Claude |
| `data/feed.json`, `data/field.*` | the guestbook's visitors, CC BY 4.0 |
| `scripts/guestbook.mjs`, `scripts/field.mjs` | Beeswax Pat with Claude |

Live site: https://beeswaxpat.github.io/morphogen/

## This fork's contribution

| path | what it is | author |
|---|---|---|
| `ridge.js` | the ridgeline read from the baked sweep (new file) | this fork |
| `test/ridge.test.mjs` | the mathematics, tested in Node | this fork |
| `test/hookup.test.mjs` | structural checks on the integration | this fork |
| `test/loadmap.mjs` | loads `map.js` into Node so the tests run on the real bake | this fork |
| ~35 lines across three sites in `main.js` | build the ridge, refresh a reading in `probe()`, expose `state().ridge` | this fork |
| the "What I added" section of `README.md` | | this fork |

The `probe()`, `walk()` and `drawHUD()` functions in `main.js` are otherwise
unchanged; `PLACES`, `shaders.js` and the simulation uniforms are untouched, and
`test/hookup.test.mjs` asserts all three stay that way.

## Licences

- **Code** (everything above): MIT — see [LICENSE](LICENSE). The upstream MIT notice
  is preserved verbatim and is not to be removed.
- **Page text, the letter, and guestbook entries**: CC BY 4.0.

The MIT notice below belongs to the upstream author and must travel with any copy of
this code, fork or not:

> MIT License — Copyright (c) 2026 Beeswax Pat
