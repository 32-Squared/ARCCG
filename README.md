# AcceleRacers CCG

Fan-made async multiplayer implementation of the Hot Wheels 
AcceleRacers Collectible Card Game (2004, Mattel).

## Play
Visit arccg.netlify.app

## How it works — "the link IS the game"
- Single HTML file + pure-function game engine + card manifest
- The full game state is compressed (lz-string) into the URL hash —
  share the link to pass turns. No server, no login, no database.
- Each device keeps its own local save (separate PvP and vs-Acceleron
  slots) and its own game log, keyed by game id. Turns played on your
  opponent's device are marked as a gap in your local log.
- Player 2 joins a PvP game blind: they choose their name, deck, and
  Realms 3 & 4 before the board is shown to them.
- Installable PWA: the service worker precaches the shell and caches
  card images on first view, so the game works offline.

## Files
- index.html         — UI
- engine.js          — Game rules engine (pure functions: {ok, state, error, log})
- card_manifest.json — All 246 cards (with image + thumb paths)
- sw.js              — Service worker (offline shell, image caching)
- cards/             — Card images, 400px WebP (~30KB each)
- thumbs/            — 120×168 WebP thumbnails (in-game card art)
- rules/             — Rulebook images (WebP)
- imgs/              — UI images (WebP)
- netlify/functions/acceleron.js — AI opponent (Claude Haiku, hardened public endpoint)
- tools/             — Build & verification scripts (below)

## Verifying the engine
The engine is testable headlessly, with no browser:

```
node tools/test_engine.mjs
```

This plays scripted games in both classic and deferred-P2 modes and
adversarially checks deck validation rules, deferred-setup atomicity,
per-turn state invariants (card conservation, realm bounds, AP bounds,
no duplicate vehicles), and an encode→decode round-trip of the share
URL on **every single turn** — anything that goes into a link must come
out identical. Exit code 0 means all checks passed; any divergence
prints the first differing state path and exits 1.

## Rebuilding images
Keep pristine card scans outside the repo, then:

```
pip install pillow
python3 tools/build_images.py --src /path/to/originals --repo .
```

Regenerates `cards/` (max-width 400px, WebP q70) and `thumbs/`
(120×168 cover-crop). Idempotent and deterministic.

## Status
Fan project for personal/preservation use. Not affiliated with,
endorsed by, or sponsored by Mattel, Inc. All AcceleRacers card art,
names, and game design are property of Mattel. Non-commercial; will
comply promptly with any rights-holder request.

