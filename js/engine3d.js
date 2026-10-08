// 3D mode: voxel grid (same W/H as the 2D grid, plus depth D), 3D air field,
// and generic 3D particle movement. Slice z=0 is the "front" of the box.
(function () {
  const E = PG.E, els = PG.elements;

  PG.mode3d = false;
  PG.D = 0;
  PG.t3 = null; PG.l3 = null; PG.u3 = null;
  PG.sliceCount = null; // particles per z-slice, lets sim/render skip empty slices
  PG.rowCount = null;   // particles per (z,y) row, lets sim/render skip empty rows
                        // — the key to 60fps in big, mostly-empty boxes
  PG.sleep3 = null;     // 1 = settled, skipped by the sim until a neighbour changes
  PG.awakeRow = null;   // count of awake (still-processed) non-empty cells per row
                        // — lets a full, settled container of water run at 60fps

  // Bulk materials that may go to sleep once they can't move. Reactive or
  // self-driven elements (fire, conductors, generators, creatures, acid, …)
  // are absent, so they are never slept and keep running every frame.
  PG.SLEEPABLE = null;

  // wake a settled cell so it is processed again next frame. Only sleepable
  // elements are woken — inert cells (block, glass) have no behaviour and would
  // otherwise stay "awake" forever, keeping their whole row scanned.
  PG.wake3 = function (x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= PG.W || y >= PG.H || z >= PG.D) return;
    const i = (z * PG.H + y) * PG.W + x, t = PG.t3[i];
    if (t !== 0 && PG.sleep3[i] && PG.SLEEPABLE[t]) { PG.sleep3[i] = 0; PG.awakeRow[z * PG.H + y]++; }
  };
  // same as wake3 on the 6 face neighbours of an in-bounds cell, from its index
  // (this runs on every 3D move, so it skips six calls and their bounds math)
  PG.wakeNeighbors3 = function (x, y, z) {
    const W = PG.W, H = PG.H, WH = W * H, t3 = PG.t3, s3 = PG.sleep3, S = PG.SLEEPABLE, ar = PG.awakeRow;
    const row = z * H + y, i = row * W + x;
    let j;
    if (x > 0 && s3[j = i - 1] && S[t3[j]]) { s3[j] = 0; ar[row]++; }
    if (x < W - 1 && s3[j = i + 1] && S[t3[j]]) { s3[j] = 0; ar[row]++; }
    if (y > 0 && s3[j = i - W] && S[t3[j]]) { s3[j] = 0; ar[row - 1]++; }
    if (y < H - 1 && s3[j = i + W] && S[t3[j]]) { s3[j] = 0; ar[row + 1]++; }
    if (z > 0 && s3[j = i - WH] && S[t3[j]]) { s3[j] = 0; ar[row - H]++; }
    if (z < PG.D - 1 && s3[j = i + WH] && S[t3[j]]) { s3[j] = 0; ar[row + H]++; }
  };
  // a sleepable particle that couldn't move this frame settles (skipped until woken)
  PG.sleepCell3 = function (x, y, z) {
    const i = (z * PG.H + y) * PG.W + x, t = PG.t3[i];
    if (t === 0 || PG.sleep3[i] || !PG.SLEEPABLE[t]) return;
    PG.sleep3[i] = 1; PG.awakeRow[z * PG.H + y]--;
  };

  // A non-empty cell at (x,y,z) was just cleared directly (not via set3).
  PG.cellGone3 = function (x, y, z) {
    const row = z * PG.H + y;
    PG.sliceCount[z]--; PG.rowCount[row]--;
    if (PG.sleep3[(row) * PG.W + x] === 0) PG.awakeRow[row]--;
    PG.wakeNeighbors3(x, y, z); // freed cell lets neighbours flow/react
  };

  (function () {
    const E = PG.E, S = new Uint8Array(PG.elements.length);
    [E.WATER, E.OIL, E.POWDER, E.STONE, E.GPOWDER].forEach(t => { S[t] = 1; });
    PG.SLEEPABLE = S;
  })();

  // ---- 3D air (coarse 1/4-res coupled pressure + velocity field) --
  // Same model as the 2D air: velocity self-advects so 3D gusts travel and
  // swirl. A touch lighter (advection is sampled, not trilinear) to stay fast.
  PG.air3 = (function () {
    const AC = 4, INV = 1 / AC;
    let AW = 0, AH = 0, AD = 0, n = 0;
    let vx, vy, vz, p, p2, vx2, vy2, vz2;
    let dirty = true, calm = 0; // skip the whole solve once the field is dead calm
    const MAXV = 10, MAXP = 36, GRAD = 0.15, VEL_LOSS = 0.97, PRS_LOSS = 0.95;
    function clampv(v, m) { return v > m ? m : (v < -m ? -m : v); }

    function init(w, h, d) {
      AW = Math.ceil(w / AC); AH = Math.ceil(h / AC); AD = Math.ceil(d / AC);
      n = AW * AH * AD;
      vx = new Float32Array(n); vy = new Float32Array(n); vz = new Float32Array(n);
      vx2 = new Float32Array(n); vy2 = new Float32Array(n); vz2 = new Float32Array(n);
      p = new Float32Array(n); p2 = new Float32Array(n);
    }
    const ai = (x, y, z) => (z * AH + y) * AW + x;

    // nearest-cell advection backtrace (cheap; trilinear is overkill at 1/4 res)
    function adv(a, x, y, z, sx, sy, sz) {
      let bx = Math.round(x - sx), by = Math.round(y - sy), bz = Math.round(z - sz);
      if (bx < 1) bx = 1; else if (bx > AW - 2) bx = AW - 2;
      if (by < 1) by = 1; else if (by > AH - 2) by = AH - 2;
      if (bz < 1) bz = 1; else if (bz > AD - 2) bz = AD - 2;
      return a[(bz * AH + by) * AW + bx];
    }

    function step() {
      if (!dirty) return; // field is calm — nothing to simulate (huge win when settled)
      const XS = 1, YS = AW, ZS = AW * AH;
      // 0. CLOSED-BOX BORDERS. addVel/addPressure clamp out-of-range impulses
      //    (drag, fans, fire) onto edge cells; the interior-only solve below
      //    never decays them, so without this they freeze into permanent
      //    phantom wind that traps falling dots. (The 2D solver does the same.)
      for (let z = 0; z < AD; z++) for (let y = 0; y < AH; y++) {
        const l = (z * AH + y) * AW, r = l + AW - 1;
        vx[l] = vy[l] = vz[l] = p[l] = vx2[l] = vy2[l] = vz2[l] = p2[l] = 0;
        vx[r] = vy[r] = vz[r] = p[r] = vx2[r] = vy2[r] = vz2[r] = p2[r] = 0;
      }
      for (let z = 0; z < AD; z++) for (let x = 0; x < AW; x++) {
        const t = (z * AH) * AW + x, bo = (z * AH + AH - 1) * AW + x;
        vx[t] = vy[t] = vz[t] = p[t] = vx2[t] = vy2[t] = vz2[t] = p2[t] = 0;
        vx[bo] = vy[bo] = vz[bo] = p[bo] = vx2[bo] = vy2[bo] = vz2[bo] = p2[bo] = 0;
      }
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
        const f = y * AW + x, ba = ((AD - 1) * AH + y) * AW + x;
        vx[f] = vy[f] = vz[f] = p[f] = vx2[f] = vy2[f] = vz2[f] = p2[f] = 0;
        vx[ba] = vy[ba] = vz[ba] = p[ba] = vx2[ba] = vy2[ba] = vz2[ba] = p2[ba] = 0;
      }
      // 1. transport: self-advection blended with neighbor diffusion (so
      //    localized gusts spread + travel instead of vanishing — see air.js)
      for (let z = 1; z < AD - 1; z++) {
        for (let y = 1; y < AH - 1; y++) {
          let i = ai(1, y, z);
          for (let x = 1; x < AW - 1; x++, i++) {
            const ux = vx[i] * INV, uy = vy[i] * INV, uz = vz[i] * INV;
            const nax = (vx[i - XS] + vx[i + XS] + vx[i - YS] + vx[i + YS] + vx[i - ZS] + vx[i + ZS]) / 6;
            const nay = (vy[i - XS] + vy[i + XS] + vy[i - YS] + vy[i + YS] + vy[i - ZS] + vy[i + ZS]) / 6;
            const naz = (vz[i - XS] + vz[i + XS] + vz[i - YS] + vz[i + YS] + vz[i - ZS] + vz[i + ZS]) / 6;
            vx2[i] = adv(vx, x, y, z, ux, uy, uz) * 0.72 + nax * 0.28;
            vy2[i] = adv(vy, x, y, z, ux, uy, uz) * 0.72 + nay * 0.28;
            vz2[i] = adv(vz, x, y, z, ux, uy, uz) * 0.72 + naz * 0.28;
          }
        }
      }
      // 2. pressure from divergence of advected field
      for (let z = 1; z < AD - 1; z++) {
        for (let y = 1; y < AH - 1; y++) {
          let i = ai(1, y, z);
          for (let x = 1; x < AW - 1; x++, i++) {
            const dp = (vx2[i - XS] - vx2[i + XS] + vy2[i - YS] - vy2[i + YS] +
                        vz2[i - ZS] - vz2[i + ZS]) * GRAD;
            const avg = (p[i - XS] + p[i + XS] + p[i - YS] + p[i + YS] +
                         p[i - ZS] + p[i + ZS]) / 6;
            p2[i] = clampv((p[i] * 0.7 + avg * 0.3 + dp) * PRS_LOSS, MAXP);
          }
        }
      }
      // 3. accelerate velocity down the pressure gradient (track peak speed)
      let mv = 0;
      for (let z = 1; z < AD - 1; z++) {
        for (let y = 1; y < AH - 1; y++) {
          let i = ai(1, y, z);
          for (let x = 1; x < AW - 1; x++, i++) {
            const a = clampv((vx2[i] + (p2[i - XS] - p2[i + XS]) * GRAD) * VEL_LOSS, MAXV);
            const b = clampv((vy2[i] + (p2[i - YS] - p2[i + YS]) * GRAD) * VEL_LOSS, MAXV);
            const c = clampv((vz2[i] + (p2[i - ZS] - p2[i + ZS]) * GRAD) * VEL_LOSS, MAXV);
            vx2[i] = a; vy2[i] = b; vz2[i] = c;
            const m = (a < 0 ? -a : a) + (b < 0 ? -b : b) + (c < 0 ? -c : c);
            if (m > mv) mv = m;
          }
        }
      }
      [vx, vx2] = [vx2, vx]; [vy, vy2] = [vy2, vy]; [vz, vz2] = [vz2, vz];
      [p, p2] = [p2, p];
      // once the field is essentially still for a few frames, stop solving it
      if (mv < 0.05) { if (++calm > 4) dirty = false; } else calm = 0;
    }

    function idxFor(x, y, z) {
      let a = (x / AC) | 0, b = (y / AC) | 0, c = (z / AC) | 0;
      a = a < 0 ? 0 : (a >= AW ? AW - 1 : a);
      b = b < 0 ? 0 : (b >= AH ? AH - 1 : b);
      c = c < 0 ? 0 : (c >= AD ? AD - 1 : c);
      return (c * AH + b) * AW + a;
    }
    return {
      init, step,
      clear() { vx.fill(0); vy.fill(0); vz.fill(0); vx2.fill(0); vy2.fill(0); vz2.fill(0); p.fill(0); dirty = false; calm = 0; },
      calm: () => !dirty, // dead calm: every velocity is ~0, readers may skip it
      velX: (x, y, z) => vx[idxFor(x, y, z)],
      velY: (x, y, z) => vy[idxFor(x, y, z)],
      velZ: (x, y, z) => vz[idxFor(x, y, z)],
      addVel(x, y, z, dx, dy, dz) {
        const i = idxFor(x, y, z);
        vx[i] = clampv(vx[i] + dx, MAXV);
        vy[i] = clampv(vy[i] + dy, MAXV);
        vz[i] = clampv(vz[i] + dz, MAXV);
        dirty = true; calm = 0; // wake the solver
      },
      addPressure(x, y, z, dp) {
        const i = idxFor(x, y, z);
        p[i] = clampv(p[i] + dp, MAXP);
        dirty = true; calm = 0;
      },
      blast(x, y, z, radius, power) {
        const r = Math.ceil(radius / AC);
        const cx = (x / AC) | 0, cy = (y / AC) | 0, cz = (z / AC) | 0;
        for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const a = cx + dx, b = cy + dy, c = cz + dz;
            if (a < 1 || b < 1 || c < 1 || a >= AW - 1 || b >= AH - 1 || c >= AD - 1) continue;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > r * r) continue;
            const i = (c * AH + b) * AW + a;
            const f = power * (1 - Math.sqrt(d2) / (r + 1));
            p[i] = clampv(p[i] + f, MAXP);
            const d = Math.sqrt(d2) || 1;
            vx[i] = clampv(vx[i] + (dx / d) * f * 0.4, MAXV);
            vy[i] = clampv(vy[i] + (dy / d) * f * 0.4, MAXV);
            vz[i] = clampv(vz[i] + (dz / d) * f * 0.4, MAXV);
          }
        dirty = true; calm = 0;
      },
      swirl(x, y, z, radius, power, suck) {
        const r = Math.ceil(radius * INV);
        const cx = (x * INV) | 0, cy = (y * INV) | 0, cz = (z * INV) | 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const a = cx + dx, b = cy + dy;
          if (a < 1 || b < 1 || cz < 1 || a >= AW - 1 || b >= AH - 1 || cz >= AD - 1) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > r || d < 0.5) continue;
          const i = (cz * AH + b) * AW + a;
          const fall = (1 - d / (r + 1)) * power;
          vx[i] = clampv(vx[i] + (-dy / d) * fall - (dx / d) * suck, MAXV);
          vy[i] = clampv(vy[i] + (dx / d) * fall - (dy / d) * suck, MAXV);
        }
        dirty = true; calm = 0;
      },
    };
  })();

  // ---- grid -----------------------------------------------------------------
  PG.idx3 = (x, y, z) => (z * PG.H + y) * PG.W + x;
  PG.inBounds3 = (x, y, z) =>
    x >= 0 && y >= 0 && z >= 0 && x < PG.W && y < PG.H && z < PG.D;

  PG.get3 = function (x, y, z) {
    if (!PG.inBounds3(x, y, z)) return E.BLOCK;
    return PG.t3[(z * PG.H + y) * PG.W + x];
  };
  PG.set3 = function (x, y, z, t, lifeVal) {
    if (!PG.inBounds3(x, y, z)) return;
    const i = (z * PG.H + y) * PG.W + x;
    const old = PG.t3[i];
    const row = z * PG.H + y;
    if (old !== 0 && t === 0) {              // remove
      PG.sliceCount[z]--; PG.rowCount[row]--;
      if (PG.sleep3[i] === 0) PG.awakeRow[row]--;
      PG.sleep3[i] = 0;
    } else if (old === 0 && t !== 0) {       // create (active if it has a behaviour)
      PG.sliceCount[z]++; PG.rowCount[row]++;
      const aw = PG.behaviors3[t] ? 1 : 0;
      PG.sleep3[i] = aw ? 0 : 1;
      if (aw) PG.awakeRow[row]++;
    } else if (old !== t) {                  // transform: re-evaluate active state
      const wasAwake = PG.sleep3[i] === 0, aw = PG.behaviors3[t] ? 1 : 0;
      if (wasAwake && !aw) PG.awakeRow[row]--;
      else if (!wasAwake && aw) PG.awakeRow[row]++;
      PG.sleep3[i] = aw ? 0 : 1;
    }
    PG.t3[i] = t; PG.l3[i] = lifeVal | 0;
    PG.u3[i] = PG.stamp;
    if (old !== 0) PG.wakeNeighbors3(x, y, z); // a change here may free/disturb neighbours
  };
  PG.isEmpty3 = (x, y, z) => PG.inBounds3(x, y, z) &&
    PG.t3[(z * PG.H + y) * PG.W + x] === 0;

  PG.depthPref = 0; // requested box depth (D slider); 0 = auto = square footprint (depth = width)

  function clampDepth(w, h, d) {
    return Math.max(8, Math.min(d, Math.floor(12e6 / (w * h))));
  }
  // depth to use given a field width: explicit slider value, else a square base
  PG.boxDepthFor = (w) => PG.depthPref > 0 ? PG.depthPref : w;

  PG.enter3D = function () {
    const W = PG.W, H = PG.H;
    PG.D = clampDepth(W, H, PG.boxDepthFor(W));
    const n = W * H * PG.D;
    PG.t3 = new Uint8Array(n);
    PG.l3 = new Int32Array(n);
    PG.u3 = new Uint8Array(n);
    PG.sliceCount = new Uint32Array(PG.D);
    PG.rowCount = new Int32Array(PG.D * H);
    PG.sleep3 = new Uint8Array(n);
    PG.awakeRow = new Int32Array(PG.D * H);
    // slice z=0 is laid out exactly like the 2D grid: straight copy
    PG.t3.set(PG.type, 0);
    PG.l3.set(PG.life, 0);
    let c = 0;
    for (let y = 0; y < H; y++) {
      let rc = 0, aw = 0;
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const t = PG.type[row + x];
        if (t !== 0) { rc++; if (PG.behaviors3[t]) aw++; else PG.sleep3[row + x] = 1; }
      }
      PG.rowCount[y] = rc; PG.awakeRow[y] = aw; c += rc;
    }
    PG.sliceCount[0] = c;
    PG.air3.init(W, H, PG.D);
    if (PG.player) PG.player.z = 0;
    PG.mode3d = true;
  };

  PG.exit3D = function (focusZ) {
    const W = PG.W, H = PG.H;
    const base = focusZ * W * H;
    PG.type.set(PG.t3.subarray(base, base + W * H));
    PG.life.set(PG.l3.subarray(base, base + W * H));
    PG.updated.fill(0);
    PG.air.clear();
    if (PG.player && Math.round(PG.player.z) !== focusZ) PG.player = null;
    PG.mode3d = false;
    PG.t3 = PG.l3 = PG.u3 = PG.sliceCount = PG.rowCount = PG.sleep3 = PG.awakeRow = null;
  };

  PG.clearGrid3 = function () {
    PG.t3.fill(0); PG.l3.fill(0); PG.u3.fill(0);
    PG.sliceCount.fill(0); PG.rowCount.fill(0);
    PG.sleep3.fill(0); PG.awakeRow.fill(0);
    PG.air3.clear();
    PG.player = null;
  };

  // Resize the box, keeping content (x centered, y bottom, z front-anchored).
  // Also resizes the dormant 2D arrays so exit3D stays consistent.
  PG.resizeGrid3 = function (newW, newH, newD) {
    const oldW = PG.W, oldH = PG.H, oldD = PG.D;
    newD = clampDepth(newW, newH, newD);
    if (newW === oldW && newH === oldH && newD === oldD) return;
    const n = newW * newH * newD;
    const nt = new Uint8Array(n), nl = new Int32Array(n);
    const nsc = new Uint32Array(newD);
    const nrc = new Int32Array(newD * newH);
    const nsleep = new Uint8Array(n), nawake = new Int32Array(newD * newH);
    const dx = Math.floor((newW - oldW) / 2), dy = newH - oldH;
    const sx0 = Math.max(0, -dx), sx1 = Math.min(oldW, newW - dx);
    const copyD = Math.min(oldD, newD);
    for (let z = 0; z < copyD; z++) {
      if (PG.sliceCount[z] === 0) continue;
      const oSlice = z * oldH * oldW, nSlice = z * newH * newW;
      let cnt = 0;
      for (let y = 0; y < oldH; y++) {
        const ny = y + dy;
        if (ny < 0 || ny >= newH || sx1 <= sx0) continue;
        const src = oSlice + y * oldW, dst = nSlice + ny * newW + sx0 + dx;
        nt.set(PG.t3.subarray(src + sx0, src + sx1), dst);
        nl.set(PG.l3.subarray(src + sx0, src + sx1), dst);
        let rc = 0, aw = 0;
        for (let k = dst; k < dst + (sx1 - sx0); k++) {
          const t = nt[k];
          if (t !== 0) { rc++; if (PG.behaviors3[t]) aw++; else nsleep[k] = 1; }
        }
        nrc[z * newH + ny] = rc; nawake[z * newH + ny] = aw; cnt += rc;
      }
      nsc[z] = cnt;
    }
    PG.resizeGrid(newW, newH); // dormant 2D arrays + PG.W/H + player x/y
    PG.t3 = nt; PG.l3 = nl;
    PG.u3 = new Uint8Array(n);
    PG.sliceCount = nsc;
    PG.rowCount = nrc;
    PG.sleep3 = nsleep;
    PG.awakeRow = nawake;
    PG.D = newD;
    PG.air3.init(newW, newH, newD);
    if (PG.player) PG.player.z = Math.max(0, Math.min(newD - 1, PG.player.z));
  };

  // ---- movement -------------------------------------------------------------
  PG.tryMove3 = function (x, y, z, nx, ny, nz) {
    if (!PG.inBounds3(nx, ny, nz)) return false;
    const i = (z * PG.H + y) * PG.W + x;
    const j = (nz * PG.H + ny) * PG.W + nx;
    const t = PG.t3[i], d = PG.t3[j];
    const H = PG.H, irow = z * H + y, jrow = nz * H + ny;
    if (d === 0) {
      PG.t3[j] = t; PG.l3[j] = PG.l3[i];
      PG.t3[i] = 0; PG.l3[i] = 0;
      PG.u3[j] = PG.stamp;
      if (nz !== z) { PG.sliceCount[z]--; PG.sliceCount[nz]++; }
      if (irow !== jrow) {
        PG.rowCount[irow]--; PG.rowCount[jrow]++;
        PG.awakeRow[irow]--; PG.awakeRow[jrow]++; // mover carries its awake slot
      }
      PG.sleep3[j] = 0; PG.sleep3[i] = 0; // mover stays awake at j
      PG.wakeNeighbors3(x, y, z); // freed cell i: neighbours can flow in.
      // (No need to wake the destination's neighbours: reactive elements never
      // sleep, so only freed space matters — this halves wake churn in flows.)
      return true;
    }
    const ds = els[d].state;
    if ((ds === "liquid" || ds === "gas") && els[t].density > els[d].density) {
      const tl = PG.l3[i];
      PG.t3[i] = d; PG.l3[i] = PG.l3[j];
      PG.t3[j] = t; PG.l3[j] = tl;
      PG.u3[j] = PG.stamp; PG.u3[i] = PG.stamp;
      if (PG.sleep3[j]) { PG.sleep3[j] = 0; PG.awakeRow[jrow]++; } // both now active
      if (PG.sleep3[i]) { PG.sleep3[i] = 0; PG.awakeRow[irow]++; }
      PG.wakeNeighbors3(x, y, z); PG.wakeNeighbors3(nx, ny, nz);
      return true;
    }
    return false;
  };

  const HDIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // (dx, dz)
  PG.HDIRS3 = HDIRS;

  PG.windPush3 = function (x, y, z, strength) {
    const a = PG.air3;
    const wx = a.velX(x, y, z), wy = a.velY(x, y, z), wz = a.velZ(x, y, z);
    const mag = Math.abs(wx) + Math.abs(wy) + Math.abs(wz);
    if (mag < 0.55) return false;
    if (PG.rand(10) > Math.min(9, mag * strength * 2)) return false;
    const ax = Math.abs(wx), ay = Math.abs(wy), az = Math.abs(wz);
    if (ax >= ay && ax >= az) return PG.tryMove3(x, y, z, x + (wx > 0 ? 1 : -1), y, z);
    if (ay >= az) return PG.tryMove3(x, y, z, x, y + (wy > 0 ? 1 : -1), z);
    return PG.tryMove3(x, y, z, x, y, z + (wz > 0 ? 1 : -1));
  };

  // particle -> air drag and surface waves, 3D versions (see engine.js)
  const DRAG3 = 0.05;
  PG.dragAir3 = function (x, y, z, dx, dy, dz) {
    if (PG.rand(4)) return;
    PG.air3.addVel(x, y, z, dx * DRAG3, dy * DRAG3, dz * DRAG3);
  };
  // 3D twin of PG.waveSurface (same constants): herd surface cells toward the
  // nearest crest, sliding along an open surface or riding up onto the next
  // column of the same liquid. This only reaches liquid that is awake (flowing,
  // or a type that never sleeps); a settled pool sleeps, and render3d draws its
  // swell instead of simulating it.
  PG.waveSurface3 = function (x, y, z) {
    if (!PG.waveStr || !PG.isEmpty3(x, y - 1, z)) return false;
    const WV = PG.WAVE, a = WV.AMP[PG.waveStr], r = WV.HALF, f = 2 * WV.HALF;
    for (let k = 0; k < 4; k++) {                             // part of a heap: gravity's job
      const h = HDIRS[k];
      if (PG.isEmpty3(x + h[0] * r, y + a, z + h[1] * r) ||
          PG.isEmpty3(x + h[0] * f, y + a, z + h[1] * f)) return false;
    }
    if (PG.rand(256) >= WV.HOLD[PG.waveStr]) return false;
    // diagonal wavefront across x+z so crests roll over the 3D surface
    const c = Math.cos((x + z) * WV.K - PG.frame * WV.SPEED);
    if (c < 0.3 && c > -0.3) return true;                     // on a crest/trough: hold
    const d = c > 0 ? 1 : -1;
    if (!PG.tryMove3(x, y, z, x + d, y, z) &&
        PG.get3(x + d, y, z) === PG.t3[(z * PG.H + y) * PG.W + x]) {
      PG.tryMove3(x, y, z, x + d, y - 1, z);
    }
    return true;
  };

  PG.doPowder3 = function (x, y, z) {
    if (PG.windPush3(x, y, z, 1)) return;
    if (PG.tryMove3(x, y, z, x, y + 1, z)) { PG.dragAir3(x, y + 1, z, 0, 1, 0); return; }
    const r = PG.rand(4);
    for (let k = 0; k < 2; k++) {
      const [dx, dz] = HDIRS[(r + k) & 3];
      if (PG.tryMove3(x, y, z, x + dx, y + 1, z + dz)) return;
    }
    PG.sleepCell3(x, y, z); // couldn't fall -> settle
  };

  // Move up to n cells along a unit axis (ex, ey, ez). Every cell on the way is
  // checked, so nothing tunnels through a wall, but the empty run is crossed in
  // one hop (the cells skipped were empty before and after, so none of their
  // neighbours need waking), then one ordinary move into whatever stopped it,
  // so a heavier liquid still sinks through a lighter one. Returns cells moved.
  function run3(x, y, z, ex, ey, ez, n) {
    const W = PG.W, H = PG.H, D = PG.D, t3 = PG.t3;
    let m = 0;
    while (m < n) {
      const nx = x + ex * (m + 1), ny = y + ey * (m + 1), nz = z + ez * (m + 1);
      if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= D) break;
      if (t3[(nz * H + ny) * W + nx] !== 0) break;
      m++;
    }
    if (m > 0) PG.tryMove3(x, y, z, x + ex * m, y + ey * m, z + ez * m);
    if (m < n && PG.tryMove3(x + ex * m, y + ey * m, z + ez * m,
                             x + ex * (m + 1), y + ey * (m + 1), z + ez * (m + 1))) m++;
    return m;
  }

  // Hot path, so: its own inlined xorshift (each 32-bit draw is sliced into
  // several random fractions), the air's calm flag read once per step, and the
  // velocity pack written in place.
  const FLOWS = PG.FLOWS, DENS = PG.DENS;
  const SUPPORTED = 0x40000000; // l3 bit 30: resting on support (kept clear of the sign bit)
  let rng3 = 0x6d2b79f5, airCalm3 = true;
  // gravity's random kick and the vertical rounding are drawn once per frame,
  // not per cell: cells that started falling together stay level with each
  // other and fall as one body (per-cell draws let each cell lag at random,
  // and a falling body shredded into a cloud of dots). The rounding gets a
  // fixed offset per (x, z) column, so a cell never stalls the one above it,
  // but side-by-side columns step on different frames instead of in bands.
  let kick3 = 0.5, dither3 = 0.5;
  // gravity is doubled in 3D: in 2D a falling stream drags the air down with it
  // and that downdraft speeds it up, but 3D skips that drag (it would keep the
  // costly 3D air solver awake), so without this a stream would crawl
  const G3 = 2;
  // grid refs for the hot path, refreshed at the top of every step (liquid3 is
  // only ever called from inside stepSim3, so a resize can't leave them stale)
  let W3 = 0, H3 = 0, D3 = 0, T3 = null, L3 = null;
  // From the empty cell c, along `step`, up to n cells over the same level:
  // is there a hole to drop into before the run hits something? (Only asked
  // of a cell resting on liquid, so the row below always exists.)
  const REACH = 4;
  function dropAhead(c, step, n) {
    for (let k = 0; k < n; k++, c += step) {
      if (T3[c] !== 0) return false;
      if (T3[c + W3] === 0) return true;
    }
    return false;
  }
  // Classic liquid step for one 3D cell: Powder Game's liquid update (see
  // PG.liquid) with the sideways rules applied on both horizontal axes, and the
  // velocity packed in l3 exactly as in 2D, plus a SUPPORTED bit (bit 30): set
  // when the cell rests on the floor, on a non-fluid or on supported liquid, and
  // kept while it merely slumps (the loop runs bottom-up, so support climbs a
  // whole stack in one frame). What 3D adds, to stay tidy and cheap:
  //  - cohesion: a cell spreads only once it has landed or with liquid weighing
  //    on it, so a falling body stays together and a one-deep sheet on the
  //    floor holds (Powder Game lets both disperse into dots, which in 3D
  //    sprays droplets that never settle);
  //  - a surface cell flows only toward a drop it can reach, so a level pool
  //    settles instead of shuffling into its own gaps forever;
  //  - landing on support ends the fall (vy = 0) instead of pressing on;
  //  - gravity's kick and the vertical rounding are shared (see kick3);
  //  - a cell that couldn't move and is barely moving sleeps once it is boxed
  //    in sideways or lies one cell deep: settled liquid costs nothing until
  //    disturbed.
  PG.liquid3 = function (x, y, z, i, P) {
    if (PG.fluidMode) { PG.fluidAdd(x, y, z); return; }    // fluid.js moves it
    const W = W3, H = H3, D = D3, WH = W * H, t3 = T3, l3 = L3;
    const l = l3[i], cooling = l < 0 && P.cond;
    let vx = 0, vy = 0, vz = 0;
    if (l > 0) {
      vx = ((l << 22) >> 22) * 0.0078125; vy = ((l << 12) >> 22) * 0.0078125;
      vz = ((l << 2) >> 22) * 0.0078125;                     // 1/128 cell per frame
    }
    let ax = 0, ay = 0, az = 0;
    if (!airCalm3) {
      const a = PG.air3;
      ax = a.velX(x, y, z); ay = a.velY(x, y, z); az = a.velZ(x, y, z);
      vx += P.adv * ax; vy += P.adv * ay; vz += P.adv * az;
    }
    let r = rng3;                                            // three 32-bit draws
    r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const ra = r >>> 0;
    r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const rb = r >>> 0;
    r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const rc = r >>> 0;
    rng3 = r;
    const t = t3[i], below = y + 1 < H ? t3[i + W] : -1;     // -1: the floor
    const rests = below !== 0;
    // what's underneath: liquid that isn't supported is still falling — no
    // floor yet, so this cell keeps its fall speed and doesn't spread. Support
    // is sticky: a cell keeps it until it falls, so the slumping face of a
    // pile still spreads while the cells under it give way.
    const belowLiq = below > 0 && FLOWS[below] === 1;
    const wasSup = l > 0 && (l & SUPPORTED) !== 0;
    const held = below === -1 || (below > 0 && (FLOWS[below] === 0 ||
      (belowLiq && (wasSup || (l3[i + W] & SUPPORTED) !== 0))));
    // landed on support it can't sink through: no point trying to fall
    const landed = held && !(below > 0 && FLOWS[below] !== 0 && DENS[t] > DENS[below]);
    let open = 0, oneDeep = true;                            // empty sides; nothing liquid below
    if (rests) {
      if (PG.waveStr && PG.waveSurface3(x, y, z)) return;
      if (belowLiq) oneDeep = false;
      // spread only off liquid that has landed, or under liquid's weight
      const under = y > 0 && FLOWS[t3[i - W]] === 1;
      if (held && (belowLiq || under)) {
        // pushed toward an open side; open on both sides of an axis, it keeps
        // gliding the way it already moves (Powder Game's two pushes cancel
        // into a random walk, so a stray drop could wander a 3D sheet for ages)
        const x1 = P.x1, xs = P.xs * 0.00390625;           // push x1 + xs * [0, 1)
        let xm = x > 0 && t3[i - 1] === 0, xp = x < W - 1 && t3[i + 1] === 0;
        let zm = z > 0 && t3[i - WH] === 0, zp = z < D - 1 && t3[i + WH] === 0;
        if (!under) {
          // a surface cell flows only toward somewhere lower it can reach, so
          // a level surface settles (Powder Game keeps its surface dots
          // shuffling into each other's gaps forever, which in 3D never sleeps)
          if (xm) xm = dropAhead(i - 1, -1, x < REACH ? x : REACH);
          if (xp) xp = dropAhead(i + 1, 1, W - 1 - x < REACH ? W - 1 - x : REACH);
          if (zm) zm = dropAhead(i - WH, -WH, z < REACH ? z : REACH);
          if (zp) zp = dropAhead(i + WH, WH, D - 1 - z < REACH ? D - 1 - z : REACH);
        }
        const px = x1 + xs * (ra & 255), pz = x1 + xs * ((ra >>> 8) & 255);
        if (xm && xp) vx += vx > 0 || (vx === 0 && ra & 0x10000) ? px : -px;
        else if (xm) vx -= px; else if (xp) vx += px;
        if (zm && zp) vz += vz > 0 || (vz === 0 && ra & 0x20000) ? pz : -pz;
        else if (zm) vz -= pz; else if (zp) vz += pz;
        open = (xm ? 1 : 0) + (xp ? 1 : 0) + (zm ? 1 : 0) + (zp ? 1 : 0);
      }
    }
    if (held) {                                              // jitter: xr * [-1, 1)
      const jr = P.xr * 0.001953125;
      vx += jr * ((rb & 1023) - 512); vz += jr * (((rb >>> 10) & 1023) - 512);
    }
    vy += (P.y1 + P.ys * kick3) * G3;
    const f = P.frc;
    vx *= f; vy *= f; vz *= f;
    const dx = ax + vx, dy = ay + vy, dz = az + vz;
    const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy, adz = dz < 0 ? -dz : dz;
    const mx = adx > ady ? (adx > adz ? adx : adz) : (ady > adz ? ady : adz);
    const s = 3.8 / (mx + 0.5 * (adx + ady + adz - mx) + 1);  // fast |v|, soft 3.8 cap
    // whole cells, plus one more with the leftover fraction as its chance;
    // horizontal first, then vertical (as Powder Game applies x, then y).
    // (No air drag in 3D: it would keep the costly 3D air solver awake.)
    let cx = x, cy = y, cz = z, n;
    if ((n = (adx * s + (rc & 1023) * 0.0009765625) | 0) > 0) cx += (dx < 0 ? -1 : 1) * run3(cx, cy, cz, dx < 0 ? -1 : 1, 0, 0, n);
    if ((n = (adz * s + ((rc >>> 10) & 1023) * 0.0009765625) | 0) > 0) cz += (dz < 0 ? -1 : 1) * run3(cx, cy, cz, 0, 0, dz < 0 ? -1 : 1, n);
    if (dy > 0 && landed && cx === x && cz === z) vy = 0;                // landed: stop falling
    else if ((n = (ady * s + (dither3 + (x * 0.7548776662 + z * 0.5698402910) % 1) % 1) | 0) > 0) {
      const sy = dy < 0 ? -1 : 1, m = run3(cx, cy, cz, 0, sy, 0, n);
      cy += sy * m;
    }
    const j = (cz * H + cy) * W + cx;
    // support where it ended up: on the floor, a solid or supported liquid —
    // or, for a cell that had it, any liquid it is merely slumping onto (a
    // real fall, fast, clears it)
    let sup = 0;
    const bt = cy + 1 < H ? t3[j + W] : -1;
    if (bt === -1 || (bt > 0 && (FLOWS[bt] === 0 || (FLOWS[bt] === 1 &&
        ((wasSup && vy < 0.15) || (l3[j + W] & SUPPORTED) !== 0))))) {
      sup = SUPPORTED;
      if (vy > 0) vy = 0;                                    // on support: the fall is over
    }
    if (!cooling) {                                          // pack, with dithered rounding
      const d = ((ra ^ rc) & 1023) * 0.0009765625;
      let qx = Math.floor(vx * 128 + d), qy = Math.floor(vy * 128 + d), qz = Math.floor(vz * 128 + d);
      qx = qx > 511 ? 511 : qx < -511 ? -511 : qx;
      qy = qy > 511 ? 511 : qy < -511 ? -511 : qy;
      qz = qz > 511 ? 511 : qz < -511 ? -511 : qz;
      l3[j] = (qx & 1023) | ((qy & 1023) << 10) | ((qz & 1023) << 20) | sup;
    }
    // only a landed cell sleeps: one blocked by liquid still falling must
    // keep gathering speed, or the stack it belongs to stretches out
    if (j === i && landed && vx < 0.04 && vx > -0.04 && vz < 0.04 && vz > -0.04 &&
        (open === 0 || oneDeep)) PG.sleepCell3(x, y, z);
  };

  // Wake settled cells so they re-evaluate (e.g. after switching liquid mode, a
  // resting pool must re-level under the new rules). Rebuilds awakeRow exactly.
  PG.wakeLiquids = function () {
    if (!PG.mode3d) return; // 2D has no sleep system
    const t3 = PG.t3, s3 = PG.sleep3, S = PG.SLEEPABLE, ar = PG.awakeRow;
    const W = PG.W, H = PG.H, D = PG.D;
    for (let i = 0; i < t3.length; i++) { const t = t3[i]; if (t && S[t]) s3[i] = 0; }
    for (let row = 0; row < D * H; row++) {
      const base = row * W; let c = 0;
      for (let x = 0; x < W; x++) { const i = base + x; if (t3[i] !== 0 && !s3[i]) c++; }
      ar[row] = c;
    }
  };

  PG.doGas3 = function (x, y, z) {
    if (PG.windPush3(x, y, z, 3)) return;
    if (PG.chance(3)) {
      const [dx, dz] = HDIRS[PG.rand(4)];
      PG.tryMove3(x, y, z, x + dx, y, z + dz);
    } else {
      const [dx, dz] = PG.chance(2) ? HDIRS[PG.rand(4)] : [0, 0];
      PG.tryMove3(x, y, z, x + dx, y - 1, z + dz);
    }
  };

  PG.explode3 = function (x, y, z, radius, power) {
    PG.air3.blast(x, y, z, radius, power);
    const r2 = radius * radius;
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (!PG.inBounds3(nx, ny, nz)) continue;
          const i = (nz * PG.H + ny) * PG.W + nx;
          const t = PG.t3[i];
          if (t === E.BLOCK || t === E.GLASS) continue;
          if (t === E.C4 || t === E.NITRO || t === E.GPOWDER || t === E.BOMB) {
            PG.set3(nx, ny, nz, E.FIRE, 1); continue;
          }
          if (d2 < r2 * 0.55 || PG.chance(2)) {
            PG.set3(nx, ny, nz, E.FIRE, 20 + PG.rand(30));
          }
        }
    if (PG.player) {
      const dz = (PG.player.z - z);
      if (Math.abs(dz) < radius + 3) PG.player.hitByBlast(x, y, radius);
    }
  };

  // ---- main 3D step -----------------------------------------------------------
  PG.stepSim3 = function () {
    PG.frame++;
    PG.stamp = (PG.frame & 255) || 1;
    const W = PG.W, H = PG.H, D = PG.D;
    const t3 = PG.t3, u3 = PG.u3, sc = PG.sliceCount, ar = PG.awakeRow, slp = PG.sleep3;

    PG.air3.step();
    airCalm3 = PG.air3.calm(); // liquids skip reading a dead-calm air field
    kick3 = PG.rf(); dither3 = (PG.frame * 0.6180339887) % 1;
    W3 = W; H3 = H; D3 = D; T3 = t3; L3 = PG.l3;

    const ltr = (PG.frame & 1) === 0;
    const zf = (PG.frame & 2) === 0;
    for (let zi = 0; zi < D; zi++) {
      const z = zf ? zi : D - 1 - zi;
      if (sc[z] === 0) continue;
      const slice = z * H * W, zrow = z * H;
      for (let y = H - 1; y >= 0; y--) {
        // skip rows with no AWAKE cells — settled water/sand cost nothing, so a
        // full, static container of water runs at 60fps. A neighbour change
        // (move, erase, drop) wakes cells via wakeNeighbors3.
        if (ar[zrow + y] === 0) continue;
        const row = slice + y * W;
        for (let k = 0; k < W; k++) {
          const x = ltr ? k : W - 1 - k;
          const i = row + x;
          const t = t3[i];
          if (t === 0 || slp[i]) continue; // skip empty + sleeping cells
          if (u3[i] === PG.stamp) continue;
          u3[i] = PG.stamp;
          const fn = PG.behaviors3[t];
          if (fn) fn(x, y, z, i);
        }
      }
    }
    if (PG.fluidMode) PG.fluidStep(true);
    // total dot count for the HUD/budget = sum of per-slice counts
    let count = 0;
    for (let z = 0; z < D; z++) count += sc[z];
    PG.partCount = count;
    if (PG.player) PG.player.update();
  };
})();
