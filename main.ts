// main.ts — build entrypoint for "NEON BREACH", a three.js tactical FPS.
//
// The grader runs this file on Node 22+ (node22 runtime). It hands the game
// in by copying the playable files into /output and writing the dossier the
// judge reads:
//
//   game/         -> /output/game/          (index.html, game.js, vendor/three)
//   screenshots/  -> /output/screenshots/   (3 real renders of the game)
//   dossier.json  -> /output/dossier.json   (built with vendor/makefun-threejs.ts)
//
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output, so the
// build can be checked locally:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// The build is deterministic: the same committed sources always produce the
// same bytes in /output (two runs byte-identical).

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-threejs.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

mkdirSync(out, { recursive: true });
cpSync(join(here, "game"), join(out, "game"), { recursive: true });
mkdirSync(join(out, "screenshots"), { recursive: true });
if (existsSync(join(here, "screenshots"))) {
  cpSync(join(here, "screenshots"), join(out, "screenshots"), { recursive: true });
}

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes
// the bytes; the others refuse an entry the scorer would refuse (more than
// 4 screenshots or one over 256 KiB; more than 993 files in game/ or
// 48 MiB of game files, in all: game/ counts beside /output's own
// 1000-entry cap, its screenshots/ and dossier.json).
writeFileSync(
  join(out, "dossier.json"),
  buildDossier(out, { text_max_bytes: 163840, screenshots: { max: 4, max_bytes: 262144 }, game_max_files: 993, game_max_bytes: 50331648 }),
);
