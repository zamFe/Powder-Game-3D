// Simulation core: grid arrays, frame stepping, generic particle movement.
(function () {
  const E = PG.E, els = PG.elements, air = PG.air;

  PG.W = 0; PG.H = 0;
  PG.type = null;   // Uint8Array  - element id per cell
  PG.life = null;   // Int32Array  - multi-purpose per-cell counter/state
  PG.updated = null;// Uint8Array  - frame stamp, prevents double-moves
  PG.frame = 0;
  PG.partCount = 0;
  PG.behaviors = []; // filled by behaviors.js

  PG.initGrid = function (w, h) {
    PG.W = w; PG.H = h;
    const n = w * h;
    PG.type = new Uint8Array(n);
    PG.life = new Int32Array(n);
    PG.updated = new Uint8Array(n);
    air.init(w, h);
    PG.player = null;
  };

  PG.clearGrid = function () {
    PG.type.fill(0); PG.life.fill(0); PG.updated.fill(0);
    air.clear();
    PG.player = null;
  };

  // Resize the field, keeping content (anchored bottom-center).
  PG.resizeGrid = function (newW, newH) {
    if (!PG.type) { PG.initGrid(newW, newH); return; }
    const oldW = PG.W, oldH = PG.H;
    if (newW === oldW && newH === oldH) return;
    const nt = new Uint8Array(newW * newH);
    const nl = new Int32Array(newW * newH);
    const dx = Math.floor((newW - oldW) / 2), dy = newH - oldH;
    const sx0 = Math.max(0, -dx), sx1 = Math.min(oldW, newW - dx);
    for (let y = 0; y < oldH; y++) {
      const ny = y + dy;
      if (ny < 0 || ny >= newH || sx1 <= sx0) continue;
      nt.set(PG.type.subarray(y * oldW + sx0, y * oldW + sx1), ny * newW + sx0 + dx);
      nl.set(PG.life.subarray(y * oldW + sx0, y * oldW + sx1), ny * newW + sx0 + dx);
    }
    PG.W = newW; PG.H = newH;
    PG.type = nt; PG.life = nl;
    PG.updated = new Uint8Array(newW * newH);
    air.init(newW, newH);
    if (PG.player) {
      PG.player.x = Math.max(1, Math.min(newW - 2, PG.player.x + dx));
      PG.player.y = Math.max(PG.player.h + 1, Math.min(newH - 2, PG.player.y + dy));
    }
  };

  PG.idx = (x, y) => y * PG.W + x;
  PG.inBounds = (x, y) => x >= 0 && y >= 0 && x < PG.W && y < PG.H;

  PG.get = function (x, y) {
    if (!PG.inBounds(x, y)) return E.BLOCK; // out of bounds acts solid
    return PG.type[y * PG.W + x];
  };

  PG.set = function (x, y, t, lifeVal) {
    if (!PG.inBounds(x, y)) return;
    const i = y * PG.W + x;
    PG.type[i] = t;
    PG.life[i] = lifeVal | 0;
    PG.updated[i] = PG.stamp; // freshly placed cells wait one frame
  };

  PG.isEmpty = (x, y) => PG.inBounds(x, y) && PG.type[y * PG.W + x] === 0;

  PG.isSolid = function (t) {
    const s = els[t].state;
    return s === "static" || t === E.BLOCK;
  };

  const rngBuf = new Uint32Array(1);
  let seed = 12345;
  PG.rand = function (n) { // fast xorshift, 0..n-1
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    rngBuf[0] = seed;
    return rngBuf[0] % n;
  };
  PG.chance = (oneIn) => PG.rand(oneIn) === 0;

  // --- movement helpers -------------------------------------------------

  // Move particle at (x,y) to (nx,ny). Swaps if destination is a fluid the
  // mover can displace (denser sinks). Returns true if it moved.
  PG.tryMove = function (x, y, nx, ny) {
    if (!PG.inBounds(nx, ny)) return false;
    const i = y * PG.W + x, j = ny * PG.W + nx;
    const t = PG.type[i], d = PG.type[j];
    if (d === 0) {
      PG.type[j] = t; PG.life[j] = PG.life[i];
      PG.type[i] = 0; PG.life[i] = 0;
      PG.updated[j] = PG.stamp;
      return true;
    }
    // displacement: sink through lighter liquids/gases
    const ds = els[d].state;
    if ((ds === "liquid" || ds === "gas") && els[t].density > els[d].density) {
      const tl = PG.life[i];
      PG.type[i] = d; PG.life[i] = PG.life[j];
      PG.type[j] = t; PG.life[j] = tl;
      PG.updated[j] = PG.stamp; PG.updated[i] = PG.stamp;
      return true;
    }
    return false;
  };

  // Wind: nudge a movable particle along the air velocity field.
  // strength scales how easily this element is blown (powder 1, gas 3...).
  PG.windPush = function (x, y, strength) {
    const wx = air.velX(x, y), wy = air.velY(x, y);
    const mag = Math.abs(wx) + Math.abs(wy);
    if (mag < 0.55) return false;
    // probabilistic move in wind direction; strong gusts move 2 cells
    if (PG.rand(10) > Math.min(9, mag * strength * 2)) return false;
    let dx = 0, dy = 0;
    if (Math.abs(wx) > Math.abs(wy) * (PG.rand(2) ? 1 : 0.5)) dx = wx > 0 ? 1 : -1;
    else dy = wy > 0 ? 1 : -1;
    if (!PG.tryMove(x, y, x + dx, y + dy)) return false;
    if (mag * strength > 6 && PG.chance(2)) PG.tryMove(x + dx, y + dy, x + 2 * dx, y + 2 * dy);
    return true;
  };

  // Particle -> air drag: a moving particle imparts a little of its motion to
  // the air, so falling streams pull a downdraft and gusts carry "rivers" of
  // dust. Cheap: only a fraction of moves actually couple.
  const DRAG = 0.05;
  PG.dragAir = function (x, y, dvx, dvy) {
    if (PG.rand(4)) return;
    air.addVel(x, y, dvx * DRAG, dvy * DRAG);
  };

  PG.doPowder = function (x, y) {
    if (PG.windPush(x, y, 1)) return;
    if (PG.tryMove(x, y, x, y + 1)) { PG.dragAir(x, y + 1, 0, 1); return; }
    const dir = PG.rand(2) ? 1 : -1;
    if (PG.tryMove(x, y, x + dir, y + 1)) { PG.dragAir(x + dir, y + 1, dir, 1); return; }
    PG.tryMove(x, y, x - dir, y + 1);
  };

  // Liquid behaviour mode (shared by 2D + 3D): 0 = Classic (cheap cellular
  // settling), 1 = Fluid (sees much farther and slides the whole way each frame,
  // so pours level fast and wide).
  PG.fluidMode = 0;
  const FLUID_REACH = 16;

  // Settling liquid. Falls, then flows horizontally. It prefers the nearest
  // DESCENT (a spot it can fall into), but if none is reachable it still SPREADS
  // into open same-level space — that lateral spread lets a body walk off a
  // mound and level out flat instead of freezing into a sand-like pile. It only
  // stops when boxed in sideways (the flat, full surface of a filled basin).
  // Fluid scans far and slides the whole way; Classic looks close and inches.
  PG.doLiquid = function (x, y, disperse) {
    if (PG.windPush(x, y, 1.4)) return;
    if (PG.tryMove(x, y, x, y + 1)) { PG.dragAir(x, y + 1, 0, 1); return; }
    const fluid = PG.fluidMode, dir = PG.rand(2) ? 1 : -1;
    if (PG.tryMove(x, y, x + dir, y + 1)) return;          // settle diagonally into a pit
    if (PG.tryMove(x, y, x - dir, y + 1)) return;
    const reach = fluid ? FLUID_REACH : disperse;
    let hk = reach + 1, hcx = x;                           // nearest descent
    let canSpread = false, sd = 0, scx = x;                // first open direction
    for (const d of (dir > 0 ? [1, -1] : [-1, 1])) {
      let cx = x;
      for (let k = 1; k <= reach; k++) {
        if (k >= hk) break;
        if (!PG.isEmpty(cx + d, y)) break;
        cx += d;
        if (!canSpread) { canSpread = true; sd = d; scx = cx; }
        else if (d === sd) scx = cx;                       // extend the slide
        if (PG.isEmpty(cx, y + 1)) { hk = k; hcx = cx; break; }
      }
    }
    if (hk <= reach) { PG.tryMove(x, y, hcx, y); return; }   // descend toward the hole
    // flat-spread only when stacked on more of the same liquid (a ≥2-deep pile);
    // a 1-deep / bottom-layer cell is already level, so it doesn't shuffle.
    const i = y * PG.W + x;
    if (canSpread && y + 1 < PG.H && PG.type[i + PG.W] === PG.type[i]) PG.tryMove(x, y, scx, y);
  };

  // Waves: a traveling sinusoid that pushes surface liquid sideways, so a body
  // of water shows crests rolling across it. 0 = off. Net transport is ~zero
  // because the forcing is symmetric. Returns true if it moved the cell.
  PG.waveStr = 1;
  const WAVE_K = 0.20, WAVE_SPEED = 0.10;
  PG.waveSurface = function (x, y, i) {
    if (!PG.waveStr || !PG.isEmpty(x, y - 1)) return false; // surface cells only
    const w = Math.sin(x * WAVE_K - PG.frame * WAVE_SPEED);
    const thr = 1.05 - 0.45 * PG.waveStr; // higher strength -> more cells crest
    if (w > thr && PG.chance(2)) {
      if (PG.tryMove(x, y, x + 1, y)) { PG.life[i] = 1; return true; }
    } else if (w < -thr && PG.chance(2)) {
      if (PG.tryMove(x, y, x - 1, y)) { PG.life[i] = -1; return true; }
    }
    return false;
  };

  // Momentum liquid (water & friends): keeps its flow direction in the cell's
  // life (+1/-1), falls fast, and glides along the surface until it finds a
  // hole to drop into — so pools level out instead of stacking in columns.
  // Only for elements that don't use life for anything else.
  PG.flowLiquid = function (x, y, i, slide) {
    if (PG.windPush(x, y, 1.4)) return;
    if (PG.tryMove(x, y, x, y + 1)) {
      PG.dragAir(x, y + 1, 0, 1);
      if (PG.chance(2)) PG.tryMove(x, y + 1, x, y + 2); // gravity, not syrup
      return;
    }
    if (PG.waveSurface(x, y, i)) return;
    let dir = PG.life[i] > 0 ? 1 : PG.life[i] < 0 ? -1 : (PG.rand(2) ? 1 : -1);
    if (PG.chance(40)) dir = -dir; // a little turbulence
    if (PG.tryMove(x, y, x + dir, y + 1)) { PG.life[i] = dir; return; }
    if (PG.tryMove(x, y, x - dir, y + 1)) { PG.life[i] = -dir; return; }
    let cx = x;
    for (let k = 0; k < slide; k++) {
      if (!PG.isEmpty(cx + dir, y)) { dir = -dir; break; }
      cx += dir;
      if (PG.isEmpty(cx, y + 1)) break; // hole found: drop in next frame
    }
    if (cx !== x) {
      const j = y * PG.W + cx;
      PG.type[j] = PG.type[i]; PG.life[j] = dir;
      PG.type[i] = 0; PG.life[i] = 0;
      PG.updated[j] = PG.stamp;
    } else PG.life[i] = dir;
  };

  PG.doGas = function (x, y) {
    if (PG.windPush(x, y, 3)) return;
    const r = PG.rand(4);
    if (r === 0 && PG.tryMove(x, y, x, y - 1)) { PG.dragAir(x, y - 1, 0, -1); return; }
    if (r === 1 && PG.tryMove(x, y, x + 1, y - PG.rand(2))) return;
    if (r === 2 && PG.tryMove(x, y, x - 1, y - PG.rand(2))) return;
    if (PG.chance(3)) PG.tryMove(x, y, x + (PG.rand(2) ? 1 : -1), y);
    else PG.tryMove(x, y, x, y - 1);
  };

  // --- explosions -------------------------------------------------------

  PG.explode = function (x, y, radius, power) {
    air.blast(x, y, radius, power);
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const nx = x + dx, ny = y + dy;
        if (!PG.inBounds(nx, ny)) continue;
        const i = ny * PG.W + nx;
        const t = PG.type[i];
        if (t === E.BLOCK || t === E.GLASS) continue;
        if (t === E.C4 || t === E.NITRO || t === E.GPOWDER || t === E.BOMB) {
          // chain reactions: turn into fire now, it detonates next frame
          PG.type[i] = E.FIRE; PG.life[i] = 1; continue;
        }
        if (d2 < r2 * 0.55 || PG.chance(2)) {
          PG.type[i] = E.FIRE;
          PG.life[i] = 20 + PG.rand(30);
          PG.updated[i] = PG.stamp;
        }
      }
    }
    if (PG.player) PG.player.hitByBlast(x, y, radius);
  };

  // --- main step --------------------------------------------------------

  PG.stamp = 1;

  PG.stepSim = function () {
    PG.frame++;
    PG.stamp = (PG.frame & 255) || 1; // never 0 so fresh grids work
    const W = PG.W, H = PG.H, type = PG.type, upd = PG.updated;

    // mark solid cells as air walls (sampled, every other cell is plenty)
    air.clearWalls();
    const AC = air.CELL;
    for (let y = 0; y < H; y += AC) {
      for (let x = 0; x < W; x += AC) {
        // probe center of this air cell
        const px = Math.min(W - 1, x + 2), py = Math.min(H - 1, y + 2);
        const t = type[py * W + px];
        if (t !== 0 && PG.isSolid(t) && t !== PG.E.FAN && t !== PG.E.PUMP) {
          air.setWall(x / AC | 0, y / AC | 0);
        }
      }
    }
    air.step();

    // particle pass: bottom-up, alternating x direction
    let count = 0;
    const ltr = (PG.frame & 1) === 0;
    for (let y = H - 1; y >= 0; y--) {
      const row = y * W;
      for (let k = 0; k < W; k++) {
        const x = ltr ? k : W - 1 - k;
        const i = row + x;
        const t = type[i];
        if (t === 0) continue;
        count++;
        if (upd[i] === PG.stamp) continue;
        upd[i] = PG.stamp;
        const fn = PG.behaviors[t];
        if (fn) fn(x, y, i);
      }
    }
    PG.partCount = count;

    if (PG.player) PG.player.update();
  };
})();
