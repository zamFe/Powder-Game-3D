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

  // per-element lookup tables for hot loops: FLOWS 1 = liquid, 2 = gas
  PG.FLOWS = new Uint8Array(els.length); PG.DENS = new Uint16Array(els.length);
  els.forEach((el, t) => {
    if (!el) return;
    PG.FLOWS[t] = el.state === "liquid" ? 1 : el.state === "gas" ? 2 : 0;
    PG.DENS[t] = el.density;
  });

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

  let seed = 12345;
  PG.rand = function (n) { // fast xorshift, 0..n-1
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % n;
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

  // ---- liquids ---------------------------------------------------------------
  // Liquid behaviour mode (shared by 2D + 3D): 0 = Classic, 1 = Fluid.
  // Classic is Powder Game's own liquid. Every liquid cell carries a velocity
  // that survives from frame to frame (damped by `frc`); gravity arrives as a
  // small random kick; a cell resting on something is pushed toward any empty
  // side, which is what makes a pile run off and level out; the air adds its
  // own flow. The step is soft-capped below 3.8 cells a frame, so liquid
  // accelerates into a fall or a slide instead of teleporting to a hole.
  // Fluid (fluid.js) replaces the rules with a pressure-projected flow.
  PG.fluidMode = 0;

  // Per-liquid constants, from Powder Game's liquid update: air coupling, side
  // push (x1 + up to xs), sideways jitter, gravity kick (y1 + up to ys),
  // friction. `cond`: a conductor whose negative life is a spark cool-down.
  const LQ = (adv, x1, x2, xr, y1, y2, frc, cond) =>
    ({ adv, x1, xs: x2 - x1, xr, y1, ys: y2 - y1, frc, cond: !!cond });
  PG.LIQUID = {
    water:  LQ(0.2, 0.1, 0.2, 0.01, 0.01, 0.05, 0.9),
    oil:    LQ(0.2, 0.1, 0.2, 0.01, 0.01, 0.05, 0.9),
    salt:   LQ(0.2, 0.1, 0.2, 0.01, 0.01, 0.05, 0.9, true),
    mercury: LQ(0.2, 0.1, 0.2, 0.01, 0.01, 0.05, 0.9, true),
    nitro:  LQ(0.2, 0.1, 0.2, 0.01, 0.01, 0.05, 0.9),
    soapy:  LQ(0.3, 0.1, 0.2, 0.01, 0.01, 0.05, 0.9),
    acid:   LQ(0.2, 0.0, 0.1, 0.01, 0.02, 0.05, 0.9),
    magma:  LQ(0.1, 0.0, 0.1, 0.01, 0.01, 0.10, 0.9),
  };

  // A liquid's velocity lives in its `life`, packed as three signed 10-bit
  // fields (x | y << 10 | z << 20) in 1/128 cell per frame, so it travels with
  // the cell through every move and swap. The packed value is never negative,
  // which leaves negative life free for a conductor's spark cool-down.
  const VQ = 128;
  PG.VQ = VQ;
  PG.packV = function (vx, vy, vz) { // dithered rounding: small speeds still decay to 0
    const d = PG.rf();
    let qx = Math.floor(vx * VQ + d), qy = Math.floor(vy * VQ + d), qz = Math.floor(vz * VQ + d);
    qx = qx > 511 ? 511 : qx < -511 ? -511 : qx;
    qy = qy > 511 ? 511 : qy < -511 ? -511 : qy;
    qz = qz > 511 ? 511 : qz < -511 ? -511 : qz;
    return (qx & 1023) | ((qy & 1023) << 10) | ((qz & 1023) << 20);
  };
  // fast uniform float in [0, 1)
  let rs = 0x2545f491;
  PG.rf = function () {
    rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
    return (rs >>> 0) * 2.3283064365386963e-10;
  };

  // Classic liquid step for one 2D cell (Powder Game's liquid update + blow).
  PG.liquid = function (x, y, i, P) {
    if (PG.fluidMode) { PG.fluidAdd(x, y, 0); return; }    // fluid.js moves it
    const W = PG.W, type = PG.type, life = PG.life, rf = PG.rf;
    const l = life[i], cooling = l < 0 && P.cond;
    let vx = 0, vy = 0;
    if (l > 0) { vx = ((l << 22) >> 22) / VQ; vy = ((l << 12) >> 22) / VQ; }
    const ax = air.velX(x, y), ay = air.velY(x, y);
    vx += P.adv * ax; vy += P.adv * ay;
    if (y + 1 >= PG.H || type[i + W] !== 0) {               // resting on something
      if (PG.waveSurface(x, y)) return;
      if (x > 0 && type[i - 1] === 0) vx -= P.x1 + P.xs * rf();
      if (x < W - 1 && type[i + 1] === 0) vx += P.x1 + P.xs * rf();
    }
    vx += (rf() * 2 - 1) * P.xr;
    vy += P.y1 + P.ys * rf();
    vx *= P.frc; vy *= P.frc;
    // the air carries the liquid too; soft cap keeps a step under 3.8 cells
    let dx = ax + vx, dy = ay + vy;
    const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
    const s = 3.8 / ((adx > ady ? adx + 0.5 * ady : ady + 0.5 * adx) + 1);
    // whole cells, plus one more with the leftover fraction as its chance;
    // stepped cell by cell, so fast liquid can't tunnel through a thin wall
    let cx = x, cy = y;
    const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    for (let k = (adx * s + rf()) | 0; k > 0; k--) {
      if (!PG.tryMove(cx, cy, cx + sx, cy)) break;
      cx += sx;
    }
    for (let k = (ady * s + rf()) | 0; k > 0; k--) {
      if (!PG.tryMove(cx, cy, cx, cy + sy)) break;
      cy += sy;
      if (sy > 0) PG.dragAir(cx, cy, 0, 1);
    }
    if (!cooling) life[cy * W + cx] = PG.packV(vx, vy, 0);
  };

  // Waves: a traveling sinusoid that herds resting surface liquid into crests,
  // so a body of water gathers into humps that roll across it. 0 = off.
  // With probability WAVE_HOLD[str]/256 the wave owns a surface cell's turn:
  // on a slope it pushes the cell toward the nearest crest; at a crest or
  // trough it holds the cell still. The rest of the time the liquid levels as
  // usual, so the strength sets how tall crests stand against gravity. Net
  // transport is ~zero because the forcing is symmetric about each crest.
  // Where the surface is open the cell slides sideways; on a level pool it
  // rides up onto the next column, but only onto the same liquid, so a crest
  // never walks up a wall. Only wave-sized relief is herded: a cell standing
  // more than WAVE_AMP rows above the surface half a wavelength away (a
  // trough) or a full wavelength away (the same phase, so level in a true
  // wave) is part of a heap, not a wave, and is left to gravity — so poured
  // liquid levels at full speed and crest height is capped per strength.
  // `life` is left alone: saltwater/mercury keep spark state there, and a
  // momentum liquid's heading travels with the cell. Returns true when the
  // wave used the turn (moved or held the cell).
  PG.waveStr = 1;
  const WAVE_K = 0.20, WAVE_SPEED = 0.05, WAVE_HALF = 16; // HALF ≈ π / K
  const WAVE_HOLD = [0, 130, 236], WAVE_AMP = [0, 4, 7];
  PG.WAVE = { K: WAVE_K, SPEED: WAVE_SPEED, HALF: WAVE_HALF, HOLD: WAVE_HOLD, AMP: WAVE_AMP }; // shared with 3D
  PG.waveSurface = function (x, y) {
    if (!PG.waveStr || !PG.isEmpty(x, y - 1)) return false; // surface cells only
    const a = WAVE_AMP[PG.waveStr], h = WAVE_HALF, f = 2 * WAVE_HALF;
    if (PG.isEmpty(x - h, y + a) || PG.isEmpty(x + h, y + a) ||
        PG.isEmpty(x - f, y + a) || PG.isEmpty(x + f, y + a)) return false; // a heap: gravity's job
    if (PG.rand(256) >= WAVE_HOLD[PG.waveStr]) return false;
    const c = Math.cos(x * WAVE_K - PG.frame * WAVE_SPEED);   // >0: crest lies to +x
    if (c < 0.3 && c > -0.3) return true;                     // on a crest/trough: hold
    const d = c > 0 ? 1 : -1;
    if (!PG.tryMove(x, y, x + d, y) && PG.get(x + d, y) === PG.type[y * PG.W + x]) {
      PG.tryMove(x, y, x + d, y - 1);
    }
    return true;
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
    if (PG.fluidMode) PG.fluidStep(false);

    if (PG.player) PG.player.update();
  };
})();
