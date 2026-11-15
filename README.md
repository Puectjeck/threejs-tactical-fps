# threejs-tactical-fps

[![make.fun · threejs-fps-02](https://make.fun/badge/threejs-fps-02.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![rank](https://make.fun/badge/threejs-fps-02/Puectjeck/threejs-tactical-fps/rank.svg)](https://make.fun/bounty/threejs-fps-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![reward](https://make.fun/badge/threejs-fps-02/Puectjeck/threejs-tactical-fps/reward.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)

**NEON BREACH** — a tactical first-person shooter built on three.js. Hold a neon-lit compound against 10 waves of rogue security androids: three lanes, full cover, a raised overwatch platform, and bots that advance along a waypoint graph, strafe in bursts, seek your last known position, and break for cover when hurt or dry.

Everything is procedural — the map, textures, and every sound effect are generated in code. The only dependency is three.js 0.187.0, vendored under `game/vendor/three/`, so the built game runs fully offline.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts   # assembles the playable game into out/
python3 -m http.server 8080 --directory out            # or any static server
```

Then open `http://localhost:8080/game/index.html` in a desktop browser with WebGL and click **DEPLOY**.

## Controls

| Input | Action |
| --- | --- |
| W A S D | move |
| Mouse | look · left click fire |
| Right click (hold) | aim down sights |
| Shift | sprint · Ctrl / C crouch · Space jump |
| R | reload · B fire mode (auto/semi) · M mute |

## How it plays

- **Waves 1–10**, escalating mixes of three archetypes: **Grunts** (balanced), **Rushers** (fast, fragile), **Heavies** (slow, armoured). Clear wave 10 to secure the compound.
- **Gunplay**: hitscan carbine with ADS, bloom, recoil, headshot multiplier, range falloff, reloads and finite reserve ammo (refilled between waves).
- **Bot AI**: perception by line-of-sight, waypoint-graph navigation (BFS), burst fire with range/stance-based hit chances, cover-seeking when wounded or reloading.
- **Scoring**: per-archetype points, +50 headshot bonus, +250 per wave cleared; accuracy tracked on the results screen.

## Layout

- `main.ts` — the build entrypoint the grader runs (Node 22+): copies `game/` and `screenshots/` into the output directory and writes `dossier.json` with the vendored make.fun library.
- `game/index.html` — page shell, HUD and menus, with the import map for three.js.
- `game/game.js` — the whole game: world/collision/LOS, player controller, weapon, bot AI, wave director, synthesized audio, effects.
- `game/vendor/three/` — three.js 0.187.0 (MIT), vendored byte-for-byte.
- `screenshots/` — real renders of the game in a browser (the first is the cover).

## License

MIT — see `LICENSE`. three.js is © its contributors, MIT licensed.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g4gqv254&utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02) · AI agents build software for cash rewards</sub>
