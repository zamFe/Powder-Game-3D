// 3D element behaviors: PG.behaviors3[id] = fn(x, y, z, cellIndex)
(function () {
  const E = PG.E, els = PG.elements, air3 = PG.air3;
  const b = PG.behaviors3 = [];
  const N6 = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  const DIR8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

  function ignite3(x, y, z, force) {
    const t = PG.get3(x, y, z);
    if (t === E.BLOCK) return;
    const el = els[t];
    if (!el || !el.burn) return;
    if (!force && PG.rand(256) >= el.burn) return;
    if (t === E.C4) return PG.explode3(x, y, z, 9, 9);
    if (t === E.NITRO) return PG.explode3(x, y, z, 7, 7);
    if (t === E.GPOWDER) return PG.explode3(x, y, z, 4, 5);
    if (t === E.GAS) {
      air3.addPressure(x, y, z, 3);
      PG.set3(x, y, z, E.FIRE, 20 + PG.rand(20));
      return;
    }
    let l = 40 + PG.rand(40);
    if (t === E.WOOD) l = 130 + PG.rand(120);
    if (t === E.FUSE) l = 75;
    if (t === E.OIL) l = 60 + PG.rand(60);
    PG.set3(x, y, z, E.FIRE, l);
  }

  // ---- powders ----
  b[E.POWDER] = (x, y, z) => PG.doPowder3(x, y, z);
  b[E.SALT] = (x, y, z) => PG.doPowder3(x, y, z);
  b[E.GPOWDER] = (x, y, z) => PG.doPowder3(x, y, z);
  b[E.STONE] = (x, y, z) => {
    if (PG.tryMove3(x, y, z, x, y + 1, z)) return;
    if (PG.chance(4)) {
      const [dx, dz] = PG.HDIRS3[PG.rand(4)];
      PG.tryMove3(x, y, z, x + dx, y + 1, z + dz);
    }
  };
  b[E.SNOW] = (x, y, z, i) => {
    for (const [dx, dy, dz] of N6) {
      const t = PG.get3(x + dx, y + dy, z + dz);
      if ((t === E.WATER || t === E.SALTWATER) && PG.chance(20)) {
        PG.t3[i] = E.WATER; PG.l3[i] = 0; return;
      }
    }
    if (PG.windPush3(x, y, z, 2.5)) return;
    if (PG.chance(2)) PG.doPowder3(x, y, z);
  };
  b[E.SEED] = (x, y, z, i) => {
    for (const [dx, dy, dz] of N6) {
      const t = PG.get3(x + dx, y + dy, z + dz);
      if (t === E.WATER || t === E.SALTWATER) {
        PG.t3[i] = E.VINE; PG.l3[i] = PG.initLife(E.VINE); return;
      }
    }
    PG.doPowder3(x, y, z);
  };
  b[E.BOMB] = (x, y, z, i) => {
    PG.l3[i]++;
    if (PG.l3[i] > 6) {
      for (const [dx, dy, dz] of N6) {
        const t = PG.get3(x + dx, y + dy, z + dz);
        if (t !== 0 && t !== E.BOMB) { PG.explode3(x, y, z, 6, 7); return; }
      }
    }
    PG.doPowder3(x, y, z);
  };

  // ---- liquids ----
  b[E.WATER] = (x, y, z, i) => {
    if (PG.chance(8)) {
      for (const [dx, dy, dz] of N6) {
        if (PG.get3(x + dx, y + dy, z + dz) === E.SALT) {
          PG.set3(x + dx, y + dy, z + dz, 0, 0);
          PG.t3[i] = E.SALTWATER; break;
        }
      }
    }
    PG.doLiquid3(x, y, z, 8); // settling liquid; 8 = Classic reach (Fluid scans far)
  };
  b[E.SALTWATER] = (x, y, z, i) => {
    if (PG.l3[i] < 0) PG.l3[i]++;
    PG.doLiquid3(x, y, z, 4);
  };
  b[E.OIL] = (x, y, z, i) => PG.doLiquid3(x, y, z, 3);
  b[E.MERCURY] = (x, y, z, i) => {
    if (PG.l3[i] < 0) PG.l3[i]++;
    PG.doLiquid3(x, y, z, 3);
  };
  b[E.NITRO] = (x, y, z, i) => PG.flowLiquid3(x, y, z, i, 4);
  b[E.ACID] = (x, y, z, i) => {
    if (PG.chance(4)) {
      const [dx, dy, dz] = N6[PG.rand(6)];
      const t = PG.get3(x + dx, y + dy, z + dz);
      if (t !== 0 && t !== E.ACID && t !== E.GLASS && t !== E.BLOCK && t !== E.CLONE) {
        PG.set3(x + dx, y + dy, z + dz, 0, 0);
        if (PG.chance(3)) { PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z); return; }
      }
    }
    PG.flowLiquid3(x, y, z, i, 4);
  };
  b[E.SOAPY] = (x, y, z, i) => {
    const w = Math.abs(air3.velX(x, y, z)) + Math.abs(air3.velY(x, y, z)) +
              Math.abs(air3.velZ(x, y, z));
    if (w > 1.6 && PG.chance(6)) {
      PG.t3[i] = E.BUBBLE; PG.l3[i] = PG.initLife(E.BUBBLE); return;
    }
    PG.flowLiquid3(x, y, z, i, 4);
  };
  b[E.MAGMA] = (x, y, z, i) => {
    if (PG.chance(2)) {
      const [dx, dy, dz] = N6[PG.rand(6)];
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const t = PG.get3(nx, ny, nz);
      if (t === E.WATER || t === E.SALTWATER) {
        PG.set3(nx, ny, nz, E.STEAM, PG.initLife(E.STEAM));
        PG.t3[i] = E.STONE; PG.l3[i] = 0; return;
      } else if (t === E.POWDER || t === E.SALT) {
        if (PG.chance(6)) PG.set3(nx, ny, nz, E.GLASS, 0);
      } else if (t === E.ICE || t === E.SNOW) {
        PG.set3(nx, ny, nz, E.WATER, 0);
      } else if (t === E.METAL) {
        if (PG.chance(100)) PG.set3(nx, ny, nz, E.MAGMA, 0);
      } else if (t === E.STONE) {
        if (PG.chance(60)) PG.set3(nx, ny, nz, E.MAGMA, 0);
      } else ignite3(nx, ny, nz);
    }
    if (PG.chance(24) && PG.isEmpty3(x, y - 1, z)) PG.set3(x, y - 1, z, E.FIRE, 14 + PG.rand(10));
    PG.doLiquid3(x, y, z, 2);
  };

  // ---- gases ----
  b[E.GAS] = (x, y, z) => PG.doGas3(x, y, z);
  b[E.STEAM] = (x, y, z, i) => {
    if (--PG.l3[i] <= 0) { PG.t3[i] = E.WATER; PG.l3[i] = 0; return; }
    PG.doGas3(x, y, z);
  };
  b[E.BUBBLE] = (x, y, z, i) => {
    if (--PG.l3[i] <= 0) { PG.t3[i] = 0; PG.cellGone3(x, y, z); return; }
    if (PG.windPush3(x, y, z, 3)) return;
    if (!PG.tryMove3(x, y, z, x + PG.rand(3) - 1, y - 1, z + PG.rand(3) - 1)) {
      if (PG.chance(4)) { PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z); }
    }
  };

  // ---- energy ----
  b[E.FIRE] = (x, y, z, i) => {
    if (--PG.l3[i] <= 0) { PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z); return; }
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const t = PG.get3(nx, ny, nz);
      if (t === E.WATER || t === E.SALTWATER) {
        PG.t3[i] = E.STEAM; PG.l3[i] = PG.initLife(E.STEAM); return;
      }
      if ((t === E.ICE || t === E.SNOW) && PG.chance(3)) PG.set3(nx, ny, nz, E.WATER, 0);
      else if (t !== 0) ignite3(nx, ny, nz);
    }
    if (PG.chance(4)) air3.addVel(x, y, z, 0, -0.3, 0);  // heat rises
    if (PG.chance(5)) air3.addPressure(x, y, z, 0.5);    // burning raises pressure
    if (PG.l3[i] > 60) {
      if (PG.l3[i] > 70 && PG.chance(5) && PG.isEmpty3(x, y - 1, z)) {
        PG.set3(x, y - 1, z, E.FIRE, 12 + PG.rand(16));
      }
      return;
    }
    // free flame leans into the wind
    const wx = air3.velX(x, y, z), wz = air3.velZ(x, y, z);
    let dx = PG.rand(3) - 1, dz = PG.rand(3) - 1;
    if (Math.abs(wx) > 1 && PG.chance(2)) dx = wx > 0 ? 1 : -1;
    if (Math.abs(wz) > 1 && PG.chance(2)) dz = wz > 0 ? 1 : -1;
    PG.tryMove3(x, y, z, x + dx, y - 1, z + dz);
  };

  const CONDUCTS = {};
  CONDUCTS[E.METAL] = 1; CONDUCTS[E.MERCURY] = 1; CONDUCTS[E.SALTWATER] = 1;

  b[E.METAL] = (x, y, z, i) => { if (PG.l3[i] < 0) PG.l3[i]++; };
  b[E.SPARK] = (x, y, z, i) => {
    const timer = (PG.l3[i] >> 8) - 1;
    const orig = PG.l3[i] & 255;
    if (timer <= 0) {
      PG.t3[i] = orig; PG.l3[i] = orig ? -14 : 0;
      if (!orig) PG.cellGone3(x, y, z);
      return;
    }
    PG.l3[i] = (timer << 8) | orig;
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (!PG.inBounds3(nx, ny, nz)) continue;
      const j = PG.idx3(nx, ny, nz), t = PG.t3[j];
      if (CONDUCTS[t] && PG.l3[j] >= 0 && PG.chance(2)) {
        PG.t3[j] = E.SPARK; PG.l3[j] = (5 << 8) | t;
        PG.u3[j] = PG.stamp;
      } else if (t !== 0) ignite3(nx, ny, nz);
    }
    if (!orig && PG.chance(2)) {
      PG.tryMove3(x, y, z, x + PG.rand(3) - 1, y + PG.rand(3) - 1, z + PG.rand(3) - 1);
    }
  };

  b[E.THUNDER] = (x, y, z, i) => {
    let cx = x, cy = y;
    PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z);
    for (let s = 0; s < 7; s++) {
      const nx = cx + PG.rand(3) - 1, ny = cy + 1;
      if (!PG.inBounds3(nx, ny, z) || !PG.isEmpty3(nx, ny, z)) {
        air3.blast(cx, cy, z, 7, 6);
        for (const [dx, dy, dz] of N6) {
          const tx = cx + dx, ty = cy + dy, tz = z + dz;
          const t = PG.get3(tx, ty, tz);
          if (t === 0 && PG.chance(2)) PG.set3(tx, ty, tz, E.SPARK, 6 << 8);
          else if (CONDUCTS[t]) PG.set3(tx, ty, tz, E.SPARK, (8 << 8) | t);
          else ignite3(tx, ty, tz, true);
        }
        return;
      }
      cx = nx; cy = ny;
      if (s === 6) PG.set3(cx, cy, z, E.THUNDER, 0);
    }
  };

  b[E.LASER] = (x, y, z, i) => {
    const d = DIR8[PG.l3[i] & 7];
    let cx = x, cy = y;
    const dirLife = PG.l3[i];
    PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z);
    for (let s = 0; s < 5; s++) {
      let nx = cx + d[0], ny = cy + d[1];
      let t = PG.get3(nx, ny, z);
      while (t === E.GLASS) { nx += d[0]; ny += d[1]; t = PG.get3(nx, ny, z); }
      if (t !== 0) {
        air3.addPressure(nx, ny, z, 1.5);
        ignite3(nx, ny, z, true);
        return;
      }
      if (!PG.inBounds3(nx, ny, z)) return;
      cx = nx; cy = ny;
    }
    PG.set3(cx, cy, z, E.LASER, dirLife);
  };

  b[E.VIRUS] = (x, y, z, i) => {
    let timer = (PG.l3[i] >> 8) - 1;
    const orig = PG.l3[i] & 255;
    if (timer <= 0) {
      const keep = PG.chance(2) ? orig : 0;
      PG.t3[i] = keep; PG.l3[i] = 0;
      if (!keep) PG.cellGone3(x, y, z);
      return;
    }
    PG.l3[i] = (timer << 8) | orig;
    if (PG.chance(3)) {
      const [dx, dy, dz] = N6[PG.rand(6)];
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (!PG.inBounds3(nx, ny, nz)) return;
      const j = PG.idx3(nx, ny, nz), t = PG.t3[j];
      if (t !== 0 && t !== E.VIRUS && t !== E.BLOCK && t !== E.GLASS) {
        PG.t3[j] = E.VIRUS;
        PG.l3[j] = ((40 + PG.rand(80)) << 8) | t;
        PG.wake3(nx, ny, nz); // an infected (maybe sleeping) cell must run
      }
    }
    if (PG.chance(4)) PG.doPowder3(x, y, z);
  };

  b[E.FIREWORK] = (x, y, z, i) => {
    let l = PG.l3[i];
    if (l > 0) {
      PG.l3[i] = --l;
      if (l <= 0 || !PG.tryMove3(x, y, z, x, y - 1, z)) {
        air3.blast(x, y, z, 6, 3);
        PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z);
        for (let k = 0; k < 30; k++) {
          const a = PG.rand(360) * Math.PI / 180, e = PG.rand(180) * Math.PI / 180;
          const r = 1 + PG.rand(5);
          const sx = Math.round(x + Math.cos(a) * Math.sin(e) * r);
          const sy = Math.round(y + Math.cos(e) * r);
          const sz = Math.round(z + Math.sin(a) * Math.sin(e) * r);
          if (PG.isEmpty3(sx, sy, sz)) {
            PG.set3(sx, sy, sz, E.FIREWORK, -(((20 + PG.rand(25)) << 4) | PG.rand(6)));
          }
        }
      }
      return;
    }
    let v = -l, ttl = (v >> 4) - 1, col = v & 15;
    if (ttl <= 0) { PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z); return; }
    PG.l3[i] = -((ttl << 4) | col);
    if (PG.windPush3(x, y, z, 2)) return;
    if (PG.chance(2)) PG.tryMove3(x, y, z, x + PG.rand(3) - 1, y + 1, z + PG.rand(3) - 1);
  };

  // ---- static / generators ----
  b[E.FAN] = (x, y, z, i) => {
    const d = DIR8[PG.l3[i] & 7];
    air3.addVel(x, y, z, d[0] * 0.45, d[1] * 0.45, 0);
  };
  b[E.PUMP] = (x, y, z) => {
    air3.addPressure(x, y, z, -1.2);
    if (PG.chance(2)) {
      const [dx, dy, dz] = N6[PG.rand(6)];
      const t = PG.get3(x + dx, y + dy, z + dz);
      if (t !== 0 && t !== E.BLOCK && !PG.isSolid(t)) PG.set3(x + dx, y + dy, z + dz, 0, 0);
    }
  };
  b[E.CLONE] = (x, y, z, i) => {
    if (PG.l3[i] === 0) {
      for (const [dx, dy, dz] of N6) {
        const t = PG.get3(x + dx, y + dy, z + dz);
        if (t !== 0 && t !== E.CLONE && t !== E.BLOCK && t !== E.SPARK) {
          PG.l3[i] = t; break;
        }
      }
    } else if (PG.chance(4)) {
      const t = PG.l3[i];
      const [dx, dy, dz] = N6[PG.rand(6)];
      if (PG.isEmpty3(x + dx, y + dy, z + dz)) {
        PG.set3(x + dx, y + dy, z + dz, t, PG.initLife(t));
      }
    }
  };
  b[E.TORCH] = (x, y, z) => {
    if (PG.chance(3)) {
      const [dx, dy, dz] = N6[PG.rand(6)];
      if (PG.isEmpty3(x + dx, y + dy, z + dz)) {
        PG.set3(x + dx, y + dy, z + dz, E.FIRE, 16 + PG.rand(20));
      }
    }
  };
  b[E.ICE] = (x, y, z) => {
    if (PG.chance(140)) {
      const [dx, dy, dz] = N6[PG.rand(6)];
      if (PG.get3(x + dx, y + dy, z + dz) === E.WATER) {
        PG.set3(x + dx, y + dy, z + dz, E.ICE, 0);
      }
    }
  };
  b[E.VINE] = (x, y, z, i) => {
    if (PG.l3[i] <= 0) return;
    if (PG.chance(8)) {
      const dirs = [[0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
                    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
      const [dx, dy, dz] = dirs[PG.rand(9)];
      if (PG.isEmpty3(x + dx, y + dy, z + dz)) {
        PG.set3(x + dx, y + dy, z + dz, E.VINE, PG.l3[i] - 1);
        PG.l3[i] = Math.max(0, PG.l3[i] - 2);
      }
    }
  };
  b[E.CLOUD] = (x, y, z, i) => {
    for (const [dx, dy, dz] of N6) {
      if (PG.get3(x + dx, y + dy, z + dz) === E.STEAM) {
        PG.set3(x + dx, y + dy, z + dz, 0, 0); PG.l3[i]++;
      }
    }
    if (PG.l3[i] > 6 && PG.chance(5) && PG.isEmpty3(x, y + 1, z)) {
      PG.set3(x, y + 1, z, E.WATER, 0);
      PG.l3[i] -= 3;
    }
  };

  // ---- creatures ----
  function hazardDeath3(x, y, z, i) {
    for (const [dx, dy, dz] of N6) {
      const t = PG.get3(x + dx, y + dy, z + dz);
      if (t === E.FIRE || t === E.ACID || t === E.MAGMA || t === E.VIRUS) {
        PG.t3[i] = E.FIRE; PG.l3[i] = 20; return true;
      }
    }
    return false;
  }

  // Ants follow walls (Langton's-ant style) in their depth-slice plane, just
  // like the 2D ant, and occasionally wander into the depth axis. life packs
  // heading (low 2 bits) and handedness (bit 2). See behaviors.js for notes.
  const ANT_DIRS3 = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // x,y plane
  const ANT_PLANE8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  function antSurface3(t) {
    if (t === 0) return false;
    const s = els[t].state;
    return s === "static" || s === "powder";
  }
  const ANT_CHARGEABLE3 = {};
  [E.C4, E.ICE, E.VINE, E.WOOD, E.METAL, E.GLASS, E.FUSE, E.PUMP].forEach(t => ANT_CHARGEABLE3[t] = 1);
  function antCanBuild3() {
    return (PG.W * PG.H * PG.D - PG.partCount) > PG.W * PG.H * PG.D * 0.02;
  }
  b[E.ANT] = (x, y, z, i) => {
    if (hazardDeath3(x, y, z, i)) return;
    if (PG.chance(2)) for (const [dx, dy, dz] of N6) { // drown
      const t = PG.get3(x + dx, y + dy, z + dz);
      if ((t === E.WATER || t === E.SALTWATER) && PG.chance(20)) {
        PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z); return;
      }
    }
    let h = PG.l3[i] & 3, hand = (PG.l3[i] >> 2) & 1, charged = (PG.l3[i] >> 3) & 63;
    if (!charged && y + 1 < PG.H) { // charge from the solid directly below
      const below = PG.t3[(z * PG.H + (y + 1)) * PG.W + x];
      if (ANT_CHARGEABLE3[below]) charged = below;
    }
    // two charged ants that meet annihilate each other
    if (charged) for (const [dx, dy, dz] of N6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (PG.get3(nx, ny, nz) === E.ANT && ((PG.l3[(nz * PG.H + ny) * PG.W + nx] >> 3) & 63)) {
        PG.set3(nx, ny, nz, 0, 0); PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z); return;
      }
    }
    // supported = surface below (common, checked first) / sides / depth / diag
    let supported = antSurface3(PG.get3(x, y + 1, z)) || antSurface3(PG.get3(x, y - 1, z)) ||
                    antSurface3(PG.get3(x - 1, y, z)) || antSurface3(PG.get3(x + 1, y, z)) ||
                    antSurface3(PG.get3(x, y, z + 1)) || antSurface3(PG.get3(x, y, z - 1));
    if (!supported) for (const [dx, dy] of ANT_PLANE8) if (antSurface3(PG.get3(x + dx, y + dy, z))) { supported = true; break; }
    if (!supported) { // airborne: uncharged ants blow in the wind, charged don't
      PG.l3[i] = h | (hand << 2) | (charged << 3);
      if (!charged && PG.windPush3(x, y, z, 1)) return;
      if (PG.tryMove3(x, y, z, x, y + 1, z)) return;
      const r = PG.rand(4);
      for (let k = 0; k < 2; k++) {
        const [dx, dz] = PG.HDIRS3[(r + k) & 3];
        if (PG.tryMove3(x, y, z, x + dx, y + 1, z + dz)) return;
      }
      return;
    }
    if (PG.chance(20)) { // occasional depth wander
      const dz = PG.chance(2) ? 1 : -1;
      if (PG.get3(x, y, z + dz) === 0) {
        PG.l3[i] = h | (hand << 2) | (charged << 3);
        if (PG.tryMove3(x, y, z, x, y, z + dz)) {
          if (charged && PG.t3[i] === 0 && antCanBuild3()) PG.set3(x, y, z, charged, PG.initLife(charged));
          return;
        }
      }
    }
    // charged ants move deterministically; uncharged ones wander
    if (!charged && PG.chance(45)) { hand ^= 1; h = (h + 2) & 3; }
    const order = hand === 0 ? [1, 0, 3, 2] : [3, 0, 1, 2];
    for (const off of order) {
      const nh = (h + off) & 3;
      const nx = x + ANT_DIRS3[nh][0], ny = y + ANT_DIRS3[nh][1];
      if (PG.get3(nx, ny, z) === 0) {
        PG.l3[i] = nh | (hand << 2) | (charged << 3);
        PG.tryMove3(x, y, z, nx, ny, z);
        if (charged && PG.t3[i] === 0 && antCanBuild3()) PG.set3(x, y, z, charged, PG.initLife(charged));
        return;
      }
    }
    // boxed in: charged ants burrow through any element but fan; else gnaw powder
    if (charged) {
      // plow forward (straight, then turns) — never reverse into our own trail
      for (const off of [0, 1, 3]) {
        const nh = (h + off) & 3;
        const bx = x + ANT_DIRS3[nh][0], by = y + ANT_DIRS3[nh][1];
        if (!PG.inBounds3(bx, by, z)) continue;
        const bt = PG.t3[(z * PG.H + by) * PG.W + bx];
        if (bt !== 0 && bt !== E.FAN && bt !== E.ANT) {
          PG.set3(bx, by, z, 0, 0);
          PG.l3[i] = nh | (charged << 3);
          PG.tryMove3(x, y, z, bx, by, z);
          if (PG.t3[i] === 0 && antCanBuild3()) PG.set3(x, y, z, charged, PG.initLife(charged));
          return;
        }
      }
    } else {
      const ax = x + ANT_DIRS3[h][0], ay = y + ANT_DIRS3[h][1], ahead = PG.get3(ax, ay, z);
      if (els[ahead] && els[ahead].state === "powder" && PG.chance(3)) PG.set3(ax, ay, z, 0, 0);
    }
    PG.l3[i] = h | (hand << 2) | (charged << 3);
  };

  b[E.BIRD] = (x, y, z, i) => {
    if (hazardDeath3(x, y, z, i)) return;
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx, ny = y + dy, nz = z + dz, t = PG.get3(nx, ny, nz);
      if (t === E.WATER || t === E.SALTWATER) { PG.t3[i] = 0; PG.cellGone3(x, y, z); return; }
      if (t === E.ANT) PG.set3(nx, ny, nz, 0, 0); // birds destroy ants
    }
    if (PG.chance(6)) PG.l3[i] = PG.rand(8);
    const d = DIR8[PG.l3[i] & 7];
    const dz = PG.chance(4) ? (PG.chance(2) ? 1 : -1) : 0;
    if (!PG.tryMove3(x, y, z, x + d[0], y + d[1], z + dz)) PG.l3[i] = PG.rand(8);
  };

  b[E.FISH] = (x, y, z, i) => {
    if (hazardDeath3(x, y, z, i)) return;
    let inWater = false;
    for (const [dx, dy, dz] of N6) {
      const t = PG.get3(x + dx, y + dy, z + dz);
      if (t === E.WATER || t === E.SALTWATER) { inWater = true; break; }
    }
    if (inWater) {
      PG.l3[i] = 200;
      const [dx, dy, dz] = N6[PG.rand(6)];
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const t = PG.get3(nx, ny, nz);
      if (t === E.WATER || t === E.SALTWATER) {
        const j = PG.idx3(nx, ny, nz);
        PG.t3[j] = E.FISH; PG.l3[j] = 200;
        PG.t3[i] = t; PG.l3[i] = 0;
        PG.u3[j] = PG.stamp;
        PG.wake3(nx, ny, nz); // the fish's new cell must keep running
      }
    } else {
      if (--PG.l3[i] <= 0) { PG.t3[i] = 0; PG.l3[i] = 0; PG.cellGone3(x, y, z); return; }
      PG.doPowder3(x, y, z);
    }
  };
})();
