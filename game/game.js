// ===========================================================================
// NEON BREACH — tactical FPS on three.js 0.187.0.
// The engine is vendored under ./vendor/three, byte for byte from the kit.
//
// Layout of this file:
//   * helpers and tuning constants
//   * procedural WebAudio effects (no sound files)
//   * the compound: colliders, waypoints, line of sight, collision
//   * player movement and the carbine
//   * hostile bots: bodies, brains, gunfire
//   * waves, scoring, HUD, menus, and the frame loop
//
// Nothing is fetched at runtime apart from three.js itself.
// ===========================================================================

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Helpers and tuning constants
// ---------------------------------------------------------------------------

export const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);
export const lerp = (from, to, mix) => from + (to - from) * mix;
export const rand = (low, high) => low + Math.random() * (high - low);
export const randPick = (list) => list[(Math.random() * list.length) | 0];
export const dist2D = (x0, z0, x1, z1) => Math.hypot(x0 - x1, z0 - z1);

export const CFG = {
  arena: 62,                 // the playable square spans [-31, 31] on x and z
  wallHeight: 4.2,
  playerRadius: 0.42,
  playerHeight: 1.8,
  crouchHeight: 1.25,
  walkSpeed: 4.6,
  sprintSpeed: 6.9,
  crouchSpeed: 2.4,
  jumpVel: 4.9,
  gravity: 13.5,
  stepUp: 0.62,              // tallest ledge the player and bots step onto freely
  maxWaves: 10,
  botRadius: 0.42,
};

// ---------------------------------------------------------------------------
// Procedural audio — every effect is synthesized, nothing is loaded.
// ---------------------------------------------------------------------------

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
  }
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  }
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }
  // A burst of filtered noise — gunfire, impacts, the thump of a landing.
  noise(dur, freq, gain, type = "lowpass", q = 0.8) {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const frames = Math.max(1, (dur * this.ctx.sampleRate) | 0);
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const flt = this.ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = freq;
    flt.Q.value = q;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(gain, now);
    out.gain.exponentialRampToValueAtTime(0.001, now + dur);
    source.connect(flt);
    flt.connect(out);
    out.connect(this.master);
    source.start(now);
  }
  // An oscillator blip whose pitch slides — UI ticks, hits, alarms.
  tone(freqA, freqB, dur, gain, type = "square") {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const voice = this.ctx.createOscillator();
    voice.type = type;
    voice.frequency.setValueAtTime(freqA, now);
    voice.frequency.exponentialRampToValueAtTime(Math.max(1, freqB), now + dur);
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(gain, now);
    out.gain.exponentialRampToValueAtTime(0.001, now + dur);
    voice.connect(out);
    out.connect(this.master);
    voice.start(now);
    voice.stop(now + dur + 0.02);
  }
  shot() {
    this.noise(0.11, 1500, 0.55);
    this.tone(160, 45, 0.09, 0.35, "sawtooth");
  }
  shotEnemy() {
    this.noise(0.1, 800, 0.22);
    this.tone(110, 50, 0.09, 0.14, "sawtooth");
  }
  dryFire() {
    this.tone(1200, 900, 0.04, 0.12);
  }
  reloadStart() {
    this.tone(500, 300, 0.06, 0.16);
  }
  reloadEnd() {
    this.tone(700, 1100, 0.06, 0.2);
    this.noise(0.05, 2500, 0.12);
  }
  hit() {
    this.tone(1900, 1500, 0.045, 0.16, "sine");
  }
  kill() {
    this.tone(880, 1320, 0.1, 0.2, "sine");
    this.noise(0.08, 3000, 0.1);
  }
  hurt() {
    this.tone(140, 70, 0.16, 0.3, "sawtooth");
    this.noise(0.12, 500, 0.2);
  }
  jump() {
    this.noise(0.06, 900, 0.06);
  }
  land() {
    this.noise(0.08, 400, 0.12);
  }
  waveStart() {
    const notes = [392, 523, 659];
    notes.forEach((f, i) =>
      setTimeout(() => this.tone(f, f, i === 2 ? 0.2 : 0.12, i === 2 ? 0.2 : 0.18, "triangle"), i * 110));
  }
  waveClear() {
    const notes = [523, 659, 784];
    notes.forEach((f, i) =>
      setTimeout(() => this.tone(f, f, i === 2 ? 0.24 : 0.12, i === 2 ? 0.2 : 0.18, "triangle"), i * 110));
  }
  defeat() {
    this.tone(330, 110, 0.7, 0.22, "sawtooth");
  }
  victory() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => setTimeout(() => this.tone(f, f, 0.22, 0.2, "triangle"), i * 130));
  }
}

// ---------------------------------------------------------------------------
// The compound — one arena, three lanes, a raised overwatch platform.
//
// Colliders are axis-aligned boxes: {minX, maxX, minZ, maxZ, top, h}.
// `top` is the walkable surface height; movement code decides whether a
// ledge is steppable or a wall from the same numbers.
// ---------------------------------------------------------------------------

export class World {
  constructor() {
    this.colliders = [];   // AABBs used for movement and cover
    this.blockers = [];    // AABBs tall enough to cut sight lines
    this.waypoints = [];   // {x, z, cover:boolean}
    this.graph = [];       // adjacency lists of waypoint indices
    this.spawnGates = [
      { x: 0, z: -28 },
      { x: -28, z: 0 },
      { x: 28, z: 0 },
      { x: 0, z: 28 },
    ];
    this._buildLayout();
    this._buildGraph();
  }

  _addBox(cx, cz, w, d, h, opts = {}) {
    const box = {
      minX: cx - w / 2, maxX: cx + w / 2,
      minZ: cz - d / 2, maxZ: cz + d / 2,
      top: h, h,
      kind: opts.kind || "crate",
      color: opts.color,
    };
    this.colliders.push(box);
    if (h >= 1.5) this.blockers.push(box); // tall enough to hide a standing bot
    return box;
  }

  _buildLayout() {
    const half = CFG.arena / 2; // 31
    const wallH = CFG.wallHeight;
    // Perimeter walls, built from a table so the four sides stay symmetric.
    const walls = [
      [0, -half - 0.5, CFG.arena + 2, 1],
      [0, half + 0.5, CFG.arena + 2, 1],
      [-half - 0.5, 0, 1, CFG.arena + 2],
      [half + 0.5, 0, 1, CFG.arena + 2],
    ];
    for (const [x, z, w, d] of walls) this._addBox(x, z, w, d, wallH, { kind: "wall" });

    // Central overwatch platform (top 1.8) with two stair runs of 0.6 steps.
    this._addBox(0, 0, 8, 8, 1.8, { kind: "platform" });
    this._addSteps();

    // Lane dividers: two long walls with a centre gap, splitting 3 lanes.
    for (const sx of [-13, 13]) {
      this._addBox(sx, -13.5, 1.6, 15, 2.6, { kind: "wall" });
      this._addBox(sx, 13.5, 1.6, 15, 2.6, { kind: "wall" });
    }
    // Cross walls that force S-routes in the outer lanes (kept clear of
    // the corner waypoint pockets so the nav graph stays connected).
    this._addBox(-24, 2, 8, 1.6, 2.6, { kind: "wall" });
    this._addBox(24, -2, 8, 1.6, 2.6, { kind: "wall" });

    // Cover crates (1.1 high: block crouched sight, not standing) and
    // tall containers (2.4: full cover), scattered tactically.
    const crateSpots = [
      [-6, -12], [6, -12],
      [-6, 12], [6, 12],
      [-19, -14], [19, 14],
      [-19, 16], [19, -16],
      [-24, -4], [24, 4],
      [-8, -22], [8, 22],
      [-16, 20], [16, -20],
      [0, -18], [0, 18],
    ];
    for (const [x, z] of crateSpots) this._addBox(x, z, 2.2, 2.2, 1.1, { kind: "crate" });
    const containerSpots = [
      [-24, -20], [24, 20],
      [-24, 22], [24, -22],
      [-9, -26], [9, 26],
    ];
    for (const [x, z] of containerSpots) this._addBox(x, z, 5.5, 2.4, 2.4, { kind: "container" });
    // Low barriers near the player spawn (south) and the north gate.
    const barriers = [
      [-4, 24], [4, 24],
      [-4, -24], [4, -24],
    ];
    for (const [x, z] of barriers) this._addBox(x, z, 4.5, 1.1, 0.9, { kind: "barrier" });

    // Waypoints: lane junctions + spots beside cover. Bots navigate on this
    // graph; `cover` marks points tucked against a tall obstacle.
    const points = [
      [0, 26],
      [-10, 24],
      [10, 24],
      [-21, 25],
      [21, 25],
      [0, 14],
      [-10, 10],
      [10, 10],
      [-22, 8],
      [22, 8],
      [-6, 0],
      [6, 0],
      [-19, -4],
      [19, 4],
      [0, -8],
      [0, -14],
      [-10, -10],
      [10, -10],
      [-22, -8],
      [22, -8],
      [0, -26],
      [-10, -24],
      [10, -24],
      [-21, -25],
      [21, -25],
      [-26, 14],
      [26, -14],
      [-26, -16],
      [26, 16],
      [-13, 0],
      [13, 0],
      [0, 7],
      [-19, 0],
      [19, 0],
    ];
    this.waypoints = points.map(([x, z]) => ({ x, z, cover: false }));
  }

  _addSteps() {
    // West stairs up to the platform (platform spans x in [-4,4], z in [-4,4]).
    for (let step = 0; step < 3; step++) {
      const rise = 0.6 * (step + 1);
      this._addBox(-6.4 + step * 1.2, 0, 1.2, 3.2, rise, { kind: "step" });
    }
    // East stairs down the other side.
    for (let step = 0; step < 3; step++) {
      const rise = 0.6 * (step + 1);
      this._addBox(6.4 - step * 1.2, 0, 1.2, 3.2, rise, { kind: "step" });
    }
  }

  _buildGraph() {
    const n = this.waypoints.length;
    this.graph = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const p = this.waypoints[i], q = this.waypoints[j];
        const gap = dist2D(p.x, p.z, q.x, q.z);
        if (gap > 17) continue;
        if (this._segmentBlocked(p.x, p.z, q.x, q.z, CFG.botRadius + 0.1)) continue;
        this.graph[i].push(j);
        this.graph[j].push(i);
      }
    }
    // Mark cover: a waypoint is cover if it sits within 2.2m of a blocker.
    for (const point of this.waypoints) {
      point.cover = this.blockers.some((box) =>
        point.x > box.minX - 2.2 && point.x < box.maxX + 2.2 &&
        point.z > box.minZ - 2.2 && point.z < box.maxZ + 2.2);
    }
  }

  // Is the straight ground path between two points blocked? Used for graph
  // building. Tall obstacles block with a body-radius margin; low cover
  // (crates, barriers) blocks only a path through its actual footprint —
  // a bot whose route grazes one simply slides along it via collision.
  _segmentBlocked(ax, az, bx, bz, pad) {
    for (const box of this.colliders) {
      if (box.h <= CFG.stepUp) continue; // steps are walkable
      const margin = box.h >= 1.5 ? pad : 0;
      if (segmentHitsBox(ax, az, bx, bz, box.minX - margin, box.minZ - margin, box.maxX + margin, box.maxZ + margin)) return true;
    }
    return false;
  }

  // 3D line of sight between two eye points: blocked by any tall collider.
  losBlocked(x0, y0, z0, x1, y1, z1) {
    for (const box of this.blockers) {
      if (segmentHitsBox3D(x0, y0, z0, x1, y1, z1, box)) return true;
    }
    return false;
  }

  // Highest walkable surface at (x, z) whose top is reachable from feetY.
  groundAt(x, z, feetY) {
    let best = 0;
    for (const box of this.colliders) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (box.top <= feetY + CFG.stepUp && box.top > best) best = box.top;
    }
    return best;
  }

  // Push a circle (x, z, radius r) out of every collider it overlaps.
  // Returns the corrected [x, z]. Vertical span [feetY, feetY+height] must
  // overlap the box's [0, top] for a collision to count.
  collideCircle(x, z, r, feetY, height) {
    for (const box of this.colliders) {
      if (feetY + height <= 0.05 || feetY >= box.top - 0.02) continue; // above/below
      // Steppable ledges (stairs, low steps) never block horizontally:
      // groundAt() lifts the mover onto them instead.
      if (box.top > feetY && box.top - feetY <= CFG.stepUp) continue;
      const nearX = clamp(x, box.minX, box.maxX);
      const nearZ = clamp(z, box.minZ, box.maxZ);
      const ox = x - nearX, oz = z - nearZ;
      const d2 = ox * ox + oz * oz;
      if (d2 > r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        x = nearX + (ox / d) * r;
        z = nearZ + (oz / d) * r;
      } else {
        // Centre inside the box: push out along the smallest penetration.
        const penL = x - box.minX, penR = box.maxX - x;
        const penT = z - box.minZ, penB = box.maxZ - z;
        const least = Math.min(penL, penR, penT, penB);
        if (least === penL) x = box.minX - r;
        else if (least === penR) x = box.maxX + r;
        else if (least === penT) z = box.minZ - r;
        else z = box.maxZ + r;
      }
    }
    const edge = CFG.arena / 2 - 0.6;
    return [clamp(x, -edge, edge), clamp(z, -edge, edge)];
  }

  // BFS shortest path over the waypoint graph. Returns waypoint indices.
  findPath(sx, sz, tx, tz) {
    const n = this.waypoints.length;
    const closest = (x, z) => {
      let pick = -1, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const gap = dist2D(x, z, this.waypoints[i].x, this.waypoints[i].z);
        if (gap < bestD) { bestD = gap; pick = i; }
      }
      return pick;
    };
    const start = closest(sx, sz), goal = closest(tx, tz);
    if (start === goal) return [goal];
    const cameFrom = new Array(n).fill(-1);
    const visited = new Array(n).fill(false);
    const frontier = [start];
    visited[start] = true;
    while (frontier.length) {
      const node = frontier.shift();
      if (node === goal) break;
      for (const next of this.graph[node]) {
        if (!visited[next]) { visited[next] = true; cameFrom[next] = node; frontier.push(next); }
      }
    }
    if (!visited[goal]) return [goal];
    const route = [];
    for (let node = goal; node !== -1; node = cameFrom[node]) route.push(node);
    return route.reverse();
  }

  nearestCoverIndex(x, z, threatX, threatZ, eyeY) {
    let pick = -1, bestD = Infinity;
    for (let i = 0; i < this.waypoints.length; i++) {
      const point = this.waypoints[i];
      if (!point.cover) continue;
      // Cover only counts if the threat cannot see the point.
      if (!this.losBlocked(point.x, eyeY, point.z, threatX, eyeY, threatZ)) continue;
      const gap = dist2D(x, z, point.x, point.z);
      if (gap < bestD) { bestD = gap; pick = i; }
    }
    return pick;
  }
}

// 2D segment vs AABB (slab method).
export function segmentHitsBox(ax, az, bx, bz, minX, minZ, maxX, maxZ) {
  // Clip the [0, 1] parameter range against one axis slab; null = miss.
  const clip = (p, d, mn, mx) => {
    if (Math.abs(d) < 1e-9) return p < mn || p > mx ? null : [0, 1];
    let enter = (mn - p) / d, exit = (mx - p) / d;
    if (enter > exit) [enter, exit] = [exit, enter];
    return [enter, exit];
  };
  let lo = 0, hi = 1;
  const spans = [clip(ax, bx - ax, minX, maxX), clip(az, bz - az, minZ, maxZ)];
  for (const span of spans) {
    if (span === null) return false;
    lo = Math.max(lo, span[0]);
    hi = Math.min(hi, span[1]);
    if (lo > hi) return false;
  }
  return true;
}

// 3D segment vs a collider box (x/z slab + y range check at entry span).
export function segmentHitsBox3D(x0, y0, z0, x1, y1, z1, box) {
  const runX = x1 - x0, runY = y1 - y0, runZ = z1 - z0;
  let lo = 0, hi = 1;
  const slabs = [
    [x0, runX, box.minX, box.maxX],
    [z0, runZ, box.minZ, box.maxZ],
  ];
  for (const [p, d, mn, mx] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (p < mn || p > mx) return false;
      continue;
    }
    let enter = (mn - p) / d, exit = (mx - p) / d;
    if (enter > exit) [enter, exit] = [exit, enter];
    lo = Math.max(lo, enter);
    hi = Math.min(hi, exit);
    if (lo > hi) return false;
  }
  // The y at the overlapping span must dip below the box top somewhere.
  const yStart = y0 + runY * lo, yEnd = y0 + runY * hi;
  return Math.min(yStart, yEnd) < box.top;
}

// ---------------------------------------------------------------------------
// Scene construction — all visuals are procedural (canvas textures + boxes).
// ---------------------------------------------------------------------------

function makeCanvas(size, painter) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  painter(canvas.getContext("2d"), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function groundTexture() {
  return makeCanvas(512, (ctx, size) => {
    ctx.fillStyle = "#232830";
    ctx.fillRect(0, 0, size, size);
    for (let n = 0; n < 2600; n++) {
      ctx.fillStyle = `rgba(${140 + Math.random() * 60},${150 + Math.random() * 60},${170 + Math.random() * 60},${Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
    ctx.strokeStyle = "rgba(160,180,200,0.20)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
    ctx.strokeStyle = "rgba(255,176,46,0.10)";
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
    ctx.stroke();
  });
}

function crateTexture() {
  return makeCanvas(256, (ctx, size) => {
    ctx.fillStyle = "#8a6b42";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#75582f";
    for (let y = 0; y < size; y += 64) ctx.fillRect(0, y, size, 5);
    ctx.strokeStyle = "rgba(40,26,10,0.65)";
    ctx.lineWidth = 10;
    ctx.strokeRect(0, 0, size, size);
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(size, size);
    ctx.moveTo(size, 0); ctx.lineTo(0, size);
    ctx.stroke();
    ctx.fillStyle = "rgba(20,14,6,0.55)";
    ctx.font = "bold 34px monospace";
    ctx.textAlign = "center";
    ctx.fillText("VK-7", size / 2, size / 2 + 12);
  });
}

function hazardTexture() {
  return makeCanvas(256, (ctx, size) => {
    ctx.fillStyle = "#c9a227";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#15161a";
    for (let col = -size; col < size * 2; col += 44) {
      ctx.beginPath();
      ctx.moveTo(col, size);
      ctx.lineTo(col + 22, size);
      ctx.lineTo(col + 22 + size, 0);
      ctx.lineTo(col + size, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fillRect(0, 0, size, 26);
  });
}

export function buildScene(world) {
  const renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById("game-canvas"),
    antialias: true, powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1622);
  scene.fog = new THREE.Fog(0x0d1622, 55, 130);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 300);

  const sky = new THREE.HemisphereLight(0x8fb8dd, 0x1c1710, 0.85);
  scene.add(sky);
  const key = new THREE.DirectionalLight(0xffe3b3, 2.6);
  key.position.set(28, 42, 18);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -40;
  key.shadow.camera.right = 40;
  key.shadow.camera.top = 40;
  key.shadow.camera.bottom = -40;
  key.shadow.camera.far = 120;
  key.shadow.bias = -0.0006;
  scene.add(key);
  // A cool fill light from the opposite corner (no shadows, cheap).
  const fill = new THREE.DirectionalLight(0x4a7dbb, 0.7);
  fill.position.set(-30, 20, -25);
  scene.add(fill);

  // Ground: arena slab plus an outer apron.
  const groundTex = groundTexture();
  groundTex.repeat.set(10, 10);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.arena + 4, CFG.arena + 4),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.94, metalness: 0.04 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const outer = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: 0x11151c, roughness: 1 })
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.05;
  scene.add(outer);

  // Distant skyline silhouettes for depth.
  const skyMat = new THREE.MeshBasicMaterial({ color: 0x131e2c });
  const skyGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < 42; i++) {
    const angle = (i / 42) * Math.PI * 2 + rand(-0.05, 0.05);
    const radius = rand(58, 84);
    const tower = new THREE.Mesh(skyGeo, skyMat);
    tower.position.set(Math.cos(angle) * radius, rand(4, 13), Math.sin(angle) * radius);
    tower.scale.set(rand(6, 14), rand(10, 30), rand(6, 14));
    scene.add(tower);
  }

  // Collider meshes.
  const crateTex = crateTexture();
  const hazardTex = hazardTexture();
  const mats = {
    wall: new THREE.MeshStandardMaterial({
      color: 0x707b89, roughness: 0.95,
    }),
    platform: new THREE.MeshStandardMaterial({
      color: 0x4d5866, roughness: 0.85, metalness: 0.15,
    }),
    step: new THREE.MeshStandardMaterial({
      color: 0x87909c, roughness: 0.95,
    }),
    crate: new THREE.MeshStandardMaterial({
      map: crateTex, roughness: 0.9,
    }),
    barrier: new THREE.MeshStandardMaterial({
      map: hazardTex, roughness: 0.85,
    }),
    container: [
      new THREE.MeshStandardMaterial({
        color: 0x9c5a28, roughness: 0.8, metalness: 0.25,
      }),
      new THREE.MeshStandardMaterial({
        color: 0x2e6b8a, roughness: 0.8, metalness: 0.25,
      }),
      new THREE.MeshStandardMaterial({
        color: 0x5f7a33, roughness: 0.8, metalness: 0.25,
      }),
    ],
  };
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const worldMeshes = [];
  let containerIdx = 0;
  for (const box of world.colliders) {
    let mat = mats[box.kind] || mats.wall;
    if (box.kind === "container") mat = mats.container[containerIdx++ % mats.container.length];
    const mesh = new THREE.Mesh(unitBox, mat);
    mesh.position.set((box.minX + box.maxX) / 2, box.top / 2, (box.minZ + box.maxZ) / 2);
    mesh.scale.set(box.maxX - box.minX, box.top, box.maxZ - box.minZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.collider = box;
    scene.add(mesh);
    worldMeshes.push(mesh);
    // Neon trim on the overwatch platform rim.
    if (box.kind === "platform") {
      const trim = new THREE.Mesh(
        new THREE.BoxGeometry(box.maxX - box.minX + 0.15, 0.09, box.maxZ - box.minZ + 0.15),
        new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffb02e, emissiveIntensity: 1.6 })
      );
      trim.position.set(mesh.position.x, box.top - 0.05, mesh.position.z);
      scene.add(trim);
    }
  }

  window.addEventListener("resize", () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  return { renderer, scene, camera, worldMeshes };
}

// ---------------------------------------------------------------------------
// Effects: pooled spark particles plus pooled tracers. Nothing allocates
// per shot, so a firefight never GC-stutters.
// ---------------------------------------------------------------------------

export class Fx {
  constructor(scene) {
    this.scene = scene;
    const COUNT = 360;
    this.pN = COUNT;
    this.pPos = new Float32Array(COUNT * 3);
    this.pVel = new Float32Array(COUNT * 3);
    this.pLife = new Float32Array(COUNT);
    this.pHead = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffc46b, size: 0.09, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let i = 0; i < COUNT; i++) this.pPos[i * 3 + 1] = -50;

    this.tracers = [];
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    for (let i = 0; i < 28; i++) {
      const beam = new THREE.Line(lineGeo.clone(), new THREE.LineBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      beam.frustumCulled = false;
      beam.visible = false;
      scene.add(beam);
      this.tracers.push({ line: beam, life: 0 });
    }
    this.tHead = 0;
  }

  burst(pos, count = 8, spread = 3.2, lift = 1.6) {
    for (let k = 0; k < count; k++) {
      const slot = this.pHead;
      this.pHead = (this.pHead + 1) % this.pN;
      this.pPos[slot * 3] = pos.x;
      this.pPos[slot * 3 + 1] = pos.y;
      this.pPos[slot * 3 + 2] = pos.z;
      this.pVel[slot * 3] = rand(-spread, spread);
      this.pVel[slot * 3 + 1] = rand(0, lift);
      this.pVel[slot * 3 + 2] = rand(-spread, spread);
      this.pLife[slot] = rand(0.18, 0.42);
    }
  }

  tracer(start, end, hue = 0xffd9a0) {
    const tr = this.tracers[this.tHead];
    this.tHead = (this.tHead + 1) % this.tracers.length;
    const posAttr = tr.line.geometry.getAttribute("position");
    posAttr.setXYZ(0, start.x, start.y, start.z);
    posAttr.setXYZ(1, end.x, end.y, end.z);
    posAttr.needsUpdate = true;
    tr.line.material.color.setHex(hue);
    tr.line.material.opacity = 0.85;
    tr.line.visible = true;
    tr.life = 0.07;
  }

  update(step) {
    for (let i = 0; i < this.pN; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= step;
      if (this.pLife[i] <= 0) {
        this.pPos[i * 3 + 1] = -50;
        continue;
      }
      this.pVel[i * 3 + 1] -= 7.5 * step;
      this.pPos[i * 3] += this.pVel[i * 3] * step;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * step;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * step;
    }
    this.points.geometry.getAttribute("position").needsUpdate = true;
    for (const tr of this.tracers) {
      if (tr.life <= 0) continue;
      tr.life -= step;
      tr.line.material.opacity = Math.max(0, tr.life / 0.07) * 0.85;
      if (tr.life <= 0) tr.line.visible = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Player: first-person controller with stance, sprint, jump, head-bob.
// ---------------------------------------------------------------------------

export class Player {
  constructor(world, spawn) {
    this.world = world;
    // Feet position; y is the ground height under the player.
    this.pos = new THREE.Vector3(spawn.x, 0, spawn.z);
    this.vy = 0;
    // Yaw 0 faces -Z: north, into the arena from the south spawn.
    this.yaw = 0;
    this.pitch = 0;
    this.hp = 100;
    this.maxHp = 100;
    this.dead = false;
    // 0 standing, 1 crouched (smoothed toward the target each frame).
    this.crouchAmt = 0;
    // Recovering camera kick from the last shots.
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.bobPhase = 0;
    this.bobAmt = 0;
    this.onGround = true;
    this.lastHurtAt = -99;
    this.regenDelay = 4.5;
  }

  forward() {
    // Yaw 0 looks down -Z; turning right decreases the yaw.
    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    return { x: fwdX, z: fwdZ };
  }

  eyeHeight() {
    const stance = lerp(CFG.playerHeight, CFG.crouchHeight, this.crouchAmt);
    return stance - 0.12;
  }
  eyePos(dest) {
    dest.copy(this.pos);
    dest.y += this.eyeHeight() + Math.sin(this.bobPhase * 2) * 0.018 * this.bobAmt;
    return dest;
  }

  update(step, keys, t) {
    if (this.dead) return;
    const crouchGoal = keys.crouch ? 1 : 0;
    this.crouchAmt = lerp(this.crouchAmt, crouchGoal, 1 - Math.pow(0.0001, step));
    const isSprinting = keys.sprint && keys.forward && !keys.crouch && this.crouchAmt < 0.4;
    this.sprinting = isSprinting;

    let pace = CFG.walkSpeed;
    if (isSprinting) pace = CFG.sprintSpeed;
    else if (this.crouchAmt > 0.5) pace = CFG.crouchSpeed;
    if (keys.ads) pace *= 0.55;

    const fwd = this.forward();
    const right = { x: -fwd.z, z: fwd.x }; // right vector
    let moveX = 0, moveZ = 0;
    if (keys.forward) { moveX += fwd.x; moveZ += fwd.z; }
    if (keys.back) { moveX -= fwd.x; moveZ -= fwd.z; }
    if (keys.right) { moveX += right.x; moveZ += right.z; }
    if (keys.left) { moveX -= right.x; moveZ -= right.z; }
    const moveLen = Math.hypot(moveX, moveZ);
    if (moveLen > 0.01) { moveX /= moveLen; moveZ /= moveLen; }

    const wasInAir = !this.onGround;
    this.pos.x += moveX * pace * step;
    this.pos.z += moveZ * pace * step;
    const stanceH = lerp(CFG.playerHeight, CFG.crouchHeight, this.crouchAmt);
    const [fixedX, fixedZ] = this.world.collideCircle(this.pos.x, this.pos.z, CFG.playerRadius, this.pos.y, stanceH);
    this.pos.x = fixedX;
    this.pos.z = fixedZ;

    // Vertical: gravity plus ground snap (groundAt handles step-ups).
    this.vy -= CFG.gravity * step;
    this.pos.y += this.vy * step;
    const floorY = this.world.groundAt(this.pos.x, this.pos.z, this.pos.y - this.vy * step);
    if (this.pos.y <= floorY) {
      if (wasInAir && this.vy < -3.4) this.landedHard = true;
      this.pos.y = floorY;
      this.vy = 0;
      this.onGround = true;
    } else if (this.pos.y > floorY + 0.02) {
      this.onGround = false;
    }
    if (keys.jump && this.onGround) {
      this.vy = CFG.jumpVel;
      this.onGround = false;
      this.jumped = true;
    }

    // Head-bob while moving on the ground.
    const isMoving = moveLen > 0.01 && this.onGround;
    this.bobAmt = lerp(this.bobAmt, isMoving ? 1 : 0, 1 - Math.pow(0.001, step));
    if (isMoving) this.bobPhase += step * (isSprinting ? 11 : 8.4);

    // Recoil recovery.
    const decay = Math.pow(0.0015, step);
    this.recoilPitch *= decay;
    this.recoilYaw *= decay;

    // Health regen after a quiet spell — tactical, not instant.
    if (t - this.lastHurtAt > this.regenDelay && this.hp > 0) {
      this.hp = Math.min(this.maxHp, this.hp + 9 * step);
    }
  }

  damage(dmg, t) {
    if (this.dead) return;
    this.hp -= dmg;
    this.lastHurtAt = t;
    if (this.hp <= 0) { this.hp = 0; this.dead = true; }
  }

  heal(points) {
    this.hp = Math.min(this.maxHp, this.hp + points);
  }
}

// ---------------------------------------------------------------------------
// Weapon: VK-7 carbine. Hitscan, ADS, bloom, recoil, reload, fire modes.
// The Game wires `onShot(result)` for sound and HUD; raycasting happens here.
// ---------------------------------------------------------------------------

export class Weapon {
  constructor(camera, sfx) {
    this.sfx = sfx;
    // Ballistics: 34 body damage, 2.3x on a headshot, 620 rounds per minute.
    this.damage = 34;
    this.headMult = 2.3;
    this.interval = 60 / 620;
    this.magSize = 30;
    this.mag = this.magSize;
    this.reserve = 150;
    this.reloadTime = 1.55;
    this.range = 160;
    this.mode = "AUTO"; // or "SEMI"
    this.lastShotAt = -9;
    this.reloadingUntil = -1;
    // Extra spread from sustained fire.
    this.bloom = 0;
    this.adsAmt = 0;
    this.triggerHeld = false;
    this.semiLatch = false;
    this.shotsFired = 0;
    this.shotsHit = 0;

    // View model: chunky low-poly carbine parented to the camera.
    this.group = new THREE.Group();
    const gunmetal = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.55, metalness: 0.55 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffb02e, emissiveIntensity: 1.2 });
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.11, 0.52), gunmetal);
    receiver.position.set(0, 0, -0.1);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.3, 10), gunmetal);
    tube.rotation.x = Math.PI / 2;
    tube.position.set(0, 0.018, -0.48);
    const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.09), gunmetal);
    magazine.position.set(0, -0.12, -0.08);
    magazine.rotation.x = 0.18;
    const optic = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), gunmetal);
    optic.position.set(0, 0.085, -0.16);
    const glowStrip = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.014, 0.3), trim);
    glowStrip.position.set(0, -0.03, -0.12);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.018, -0.65);
    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    this.flash.position.copy(this.muzzle.position);
    this.flashLight = new THREE.PointLight(0xffb45e, 0, 9);
    this.flashLight.position.copy(this.muzzle.position);
    this.group.add(receiver, tube, magazine, optic, glowStrip, this.muzzle, this.flash, this.flashLight);
    this.group.position.set(0.26, -0.235, -0.45);
    camera.add(this.group);
    this.flashUntil = -1;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = this.range;
  }

  get reloading() { return performance.now() / 1000 < this.reloadingUntil; }

  startReload(now) {
    const busy = this.reloading;
    const full = this.mag >= this.magSize;
    const dry = this.reserve <= 0;
    if (busy || full || dry) return false;
    this.reloadingUntil = now + this.reloadTime;
    this.sfx.reloadStart();
    return true;
  }

  finishReload(now) {
    if (this.reloadingUntil < 0 || now < this.reloadingUntil) return;
    const missing = this.magSize - this.mag;
    const load = Math.min(missing, this.reserve);
    this.mag += load;
    this.reserve -= load;
    this.reloadingUntil = -1;
    this.sfx.reloadEnd();
  }

  refill() {
    this.reserve = 150;
    if (this.mag === 0) this.mag = this.magSize;
  }

  // Attempt to fire. Returns a hit descriptor or null when no shot happened.
  // targets: array of meshes (bot hit-meshes carry userData.bot/part).
  tryFire(now, camera, worldMeshes, targets, player) {
    if (this.reloading) return null;
    if (now - this.lastShotAt < this.interval) return null;
    if (this.mode === "SEMI" && this.semiLatch) return null;
    if (this.mag <= 0) {
      this.sfx.dryFire();
      this.lastShotAt = now;
      this.startReload(now);
      return { dry: true };
    }
    this.lastShotAt = now;
    this.semiLatch = true;
    this.mag -= 1;
    this.shotsFired += 1;
    this.sfx.shot();

    // Spread: base by stance and ADS, plus bloom from sustained fire,
    // plus a penalty for firing while airborne and moving.
    const airSpread = player && Math.abs(player.bobAmt) > 0.4 && !player.onGround ? 0.006 : 0;
    const baseSpread = lerp(0.0115, 0.0016, this.adsAmt);
    const totalSpread = baseSpread + this.bloom * 0.012 + airSpread;
    this.bloom = Math.min(1, this.bloom + 0.14);

    const shotDir = new THREE.Vector3();
    camera.getWorldDirection(shotDir);
    shotDir.x += rand(-totalSpread, totalSpread);
    shotDir.y += rand(-totalSpread, totalSpread);
    shotDir.z += rand(-totalSpread, totalSpread);
    shotDir.normalize();
    const eye = new THREE.Vector3();
    camera.getWorldPosition(eye);
    this.raycaster.set(eye, shotDir);
    this.raycaster.far = this.range;

    const struck = this.raycaster.intersectObjects(targets.concat(worldMeshes), false);
    const muzzlePos = new THREE.Vector3();
    this.muzzle.getWorldPosition(muzzlePos);
    this.flashUntil = now + 0.045;
    this.flash.material.opacity = 0.95;
    this.flash.rotation.z = rand(0, Math.PI);
    this.flash.scale.setScalar(rand(0.8, 1.35));
    this.flashLight.intensity = 14;

    if (player) {
      player.recoilPitch += lerp(0.0125, 0.0075, this.adsAmt) * (1 + this.bloom * 0.5);
      player.recoilYaw += rand(-0.0022, 0.0022);
    }
    if (struck.length === 0) {
      return { point: eye.clone().add(shotDir.multiplyScalar(this.range)), muzzleWorld: muzzlePos };
    }
    const hit = struck[0];
    const data = hit.object.userData;
    return {
      point: hit.point, distance: hit.distance, muzzleWorld: muzzlePos,
      bot: data.bot || null, part: data.part || null,
    };
  }

  update(step, t, keys, owner) {
    this.finishReload(t);
    this.bloom = Math.max(0, this.bloom - step * 2.6);
    const adsGoal = keys.ads && !owner.sprinting && !this.reloading ? 1 : 0;
    this.adsAmt = lerp(this.adsAmt, adsGoal, 1 - Math.pow(0.00005, step));
    if (!keys.trigger) this.semiLatch = false;
    // View model placement: hip to ADS (sight centred), lowered on sprint.
    const hipPos = { x: 0.26, y: -0.235, z: -0.45 };
    const adsPos = { x: 0, y: -0.148, z: -0.38 };
    let px = lerp(hipPos.x, adsPos.x, this.adsAmt);
    let py = lerp(hipPos.y, adsPos.y, this.adsAmt);
    let pz = lerp(hipPos.z, adsPos.z, this.adsAmt);
    if (owner.sprinting) {
      py -= 0.06;
      this.group.rotation.z = 0.35;
    } else {
      this.group.rotation.z = lerp(this.group.rotation.z, 0, 1 - Math.pow(0.0001, step));
    }
    if (this.reloading) {
      const progress = Math.min(1, (this.reloadTime - (this.reloadingUntil - t)) / this.reloadTime);
      this.group.rotation.x = -0.55 * Math.sin(progress * Math.PI);
    } else {
      this.group.rotation.x = 0;
    }
    // Subtle sway from look velocity and bob.
    this.group.position.set(
      px + Math.sin(owner.bobPhase) * 0.006 * owner.bobAmt,
      py + Math.abs(Math.sin(owner.bobPhase)) * 0.005 * owner.bobAmt,
      pz
    );
    if (t > this.flashUntil) {
      this.flash.material.opacity = 0;
      this.flashLight.intensity = 0;
    }
  }

  spreadPx() {
    // Crosshair spread in CSS pixels for the current bloom and ADS state.
    return 6 + (1 - this.adsAmt) * 8 + this.bloom * 16;
  }
}

// ---------------------------------------------------------------------------
// Hostile bots — rogue security androids. Three archetypes, one state
// machine: ADVANCE along the waypoint graph, ENGAGE with strafing bursts
// on sight, SEEK the last known position, drop to COVER when hurt or dry.
// ---------------------------------------------------------------------------

export const ARCHETYPES = {
  grunt: { hp: 100, damage: 8, speed: 3.15, score: 100, scale: 1.0, color: 0xb3402e },
  rusher: { hp: 60, damage: 6, speed: 4.7, score: 125, scale: 0.94, color: 0xc77b29 },
  heavy: { hp: 260, damage: 12, speed: 2.15, score: 250, scale: 1.28, color: 0x74303c },
};

const botGeos = {
  torso: new THREE.BoxGeometry(0.62, 0.78, 0.34),
  head: new THREE.BoxGeometry(0.34, 0.34, 0.34),
  leg: new THREE.BoxGeometry(0.22, 0.82, 0.25),
  gun: new THREE.BoxGeometry(0.09, 0.13, 0.78),
  visor: new THREE.BoxGeometry(0.3, 0.07, 0.02),
  barBg: new THREE.PlaneGeometry(0.92, 0.12),
  barFg: new THREE.PlaneGeometry(0.88, 0.085),
};

export class Bot {
  constructor(world, scene, kind, x, z) {
    const spec = ARCHETYPES[kind];
    // Identity.
    this.world = world;
    this.kind = kind;
    this.spec = spec;
    // Health.
    this.hp = spec.hp;
    this.maxHp = spec.hp;
    // Position and facing.
    this.pos = new THREE.Vector3(x, 0, z);
    this.yaw = rand(0, Math.PI * 2);
    // State machine.
    this.state = "advance";
    this.dead = false;
    this.deathT = 0;
    // Pathfinding.
    this.path = [];
    this.pathI = 0;
    this.repathAt = 0;
    // Perception.
    this.perceiveAt = rand(0, 0.15);
    this.seesPlayer = false;
    this.lastKnown = null;
    this.lastSeenAt = -99;
    // Fire control.
    this.burstLeft = 0;
    this.nextShotAt = 0;
    this.burstPauseUntil = 0;
    this.shotsInMag = 12;
    this.reloadUntil = -1;
    // Movement and presentation.
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeFlipAt = 0;
    this.coverUntil = 0;
    this.flashUntil = -1;
    this.walkPhase = rand(0, 6);

    // --- mesh ---
    const scale = spec.scale;
    this.group = new THREE.Group();
    const armor = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.6, metalness: 0.3 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1d2126, roughness: 0.5, metalness: 0.5 });
    this.suitMat = armor;
    const body = new THREE.Mesh(botGeos.torso, armor);
    body.position.y = 1.2;
    const skull = new THREE.Mesh(botGeos.head, trim);
    skull.position.y = 1.76;
    const eye = new THREE.Mesh(botGeos.visor, new THREE.MeshStandardMaterial({
      color: 0x061014, emissive: 0x53e9ff, emissiveIntensity: 2.2,
    }));
    eye.position.set(0, 1.78, -0.18);
    const shinL = new THREE.Mesh(botGeos.leg, trim);
    shinL.position.set(-0.16, 0.41, 0);
    const shinR = new THREE.Mesh(botGeos.leg, trim);
    shinR.position.set(0.16, 0.41, 0);
    this.legL = shinL;
    this.legR = shinR;
    const rifle = new THREE.Mesh(botGeos.gun, trim);
    rifle.position.set(0.3, 1.28, -0.3);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0.3, 1.3, -0.72);
    this.group.add(body, skull, eye, shinL, shinR, rifle, this.muzzle);
    this.group.scale.setScalar(scale);
    for (const part of [body, skull, shinL, shinR, rifle]) part.castShadow = true;
    body.userData = { bot: this, part: "body" };
    skull.userData = { bot: this, part: "head" };
    this.hitMeshes = [body, skull];

    // Floating health bar (billboarded in update).
    this.barGroup = new THREE.Group();
    const plate = new THREE.Mesh(botGeos.barBg, new THREE.MeshBasicMaterial({ color: 0x0a0d10, transparent: true, opacity: 0.75, depthWrite: false }));
    this.barFg = new THREE.Mesh(botGeos.barFg, new THREE.MeshBasicMaterial({ color: 0x57ff9a, depthWrite: false }));
    this.barFg.position.z = 0.001;
    this.barGroup.add(plate, this.barFg);
    this.barGroup.position.y = 2.12;
    this.group.add(this.barGroup);

    this.group.position.copy(this.pos);
    scene.add(this.group);
    this.scene = scene;
  }

  eyeY() {
    return this.pos.y + 1.68 * this.spec.scale;
  }
  chestPos(dest) {
    return dest.set(this.pos.x, this.pos.y + 1.25 * this.spec.scale, this.pos.z);
  }

  damage(dmg) {
    if (this.dead) return false;
    this.hp -= dmg;
    this.flashUntil = performance.now() / 1000 + 0.07;
    this.suitMat.emissive.setHex(0xff5533);
    if (this.hp <= 0) {
      this.dead = true;
      this.deathT = 0;
      this.barGroup.visible = false;
      return true;
    }
    return false;
  }

  // Turn to face the player (model forward is local -Z).
  _facePlayer(player) {
    this.yaw = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z) + Math.PI;
  }

  _followPath(step, pace) {
    if (this.pathI >= this.path.length) return true;
    const point = this.world.waypoints[this.path[this.pathI]];
    const gap = dist2D(this.pos.x, this.pos.z, point.x, point.z);
    if (gap < 0.9) {
      this.pathI += 1;
      return this._followPath(step, pace);
    }
    this._moveToward(point.x, point.z, pace, step);
    return false;
  }

  _moveToward(gx, gz, pace, step) {
    const ox = gx - this.pos.x, oz = gz - this.pos.z;
    const gap = Math.hypot(ox, oz);
    if (gap < 1e-4) return;
    // Model forward is local -Z; world forward is (-sin yaw, -cos yaw),
    // so yaw = atan2(ox, oz) + PI aims the model along (ox, oz).
    this.yaw = Math.atan2(ox, oz) + Math.PI;
    this.pos.x += (ox / gap) * pace * step;
    this.pos.z += (oz / gap) * pace * step;
    const [fixedX, fixedZ] = this.world.collideCircle(this.pos.x, this.pos.z, CFG.botRadius, this.pos.y, 1.8);
    this.pos.x = fixedX;
    this.pos.z = fixedZ;
    this.pos.y = this.world.groundAt(this.pos.x, this.pos.z, this.pos.y);
    this.walkPhase += step * pace * 2.6;
  }

  _pathTo(gx, gz, t) {
    this.path = this.world.findPath(this.pos.x, this.pos.z, gx, gz);
    this.pathI = 0;
    this.repathAt = t + rand(1.1, 1.9);
  }

  update(step, env) {
    const { player, now, fx, sfx, bots } = env;
    if (this.dead) {
      this.deathT += step;
      const fall = Math.min(1, this.deathT / 0.35);
      this.group.rotation.x = -Math.PI / 2 * fall;
      this.group.position.y = this.pos.y - Math.max(0, this.deathT - 2.1) * 0.55;
      // True means the corpse is done and the Game may remove me.
      return this.deathT > 3.1;
    }
    if (now > this.flashUntil) this.suitMat.emissive.setHex(0x000000);

    // --- perception (staggered) ---
    if (now >= this.perceiveAt) {
      this.perceiveAt = now + 0.12;
      const eye = player.eyePos(new THREE.Vector3());
      const gap = dist2D(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
      const hidden = gap > 58 || this.world.losBlocked(this.pos.x, this.eyeY(), this.pos.z, eye.x, eye.y - 0.25, eye.z);
      this.seesPlayer = !hidden && !player.dead;
      if (this.seesPlayer) {
        this.lastKnown = { x: player.pos.x, z: player.pos.z };
        this.lastSeenAt = now;
      }
    }

    const gapToPlayer = dist2D(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
    const isHurt = this.hp < this.maxHp * 0.35;
    const isReloading = now < this.reloadUntil;

    // --- state transitions ---
    if (this.state !== "cover" && (isHurt || (isReloading && !this.seesPlayer)) && now > this.coverUntil) {
      const coverIdx = this.world.nearestCoverIndex(this.pos.x, this.pos.z, player.pos.x, player.pos.z, 1.6);
      if (coverIdx >= 0) {
        this.state = "cover";
        const spot = this.world.waypoints[coverIdx];
        this.path = this.world.findPath(this.pos.x, this.pos.z, spot.x, spot.z);
        this.pathI = 0;
        this.coverUntil = now + rand(2.2, 3.6);
      }
    }
    if (this.state === "cover" && now > this.coverUntil && this.hp > this.maxHp * 0.35) this.state = "seek";
    if (this.seesPlayer && this.state !== "cover") this.state = "engage";
    else if ((this.state === "engage" || this.state === "seek") && !this.seesPlayer && now - this.lastSeenAt > 6) this.state = "advance";

    // --- behaviour ---
    let isMoving = false;
    if (this.state === "advance") {
      if (now >= this.repathAt || this.pathI >= this.path.length) {
        const goal = this.lastKnown || player.pos;
        this._pathTo(goal.x, goal.z, now);
      }
      isMoving = !this._followPath(step, this.spec.speed);
    } else if (this.state === "seek") {
      if (this.lastKnown) {
        if (now >= this.repathAt || this.pathI >= this.path.length) this._pathTo(this.lastKnown.x, this.lastKnown.z, now);
        isMoving = !this._followPath(step, this.spec.speed * 1.05);
        if (dist2D(this.pos.x, this.pos.z, this.lastKnown.x, this.lastKnown.z) < 1.6) this.state = "advance";
      }
    } else if (this.state === "cover") {
      isMoving = !this._followPath(step, this.spec.speed * 1.15);
      if (!isMoving) this._facePlayer(player);
    } else if (this.state === "engage") {
      // Face the player, hold an 11–26m band, strafe between bursts.
      this._facePlayer(player);
      if (now >= this.strafeFlipAt) {
        this.strafeDir *= -1;
        this.strafeFlipAt = now + rand(0.7, 1.6);
      }
      const sideX = Math.cos(this.yaw) * this.strafeDir;
      const sideZ = -Math.sin(this.yaw) * this.strafeDir;
      let driftX = sideX * 0.9, driftZ = sideZ * 0.9;
      if (gapToPlayer > 26) {
        driftX += (player.pos.x - this.pos.x) / gapToPlayer;
        driftZ += (player.pos.z - this.pos.z) / gapToPlayer;
      } else if (gapToPlayer < 10) {
        driftX -= (player.pos.x - this.pos.x) / gapToPlayer;
        driftZ -= (player.pos.z - this.pos.z) / gapToPlayer;
      }
      const driftLen = Math.hypot(driftX, driftZ) || 1;
      this.pos.x += (driftX / driftLen) * this.spec.speed * 0.62 * step;
      this.pos.z += (driftZ / driftLen) * this.spec.speed * 0.62 * step;
      const [fixedX, fixedZ] = this.world.collideCircle(this.pos.x, this.pos.z, CFG.botRadius, this.pos.y, 1.8);
      this.pos.x = fixedX;
      this.pos.z = fixedZ;
      this.pos.y = this.world.groundAt(this.pos.x, this.pos.z, this.pos.y);
      isMoving = true;
      this._shoot(step, env, gapToPlayer);
    }

    // Separation from squadmates (cheap O(n) over the alive list).
    for (const mate of bots) {
      if (mate === this || mate.dead) continue;
      const gap = dist2D(this.pos.x, this.pos.z, mate.pos.x, mate.pos.z);
      if (gap > 0.01 && gap < 0.95) {
        const shove = (0.95 - gap) * 0.5;
        this.pos.x += ((this.pos.x - mate.pos.x) / gap) * shove;
        this.pos.z += ((this.pos.z - mate.pos.z) / gap) * shove;
      }
    }

    // --- presentation ---
    this.group.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.group.rotation.y = this.yaw;
    const stride = isMoving ? Math.sin(this.walkPhase) * 0.5 : 0;
    this.legL.rotation.x = stride;
    this.legR.rotation.x = -stride;
    const healthFrac = clamp(this.hp / this.maxHp, 0, 1);
    this.barFg.scale.x = Math.max(0.001, healthFrac);
    this.barFg.position.x = -(1 - healthFrac) * 0.44;
    this.barFg.material.color.setHSL(lerp(0.0, 0.36, healthFrac), 0.95, 0.55);
    const barWorld = this.barGroup.getWorldPosition(new THREE.Vector3());
    this.barGroup.lookAt(env.camera.position.x, barWorld.y, env.camera.position.z);
    return false;
  }

  _shoot(step, env, gapToPlayer) {
    const { player, now, fx, sfx } = env;
    if (player.dead || !this.seesPlayer) return;
    if (now < this.reloadUntil) return;
    if (this.shotsInMag <= 0) {
      this.reloadUntil = now + 1.5;
      this.shotsInMag = 12;
      return;
    }
    if (this.burstLeft <= 0) {
      if (now < this.burstPauseUntil) return;
      this.burstLeft = 3 + ((Math.random() * 3) | 0);
      this.nextShotAt = now;
    }
    if (now < this.nextShotAt) return;
    this.nextShotAt = now + 0.15;
    this.burstLeft -= 1;
    this.shotsInMag -= 1;
    if (this.burstLeft <= 0) this.burstPauseUntil = now + rand(0.65, 1.25);

    const muzzlePos = new THREE.Vector3();
    this.muzzle.getWorldPosition(muzzlePos);
    // Hit chance falls with range; sprinting, crouching, and airborne
    // targets are harder to hit.
    let chance = 0.36 - gapToPlayer * 0.0042;
    if (player.sprinting) chance -= 0.07;
    if (player.crouchAmt > 0.5) chance -= 0.05;
    if (!player.onGround) chance -= 0.05;
    chance = clamp(chance, 0.05, 0.38);
    const aim = player.eyePos(new THREE.Vector3());
    aim.y -= 0.35;
    if (Math.random() < chance) {
      fx.tracer(muzzlePos, aim, 0xff7a5e);
      env.onPlayerHit(this.spec.damage, this.pos);
    } else {
      aim.x += rand(-1.3, 1.3);
      aim.y += rand(-0.5, 0.7);
      aim.z += rand(-1.3, 1.3);
      fx.tracer(muzzlePos, aim, 0xff7a5e);
      fx.burst(aim, 3, 1.6, 1.0);
    }
    if (gapToPlayer < 42) sfx.shotEnemy();
  }

  dispose(scene) {
    scene.remove(this.group);
    this.suitMat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Wave director: composition, spawn pacing, intermissions, victory.
// The Game owns the bot list; the director only decides what spawns when.
// ---------------------------------------------------------------------------

export class WaveDirector {
  constructor(world) {
    this.world = world;
    this.wave = 0;
    // idle | active | intermission | won | lost
    this.state = "idle";
    this.toSpawn = [];
    this.spawnTimer = 0;
    this.intermissionUntil = 0;
    this.killsThisWave = 0;
  }

  composition(wave) {
    const roster = [];
    const headcount = 3 + wave * 2;
    const heavyCount = wave >= 4 ? 1 + Math.floor((wave - 4) / 2) : 0;
    const rusherCount = Math.min(
      headcount - heavyCount - 2,
      Math.floor(headcount * (wave >= 3 ? 0.35 : 0.15))
    );
    for (let a = 0; a < heavyCount; a++) roster.push("heavy");
    for (let a = 0; a < rusherCount; a++) roster.push("rusher");
    while (roster.length < headcount) roster.push("grunt");
    // Shuffle so the heavies do not all arrive first.
    for (let a = roster.length - 1; a > 0; a--) {
      const b = (Math.random() * (a + 1)) | 0;
      [roster[a], roster[b]] = [roster[b], roster[a]];
    }
    return roster;
  }

  startNextWave(now) {
    this.wave += 1;
    this.toSpawn = this.composition(this.wave);
    this.state = "active";
    this.spawnTimer = 0;
    this.killsThisWave = 0;
    return this.wave;
  }

  // Returns a spawn order {kind, gate} or null. aliveCap keeps the field
  // readable and the frame rate smooth.
  update(step, alive, t) {
    if (this.state === "intermission") {
      if (t >= this.intermissionUntil) return { beginWave: true };
      return null;
    }
    if (this.state !== "active") return null;
    if (this.toSpawn.length === 0) {
      if (alive === 0) {
        if (this.wave >= CFG.maxWaves) {
          this.state = "won";
          return { won: true };
        }
        this.state = "intermission";
        this.intermissionUntil = t + 6;
        return { waveCleared: this.wave };
      }
      return null;
    }
    this.spawnTimer -= step;
    if (this.spawnTimer <= 0 && alive < 8) {
      this.spawnTimer = 0.85;
      const kind = this.toSpawn.shift();
      const gate = randPick(this.world.spawnGates);
      return { kind, gate };
    }
    return null;
  }

  remaining(alive) {
    return alive + this.toSpawn.length;
  }
}

// ---------------------------------------------------------------------------
// Game: wires everything together — input, pointer lock, HUD, menus, loop.
// ---------------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

export class Game {
  constructor() {
    this.world = new World();
    const parts = buildScene(this.world);
    this.renderer = parts.renderer;
    this.scene = parts.scene;
    this.camera = parts.camera;
    this.worldMeshes = parts.worldMeshes;
    this.scene.add(this.camera);
    this.fx = new Fx(this.scene);
    this.sfx = new Sfx();
    this.player = new Player(this.world, { x: 0, z: 24 });
    this.weapon = new Weapon(this.camera, this.sfx);
    // Hidden until a run starts.
    this.weapon.group.visible = false;
    this.director = new WaveDirector(this.world);
    this.bots = [];
    // menu | playing | paused | over
    this.state = "menu";
    this.score = 0;
    this.kills = 0;
    this.time = 0;
    this.vignette = 0;
    this.hitmarkUntil = -1;
    this.hitmarkKill = false;
    this.bannerUntil = -1;
    this.lastFov = 75;
    this.keys = {};
    this.mouseDown = false;
    this.mouseAds = false;
    this.input = {
      forward: false, back: false, left: false, right: false,
      sprint: false, crouch: false, jump: false, ads: false, trigger: false,
    };
    this.el = {
      hud: $("hud"),
      hpBar: $("hp-bar"),
      hpNum: $("hp-num"),
      ammoMag: $("ammo-mag"),
      ammoReserve: $("ammo-reserve"),
      weaponName: $("weapon-name"),
      reloadHint: $("reload-hint"),
      waveLabel: $("wave-label"),
      enemiesLabel: $("enemies-label"),
      scoreLabel: $("score-label"),
      killfeed: $("killfeed"),
      banner: $("banner"),
      bannerTitle: $("banner-title"),
      bannerSub: $("banner-sub"),
      hitmarker: $("hitmarker"),
      vignette: $("damage-vignette"),
      lowhp: $("lowhp"),
      dirHit: $("direction-hit"),
      crosshair: $("crosshair"),
      menu: $("menu"),
      pause: $("pause-menu"),
      over: $("over-menu"),
      overTitle: $("over-title"),
      overStats: $("over-stats"),
    };
    this._bindInput();
    this._bindMenus();
  }

  _bindInput() {
    const canvas = this.renderer.domElement;
    document.addEventListener("keydown", (ev) => {
      this.keys[ev.code] = true;
      if (ev.code === "Space") ev.preventDefault();
      if (this.state !== "playing") return;
      const now = performance.now() / 1000;
      if (ev.code === "KeyR") this.weapon.startReload(now);
      if (ev.code === "KeyB") {
        this.weapon.mode = this.weapon.mode === "AUTO" ? "SEMI" : "AUTO";
        this.el.weaponName.textContent = `VK-7 CARBINE · ${this.weapon.mode}`;
      }
      if (ev.code === "KeyM") this.sfx.setMuted(!this.sfx.muted);
    });
    document.addEventListener("keyup", (ev) => {
      this.keys[ev.code] = false;
    });
    document.addEventListener("mousemove", (ev) => {
      if (document.pointerLockElement !== canvas || this.state !== "playing") return;
      const sensitivity = lerp(0.0021, 0.0012, this.weapon.adsAmt);
      this.player.yaw -= ev.movementX * sensitivity;
      this.player.pitch = clamp(this.player.pitch - ev.movementY * sensitivity, -1.45, 1.45);
    });
    document.addEventListener("mousedown", (ev) => {
      if (document.pointerLockElement !== canvas) return;
      if (ev.button === 0) this.mouseDown = true;
      if (ev.button === 2) this.mouseAds = true;
    });
    document.addEventListener("mouseup", (ev) => {
      if (ev.button === 0) this.mouseDown = false;
      if (ev.button === 2) this.mouseAds = false;
    });
    document.addEventListener("contextmenu", (ev) => ev.preventDefault());
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === canvas;
      if (!locked && this.state === "playing") this._pause();
      else if (locked && this.state === "paused") this._resume();
    });
  }

  _bindMenus() {
    $("btn-play").addEventListener("click", () => {
      this.sfx.ensure();
      this.startRun();
      this._lock();
    });
    $("btn-resume").addEventListener("click", () => this._lock());
    $("btn-restart").addEventListener("click", () => {
      this.startRun();
      this._lock();
    });
    $("btn-again").addEventListener("click", () => {
      this.startRun();
      this._lock();
    });
  }

  _lock() {
    // Pointer lock is best-effort: headless runs and denied permissions
    // must not throw — the game stays fully playable without it.
    try {
      const p = this.renderer.domElement.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch { /* no pointer lock: keep playing */ }
  }
  _pause() {
    this.state = "paused";
    this.el.pause.style.display = "flex";
  }
  _resume() {
    this.state = "playing";
    this.el.pause.style.display = "none";
  }

  startRun() {
    for (const b of this.bots) b.dispose(this.scene);
    this.bots = [];
    this.player = new Player(this.world, { x: 0, z: 24 });
    // Rebind the weapon's recoil target: it references the player per shot,
    // and the view model stays attached to the camera across runs.
    this.weapon.mag = this.weapon.magSize;
    this.weapon.reserve = 150;
    this.weapon.reloadingUntil = -1;
    this.weapon.bloom = 0;
    // Accuracy counters reset: without this, gameOver() reports the
    // previous run's shots on the next run's results screen.
    this.weapon.shotsFired = 0;
    this.weapon.shotsHit = 0;
    this.director = new WaveDirector(this.world);
    this.score = 0;
    this.kills = 0;
    this.vignette = 0;
    this.el.killfeed.innerHTML = "";
    this.el.menu.style.display = "none";
    this.el.over.style.display = "none";
    this.el.pause.style.display = "none";
    this.el.hud.style.display = "block";
    this.weapon.group.visible = true;
    this.state = "playing";
    const waveNo = this.director.startNextWave(performance.now() / 1000);
    this.showBanner(`WAVE ${waveNo}`, "HOSTILES INBOUND", 2.2);
    this.sfx.waveStart();
  }

  gameOver(won) {
    this.state = "over";
    if (document.exitPointerLock) document.exitPointerLock();
    this.el.hud.style.display = "none";
    this.weapon.group.visible = false;
    this.el.over.style.display = "flex";
    this.el.overTitle.textContent = won ? "COMPOUND SECURED" : "SIGNAL LOST";
    const accuracy = this.weapon.shotsFired > 0
      ? Math.round((this.weapon.shotsHit / this.weapon.shotsFired) * 100)
      : 0;
    this.el.overStats.innerHTML =
      `SCORE <b>${this.score}</b><br>` +
      `WAVE REACHED <b>${this.director.wave}</b> / ${CFG.maxWaves}<br>` +
      `KILLS <b>${this.kills}</b> · ACCURACY <b>${accuracy}%</b>`;
    if (won) this.sfx.victory();
    else this.sfx.defeat();
  }

  showBanner(title, sub, dur = 2) {
    this.el.bannerTitle.textContent = title;
    this.el.bannerSub.textContent = sub;
    this.el.banner.style.opacity = "1";
    this.bannerUntil = this.time + dur;
  }

  addKillfeed(markup) {
    const row = document.createElement("div");
    row.innerHTML = markup;
    this.el.killfeed.prepend(row);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastChild.remove();
    setTimeout(() => {
      row.style.opacity = "0.25";
    }, 2600);
    setTimeout(() => {
      row.remove();
    }, 3400);
  }

  damagePlayer(amount, fromPos) {
    const now = performance.now() / 1000;
    this.player.damage(amount, now);
    this.sfx.hurt();
    this.vignette = 1;
    // Directional hit arc: rotate so the arc sits toward the attacker.
    const ox = fromPos.x - this.player.pos.x;
    const oz = fromPos.z - this.player.pos.z;
    const incoming = Math.atan2(-ox, -oz);
    let offset = incoming - this.player.yaw;
    offset = Math.atan2(Math.sin(offset), Math.cos(offset));
    this.el.dirHit.style.transform = `rotate(${-offset}rad)`;
    this.el.dirHit.style.opacity = "1";
    if (this.player.dead) this.gameOver(false);
  }

  _readInput() {
    const keys = this.keys;
    const input = this.input;
    input.forward = !!(keys.KeyW || keys.ArrowUp);
    input.back = !!(keys.KeyS || keys.ArrowDown);
    input.left = !!(keys.KeyA || keys.ArrowLeft);
    input.right = !!(keys.KeyD || keys.ArrowRight);
    input.sprint = !!(keys.ShiftLeft || keys.ShiftRight);
    input.crouch = !!(keys.ControlLeft || keys.KeyC);
    input.jump = !!keys.Space;
    input.trigger = this.mouseDown;
    input.ads = this.mouseAds;
  }

  _shoot(now) {
    const meshes = [];
    for (const b of this.bots) if (!b.dead) meshes.push(...b.hitMeshes);
    const result = this.weapon.tryFire(now, this.camera, this.worldMeshes, meshes, this.player);
    if (!result) return;
    if (result.dry) {
      this.el.reloadHint.textContent = "RELOADING…";
      return;
    }
    if (result.point) this.fx.tracer(result.muzzleWorld, result.point, 0xffd9a0);
    if (result.bot) {
      const drop = result.distance <= 25 ? 1 : clamp(1 - (result.distance - 25) * 0.006, 0.55, 1);
      const points = this.weapon.damage * (result.part === "head" ? this.weapon.headMult : 1) * drop;
      const killed = result.bot.damage(points);
      this.weapon.shotsHit += 1;
      this.fx.burst(result.point, killed ? 16 : 7, 3.6, 2);
      this.hitmarkUntil = this.time + 0.09;
      this.hitmarkKill = killed;
      this.el.hitmarker.classList.toggle("kill", killed);
      if (killed) {
        this.sfx.kill();
        this.kills += 1;
        const headBonus = result.part === "head" ? 50 : 0;
        this.score += result.bot.spec.score + headBonus;
        this.addKillfeed(result.part === "head"
          ? `<span class="hs">HEADSHOT</span> ${result.bot.kind.toUpperCase()} +${result.bot.spec.score + headBonus}`
          : `${result.bot.kind.toUpperCase()} DOWN +${result.bot.spec.score}`);
      } else {
        this.sfx.hit();
      }
    } else if (result.point) {
      this.fx.burst(result.point, 4, 2.2, 1.2);
    }
  }

  _updatePlaying(dt, now) {
    this._readInput();
    const me = this.player;
    me.update(dt, this.input, now);
    if (me.jumped) { this.sfx.jump(); me.jumped = false; }
    if (me.landedHard) { this.sfx.land(); me.landedHard = false; }

    // Camera from the player, with recoil layered on top.
    const view = me.eyePos(new THREE.Vector3());
    this.camera.position.copy(view);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = me.yaw + me.recoilYaw;
    this.camera.rotation.x = me.pitch + me.recoilPitch;
    this.camera.rotation.z = 0;

    this.weapon.update(dt, now, this.input, me);
    const targetFov = lerp(75, 52, this.weapon.adsAmt);
    if (Math.abs(targetFov - this.lastFov) > 0.05) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
      this.lastFov = targetFov;
    }
    if (this.input.trigger && !me.sprinting) this._shoot(now);

    // Waves and spawning.
    const event = this.director.update(dt, this.bots.filter((b) => !b.dead).length, now);
    if (event) {
      if (event.kind) {
        const foe = new Bot(this.world, this.scene, event.kind, event.gate.x + rand(-2, 2), event.gate.z + rand(-2, 2));
        this.bots.push(foe);
      } else if (event.beginWave) {
        const waveNo = this.director.startNextWave(now);
        this.showBanner(`WAVE ${waveNo}`, "HOSTILES INBOUND", 2.2);
        this.sfx.waveStart();
      } else if (event.waveCleared) {
        this.score += 250;
        me.heal(40);
        this.weapon.refill();
        this.showBanner(`WAVE ${event.waveCleared} CLEAR`, "+250 · INTEGRITY +40 · AMMO REFILLED", 2.6);
        this.sfx.waveClear();
      } else if (event.won) {
        this.gameOver(true);
        return;
      }
    }

    // Bots.
    const env = {
      player: me, now, fx: this.fx, sfx: this.sfx, bots: this.bots, camera: this.camera,
      onPlayerHit: (dmg, fromPos) => this.damagePlayer(dmg, fromPos),
    };
    for (let idx = this.bots.length - 1; idx >= 0; idx--) {
      if (this.bots[idx].update(dt, env)) {
        this.bots[idx].dispose(this.scene);
        this.bots.splice(idx, 1);
      }
    }

    this._updateHud(now);
  }

  _updateHud(now) {
    const me = this.player;
    const ui = this.el;
    const health = clamp(me.hp / me.maxHp, 0, 1);
    ui.hpBar.style.width = `${health * 100}%`;
    ui.hpBar.style.background = health > 0.5 ? "var(--ok)" : health > 0.25 ? "var(--accent)" : "var(--danger)";
    ui.hpNum.textContent = String(Math.ceil(me.hp));
    ui.ammoMag.textContent = String(this.weapon.mag);
    ui.ammoReserve.textContent = `/ ${this.weapon.reserve}`;
    if (this.weapon.reloading) ui.reloadHint.textContent = "RELOADING…";
    else if (this.weapon.mag === 0 && this.weapon.reserve > 0) ui.reloadHint.textContent = "R — RELOAD";
    else if (this.weapon.mag <= 6 && this.weapon.reserve > 0) ui.reloadHint.textContent = "LOW — R TO RELOAD";
    else ui.reloadHint.textContent = "";
    ui.waveLabel.textContent = `WAVE ${this.director.wave}`;
    ui.enemiesLabel.textContent = `HOSTILES ${this.director.remaining(this.bots.filter((b) => !b.dead).length)}`;
    ui.scoreLabel.textContent = String(this.score);
    ui.crosshair.style.setProperty("--sp", `${this.weapon.spreadPx()}px`);
    ui.hitmarker.style.opacity = this.time < this.hitmarkUntil ? "1" : "0";
    this.vignette = Math.max(0, this.vignette - 0.028);
    ui.vignette.style.opacity = String(this.vignette * 0.9);
    ui.lowhp.style.opacity = me.hp < 32 && !me.dead ? String(0.45 + 0.3 * Math.sin(now * 6)) : "0";
    if (this.time > this.bannerUntil) ui.banner.style.opacity = "0";
    if (ui.dirHit.style.opacity === "1" && this.vignette <= 0.3) ui.dirHit.style.opacity = "0";
  }

  frame(dt) {
    this.time = performance.now() / 1000;
    const now = this.time;
    if (this.state === "playing") {
      this._updatePlaying(dt, now);
    } else if (this.state === "menu" || this.state === "over") {
      // Slow orbit over the compound behind the menus.
      const angle = now * 0.045;
      this.camera.position.set(Math.cos(angle) * 27, 11.5, Math.sin(angle) * 27);
      this.camera.lookAt(0, 0.8, 0);
      if (this.camera.fov !== 60) {
        this.camera.fov = 60;
        this.camera.updateProjectionMatrix();
        this.lastFov = 60;
      }
    }
    this.fx.update(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

// ---------------------------------------------------------------------------
// Boot (browser only). In Node the module just exports its classes, which
// is how the headless smoke test exercises the simulation.
// ---------------------------------------------------------------------------

const IS_BROWSER = typeof window !== "undefined" && typeof document !== "undefined";
if (IS_BROWSER) {
  try {
    const session = new Game();
    const timer = new THREE.Clock();
    const tick = () => {
      requestAnimationFrame(tick);
      session.frame(Math.min(timer.getDelta(), 0.05));
    };
    tick();
  } catch (failure) {
    const errorBox = document.getElementById("webgl-error");
    if (errorBox) errorBox.style.display = "flex";
    const menuEl = document.getElementById("menu");
    if (menuEl) menuEl.style.display = "none";
    console.error(failure);
  }
}



