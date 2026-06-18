// Per-element behavior functions: PG.behaviors[id] = fn(x, y, cellIndex)
(function () {
  const E = PG.E, els = PG.elements, air = PG.air;
  const b = PG.behaviors;
  const N4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const N8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  const DIR8 = N8; // reused as compass for fans/birds/lasers

  // Initial life value when an element is created (UI + clone + behaviors).
  PG.initLife = function (t) {
    switch (t) {
      case E.FIRE: return 30 + PG.rand(30);
      case E.STEAM: return 150 + PG.rand(150);
      case E.BUBBLE: return 60 + PG.rand(80);
      case E.SPARK: return 20 << 8;
      case E.VIRUS: return (60 + PG.rand(60)) << 8;
      case E.FIREWORK: return 25 + PG.rand(20);
      case E.BIRD: return PG.rand(8);
      case E.FISH: return 200;
      case E.VINE: return 8 + PG.rand(14);
      case E.ANT: return PG.rand(4); // random heading; handedness 0, uncharged
      default: return 0;
    }
  };

  // Try to set something on fire / detonate it.
  function ignite(x, y, force) {
    const t = PG.get(x, y);
    if (t === E.BLOCK) return;
    const el = els[t];
    if (!el || !el.burn) return;
    if (!force && PG.rand(256) >= el.burn) return;
    if (t === E.C4) return PG.explode(x, y, 11, 9);
    if (t === E.NITRO) return PG.explode(x, y, 8, 7);
    if (t === E.GPOWDER) return PG.explode(x, y, 4, 5);
    const i = PG.idx(x, y);
    if (t === E.GAS) {
      air.addPressure(x, y, 3);
      PG.type[i] = E.FIRE; PG.life[i] = 20 + PG.rand(20);
      return;
    }
    let l = 40 + PG.rand(40);             // generic burn time
    if (t === E.WOOD) l = 130 + PG.rand(120);
    if (t === E.FUSE) l = 75;             // steady, slow-traveling burn
    if (t === E.OIL) l = 60 + PG.rand(60);
    PG.type[i] = E.FIRE; PG.life[i] = l;
  }
  PG.ignite = ignite;

  // ---- powders ----------------------------------------------------------
  b[E.POWDER] = (x, y) => PG.doPowder(x, y);
  b[E.SALT] = (x, y) => PG.doPowder(x, y);
  b[E.GPOWDER] = (x, y) => PG.doPowder(x, y);

  b[E.STONE] = (x, y) => { // heavy: falls straight, barely wind-affected
    if (PG.tryMove(x, y, x, y + 1)) return;
    if (PG.chance(4)) PG.tryMove(x, y, x + (PG.rand(2) ? 1 : -1), y + 1);
  };

  b[E.SNOW] = (x, y, i) => {
    for (const [dx, dy] of N4) {
      const t = PG.get(x + dx, y + dy);
      if ((t === E.WATER || t === E.SALTWATER) && PG.chance(20)) {
        PG.type[i] = E.WATER; PG.life[i] = 0; return;
      }
    }
    if (PG.windPush(x, y, 2.5)) return;
    if (PG.chance(2)) PG.doPowder(x, y);
  };

  b[E.SEED] = (x, y, i) => {
    for (const [dx, dy] of N4) {
      const t = PG.get(x + dx, y + dy);
      if (t === E.WATER || t === E.SALTWATER) {
        PG.type[i] = E.VINE; PG.life[i] = PG.initLife(E.VINE); return;
      }
    }
    PG.doPowder(x, y);
  };

  b[E.BOMB] = (x, y, i) => {
    PG.life[i]++;
    if (PG.life[i] > 6) { // armed: detonate on contact with anything
      for (const [dx, dy] of N4) {
        const t = PG.get(x + dx, y + dy);
        if (t !== 0 && t !== E.BOMB) { PG.explode(x, y, 7, 7); return; }
      }
    }
    PG.doPowder(x, y);
  };

  // ---- liquids ----------------------------------------------------------
  b[E.WATER] = (x, y, i) => {
    if (PG.chance(8)) {
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy, t = PG.get(nx, ny);
        if (t === E.SALT) { PG.set(nx, ny, 0, 0); PG.type[i] = E.SALTWATER; break; }
      }
    }
    PG.doLiquid(x, y, 8); // settling liquid; 8 = Classic reach (Fluid scans far)
  };
  b[E.SALTWATER] = (x, y, i) => {
    if (PG.life[i] < 0) PG.life[i]++; // spark refractory cooldown
    PG.doLiquid(x, y, 4);
  };
  b[E.OIL] = (x, y, i) => PG.doLiquid(x, y, 4);
  b[E.MERCURY] = (x, y, i) => {
    if (PG.life[i] < 0) PG.life[i]++;
    PG.doLiquid(x, y, 3);
  };
  b[E.NITRO] = (x, y, i) => PG.flowLiquid(x, y, i, 5);

  b[E.ACID] = (x, y, i) => {
    if (PG.chance(4)) {
      const [dx, dy] = N4[PG.rand(4)];
      const nx = x + dx, ny = y + dy, t = PG.get(nx, ny);
      if (t !== 0 && t !== E.ACID && t !== E.GLASS && t !== E.BLOCK && t !== E.CLONE) {
        PG.set(nx, ny, 0, 0);
        if (PG.chance(3)) { PG.type[i] = 0; PG.life[i] = 0; return; }
      }
    }
    PG.flowLiquid(x, y, i, 5);
  };

  b[E.SOAPY] = (x, y, i) => {
    const w = Math.abs(air.velX(x, y)) + Math.abs(air.velY(x, y));
    if (w > 1.6 && PG.chance(6)) {
      PG.type[i] = E.BUBBLE; PG.life[i] = PG.initLife(E.BUBBLE); return;
    }
    PG.flowLiquid(x, y, i, 5);
  };

  b[E.MAGMA] = (x, y, i) => {
    if (PG.chance(2)) {
      const [dx, dy] = N4[PG.rand(4)];
      const nx = x + dx, ny = y + dy, t = PG.get(nx, ny);
      if (t === E.WATER || t === E.SALTWATER) {
        PG.set(nx, ny, E.STEAM, PG.initLife(E.STEAM));
        PG.type[i] = E.STONE; PG.life[i] = 0; return;
      } else if (t === E.POWDER || t === E.SALT) {
        if (PG.chance(6)) PG.set(nx, ny, E.GLASS, 0);
      } else if (t === E.ICE || t === E.SNOW) {
        PG.set(nx, ny, E.WATER, 0);
      } else if (t === E.METAL) {
        if (PG.chance(100)) PG.set(nx, ny, E.MAGMA, 0);
      } else if (t === E.STONE) {
        if (PG.chance(60)) PG.set(nx, ny, E.MAGMA, 0);
      } else ignite(nx, ny);
    }
    if (PG.chance(24) && PG.isEmpty(x, y - 1)) PG.set(x, y - 1, E.FIRE, 14 + PG.rand(10));
    PG.doLiquid(x, y, 2);
  };

  // ---- gases --------------------------------------------------------------
  b[E.GAS] = (x, y) => PG.doGas(x, y);

  b[E.STEAM] = (x, y, i) => {
    if (--PG.life[i] <= 0) { PG.type[i] = E.WATER; PG.life[i] = 0; return; }
    PG.doGas(x, y);
  };

  b[E.BUBBLE] = (x, y, i) => {
    if (--PG.life[i] <= 0) { PG.type[i] = 0; PG.life[i] = 0; return; }
    if (PG.windPush(x, y, 3)) return;
    if (!PG.tryMove(x, y, x + PG.rand(3) - 1, y - 1)) {
      if (PG.chance(4)) { PG.type[i] = 0; PG.life[i] = 0; } // pop on ceiling
    }
  };

  // ---- energy -------------------------------------------------------------
  b[E.FIRE] = (x, y, i) => {
    if (--PG.life[i] <= 0) { PG.type[i] = 0; PG.life[i] = 0; return; }
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy, t = PG.get(nx, ny);
      if (t === E.WATER || t === E.SALTWATER) {
        PG.type[i] = E.STEAM; PG.life[i] = PG.initLife(E.STEAM); return;
      }
      if ((t === E.ICE || t === E.SNOW) && PG.chance(3)) PG.set(nx, ny, E.WATER, 0);
      else if (t !== 0) ignite(nx, ny);
    }
    if (PG.chance(4)) air.addVel(x, y, 0, -0.3);   // heat rises
    if (PG.chance(5)) air.addPressure(x, y, 0.5);  // burning raises pressure
    if (PG.life[i] > 60) { // anchored burn (wood, fuse...): doesn't float away
      if (PG.life[i] > 70 && PG.chance(5) && PG.isEmpty(x, y - 1)) {
        PG.set(x, y - 1, E.FIRE, 12 + PG.rand(16));
      }
      return;
    }
    // free flame: rises, but leans into the wind so fire blows sideways
    const wx = air.velX(x, y);
    let dx = PG.rand(3) - 1;
    if (Math.abs(wx) > 1 && PG.chance(2)) dx = wx > 0 ? 1 : -1;
    PG.tryMove(x, y, x + dx, y - 1);
  };

  const CONDUCTS = {};
  CONDUCTS[E.METAL] = 1; CONDUCTS[E.MERCURY] = 1; CONDUCTS[E.SALTWATER] = 1;

  b[E.METAL] = (x, y, i) => { if (PG.life[i] < 0) PG.life[i]++; };
  b[E.SPARK] = (x, y, i) => {
    const timer = (PG.life[i] >> 8) - 1;
    const orig = PG.life[i] & 255;
    if (timer <= 0) { // restore the conductor, brief refractory period
      PG.type[i] = orig; PG.life[i] = orig ? -14 : 0; return;
    }
    PG.life[i] = (timer << 8) | orig;
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (!PG.inBounds(nx, ny)) continue;
      const j = PG.idx(nx, ny), t = PG.type[j];
      if (CONDUCTS[t] && PG.life[j] >= 0 && PG.chance(2)) {
        PG.type[j] = E.SPARK; PG.life[j] = (5 << 8) | t;
        PG.updated[j] = PG.stamp;
      } else if (t !== 0) ignite(nx, ny);
    }
    if (!orig && PG.chance(2)) PG.tryMove(x, y, x + PG.rand(3) - 1, y + PG.rand(3) - 1);
  };

  b[E.THUNDER] = (x, y, i) => {
    // bolt: streak downward fast with jitter, blast on impact
    let cx = x, cy = y;
    PG.type[i] = 0; PG.life[i] = 0;
    for (let s = 0; s < 7; s++) {
      const nx = cx + PG.rand(3) - 1, ny = cy + 1;
      if (!PG.inBounds(nx, ny) || !PG.isEmpty(nx, ny)) {
        // strike!
        air.blast(cx, cy, 8, 6);
        for (const [dx, dy] of N8) {
          const tx = cx + dx, ty = cy + dy;
          const t = PG.get(tx, ty);
          if (t === 0 && PG.chance(2)) PG.set(tx, ty, E.SPARK, 6 << 8);
          else if (CONDUCTS[t]) PG.set(tx, ty, E.SPARK, (8 << 8) | t);
          else ignite(tx, ty, true);
        }
        return;
      }
      cx = nx; cy = ny;
      if (s === 6) PG.set(cx, cy, E.THUNDER, 0); // keep falling next frame
      else if (PG.chance(2)) {
        PG.set(cx, cy, E.SPARK, 2 << 8); // glowing trail
        PG.updated[PG.idx(cx, cy)] = PG.stamp;
        PG.type[PG.idx(cx, cy)] = s < 6 ? 0 : E.THUNDER;
      }
    }
  };

  b[E.LASER] = (x, y, i) => {
    // life = direction index into DIR8
    const d = DIR8[PG.life[i] & 7];
    let cx = x, cy = y;
    PG.type[i] = 0;
    const dirLife = PG.life[i]; PG.life[i] = 0;
    for (let s = 0; s < 5; s++) {
      let nx = cx + d[0], ny = cy + d[1];
      let t = PG.get(nx, ny);
      while (t === E.GLASS) { nx += d[0]; ny += d[1]; t = PG.get(nx, ny); }
      if (t !== 0) { // hit something
        air.addPressure(nx, ny, 1.5);
        ignite(nx, ny, true);
        return;
      }
      if (!PG.inBounds(nx, ny)) return;
      cx = nx; cy = ny;
    }
    PG.set(cx, cy, E.LASER, dirLife);
  };

  b[E.VIRUS] = (x, y, i) => {
    let timer = (PG.life[i] >> 8) - 1;
    const orig = PG.life[i] & 255;
    if (timer <= 0) {
      PG.type[i] = PG.chance(2) ? orig : 0; PG.life[i] = 0; return;
    }
    PG.life[i] = (timer << 8) | orig;
    if (PG.chance(3)) {
      const [dx, dy] = N8[PG.rand(8)];
      const nx = x + dx, ny = y + dy;
      if (!PG.inBounds(nx, ny)) return;
      const j = PG.idx(nx, ny), t = PG.type[j];
      if (t !== 0 && t !== E.VIRUS && t !== E.BLOCK && t !== E.GLASS) {
        PG.type[j] = E.VIRUS;
        PG.life[j] = ((40 + PG.rand(80)) << 8) | t;
      }
    }
    if (PG.chance(4)) PG.doPowder(x, y);
  };

  b[E.FIREWORK] = (x, y, i) => {
    let l = PG.life[i];
    if (l > 0) { // ascending
      PG.life[i] = --l;
      if (l <= 0 || !PG.tryMove(x, y, x + (PG.chance(4) ? PG.rand(3) - 1 : 0), y - 1)) {
        // burst!
        air.blast(x, y, 6, 3);
        PG.type[i] = 0; PG.life[i] = 0;
        for (let k = 0; k < 26; k++) {
          const a = PG.rand(360) * Math.PI / 180, r = 1 + PG.rand(5);
          const sx = Math.round(x + Math.cos(a) * r), sy = Math.round(y + Math.sin(a) * r);
          if (PG.isEmpty(sx, sy)) {
            PG.set(sx, sy, E.FIREWORK, -(((20 + PG.rand(25)) << 4) | PG.rand(6)));
          }
        }
      }
      return;
    }
    // spark mode: life = -((ttl<<4)|color)
    let v = -l, ttl = (v >> 4) - 1, col = v & 15;
    if (ttl <= 0) { PG.type[i] = 0; PG.life[i] = 0; return; }
    PG.life[i] = -((ttl << 4) | col);
    if (PG.windPush(x, y, 2)) return;
    if (PG.chance(2)) PG.tryMove(x, y, x + PG.rand(3) - 1, y + 1);
  };

  // ---- static / generators -------------------------------------------------
  b[E.FAN] = (x, y, i) => {
    const d = DIR8[PG.life[i] & 7];
    air.addVel(x, y, d[0] * 0.45, d[1] * 0.45);
  };

  b[E.PUMP] = (x, y) => {
    air.addPressure(x, y, -1.2);
    if (PG.chance(2)) {
      const [dx, dy] = N4[PG.rand(4)];
      const nx = x + dx, ny = y + dy, t = PG.get(nx, ny);
      if (t !== 0 && !PG.isSolid(t)) PG.set(nx, ny, 0, 0);
    }
  };

  b[E.CLONE] = (x, y, i) => {
    if (PG.life[i] === 0) {
      for (const [dx, dy] of N8) {
        const t = PG.get(x + dx, y + dy);
        if (t !== 0 && t !== E.CLONE && t !== E.BLOCK && t !== E.SPARK) {
          PG.life[i] = t; break;
        }
      }
    } else if (PG.chance(4)) {
      const t = PG.life[i];
      const [dx, dy] = N8[PG.rand(8)];
      const nx = x + dx, ny = y + dy;
      if (PG.isEmpty(nx, ny)) PG.set(nx, ny, t, PG.initLife(t));
    }
  };

  b[E.TORCH] = (x, y) => {
    if (PG.chance(3)) {
      const [dx, dy] = N4[PG.rand(4)];
      if (PG.isEmpty(x + dx, y + dy)) PG.set(x + dx, y + dy, E.FIRE, 16 + PG.rand(20));
    }
  };

  b[E.ICE] = (x, y) => {
    if (PG.chance(140)) {
      const [dx, dy] = N4[PG.rand(4)];
      const nx = x + dx, ny = y + dy;
      if (PG.get(nx, ny) === E.WATER) PG.set(nx, ny, E.ICE, 0);
    }
  };

  b[E.VINE] = (x, y, i) => {
    if (PG.life[i] <= 0) return;
    if (PG.chance(8)) {
      const dirs = [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0]];
      const [dx, dy] = dirs[PG.rand(5)];
      const nx = x + dx, ny = y + dy;
      if (PG.isEmpty(nx, ny)) {
        PG.set(nx, ny, E.VINE, PG.life[i] - 1);
        PG.life[i] = Math.max(0, PG.life[i] - 2);
      }
    }
  };

  b[E.CLOUD] = (x, y, i) => {
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (PG.get(nx, ny) === E.STEAM) { PG.set(nx, ny, 0, 0); PG.life[i]++; }
    }
    if (PG.life[i] > 6 && PG.chance(5) && PG.isEmpty(x, y + 1)) {
      PG.set(x, y + 1, E.WATER, 0);
      PG.life[i] -= 3;
    }
  };

  // ---- creatures ------------------------------------------------------------
  function hazardDeath(x, y, i) {
    for (const [dx, dy] of N4) {
      const t = PG.get(x + dx, y + dy);
      if (t === E.FIRE || t === E.ACID || t === E.MAGMA || t === E.VIRUS) {
        PG.type[i] = E.FIRE; PG.life[i] = 20; return true;
      }
    }
    return false;
  }

  // Powder-Game ants: they spread as they fall (like a liquid), wander back
  // and forth on the ground, and — the signature behaviour — FOLLOW walls,
  // tracing around and climbing any surface (a Langton's-ant style
  // wall-follower keeping a surface on one side). life packs heading (low 2
  // bits, index into ANT_DIRS) and handedness (bit 2: 0 = right-hand).
  // A "charged" ant carries a solid it stepped on and builds tunnels/patterns
  // of it. life packs: heading (bits 0-1) | handedness (bit 2) | charged
  // element id (bits 3-8, 0 = uncharged).
  const ANT_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // CW: right,down,left,up
  const ANT_DIAG = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
  function antSurface(t) { // something an ant can stand on / crawl along
    if (t === 0) return false;
    const s = els[t].state;
    return s === "static" || s === "powder";
  }
  // the only solids an ant can charge with, per Powder Game
  const ANT_CHARGEABLE = {};
  [E.C4, E.ICE, E.VINE, E.WOOD, E.METAL, E.GLASS, E.FUSE, E.PUMP].forEach(t => ANT_CHARGEABLE[t] = 1);
  const antChargeOf = (i) => (PG.life[i] >> 3) & 63; // charged element of an ant cell
  // free-dot budget: auto-building stops when the field is nearly full
  // (mirrors Powder Game's "stops at 999 available dots")
  function antCanBuild() {
    return (PG.W * PG.H - PG.partCount) > PG.W * PG.H * 0.02;
  }
  b[E.ANT] = (x, y, i) => {
    if (hazardDeath(x, y, i)) return;
    if (PG.chance(2)) for (const [dx, dy] of N4) { // drown in water, eventually
      const t = PG.get(x + dx, y + dy);
      if ((t === E.WATER || t === E.SALTWATER) && PG.chance(20)) { PG.type[i] = 0; return; }
    }

    let h = PG.life[i] & 3, hand = (PG.life[i] >> 2) & 1, charged = (PG.life[i] >> 3) & 63;
    // become charged ONLY when sitting directly on a chargeable solid ("over top")
    if (!charged && y + 1 < PG.H) {
      const below = PG.type[(y + 1) * PG.W + x];
      if (ANT_CHARGEABLE[below]) charged = below;
    }
    // two charged ants that meet annihilate each other
    if (charged) for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (PG.get(nx, ny) === E.ANT && antChargeOf(ny * PG.W + nx)) {
        PG.set(nx, ny, 0, 0); PG.type[i] = 0; PG.life[i] = 0; return;
      }
    }

    // supported = a crawlable surface in the 8-neighbourhood (diagonal contact
    // counts, so ants hug walls and round convex corners). Test below/sides/up
    // first — most ants rest on the ground, so this short-circuits at once.
    let supported = antSurface(PG.get(x, y + 1)) || antSurface(PG.get(x, y - 1)) ||
                    antSurface(PG.get(x - 1, y)) || antSurface(PG.get(x + 1, y));
    if (!supported) for (const [dx, dy] of ANT_DIAG) if (antSurface(PG.get(x + dx, y + dy))) { supported = true; break; }
    if (!supported) { // airborne: uncharged ants blow in the wind, charged don't
      PG.life[i] = h | (hand << 2) | (charged << 3);
      if (!charged && PG.windPush(x, y, 1)) return;
      if (PG.tryMove(x, y, x, y + 1)) return;
      const d = PG.rand(2) ? 1 : -1;
      if (PG.tryMove(x, y, x + d, y + 1)) return;
      PG.tryMove(x, y, x - d, y + 1);
      return;
    }

    // Charged ants move deterministically (Langton's-ant style — this is what
    // produces the ordered build patterns). Uncharged ants wander back and
    // forth on surfaces via an occasional about-face.
    if (!charged && PG.chance(45)) { hand ^= 1; h = (h + 2) & 3; }

    // wall-follow: turn toward the followed side first, then straight, then
    // away, then back — the first open cell wins.
    const order = hand === 0 ? [1, 0, 3, 2] : [3, 0, 1, 2];
    for (const off of order) {
      const nh = (h + off) & 3;
      const nx = x + ANT_DIRS[nh][0], ny = y + ANT_DIRS[nh][1];
      if (PG.get(nx, ny) === 0) {
        PG.life[i] = nh | (hand << 2) | (charged << 3);
        PG.tryMove(x, y, nx, ny);
        // charged ant lays its solid in the cell it just left, building tunnels
        if (charged && PG.type[i] === 0 && antCanBuild()) PG.set(x, y, charged, PG.initLife(charged));
        return;
      }
    }
    // boxed in by solids: a charged ant BURROWS through them (any element but
    // fan), demolishing as it tunnels; an uncharged ant only gnaws powder.
    if (charged) {
      // plow forward (straight, then turns) — never reverse into our own trail
      for (const off of [0, 1, 3]) {
        const nh = (h + off) & 3;
        const bx = x + ANT_DIRS[nh][0], by = y + ANT_DIRS[nh][1];
        if (!PG.inBounds(bx, by)) continue;
        const bt = PG.type[by * PG.W + bx];
        if (bt !== 0 && bt !== E.FAN && bt !== E.ANT) {
          PG.set(bx, by, 0, 0);                       // demolish the obstacle
          PG.life[i] = nh | (charged << 3);
          PG.tryMove(x, y, bx, by);                   // tunnel into it
          if (PG.type[i] === 0 && antCanBuild()) PG.set(x, y, charged, PG.initLife(charged));
          return;
        }
      }
    } else {
      const ax = x + ANT_DIRS[h][0], ay = y + ANT_DIRS[h][1], ahead = PG.get(ax, ay);
      if (els[ahead] && els[ahead].state === "powder" && PG.chance(3)) PG.set(ax, ay, 0, 0);
    }
    PG.life[i] = h | (hand << 2) | (charged << 3);
  };

  b[E.BIRD] = (x, y, i) => {
    if (hazardDeath(x, y, i)) return;
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy, t = PG.get(nx, ny);
      if (t === E.WATER || t === E.SALTWATER) { PG.type[i] = 0; return; }
      if (t === E.ANT) PG.set(nx, ny, 0, 0); // birds destroy ants
    }
    if (PG.chance(6)) PG.life[i] = PG.rand(8); // wander
    const d = DIR8[PG.life[i] & 7];
    if (!PG.tryMove(x, y, x + d[0], y + d[1])) PG.life[i] = PG.rand(8);
  };

  b[E.FISH] = (x, y, i) => {
    if (hazardDeath(x, y, i)) return;
    let inWater = false;
    for (const [dx, dy] of N4) {
      const t = PG.get(x + dx, y + dy);
      if (t === E.WATER || t === E.SALTWATER) { inWater = true; break; }
    }
    if (inWater) {
      PG.life[i] = 200;
      const [dx, dy] = N4[PG.rand(4)];
      const nx = x + dx, ny = y + dy;
      const t = PG.get(nx, ny);
      if (t === E.WATER || t === E.SALTWATER) {
        const j = PG.idx(nx, ny);
        PG.type[j] = E.FISH; PG.life[j] = 200;
        PG.type[i] = t; PG.life[i] = 0;
        PG.updated[j] = PG.stamp;
      }
    } else {
      if (--PG.life[i] <= 0) { PG.type[i] = 0; PG.life[i] = 0; return; }
      PG.doPowder(x, y); // flop
    }
  };
})();
