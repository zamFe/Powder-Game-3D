// Fluid liquid mode: a pressure-projected flow, shared by 2D and 3D.
//
// Classic liquid (engine.js) is Powder Game's: every cell pushes itself
// toward open space, so a pool levels, but pressure never travels through
// the body. Here the liquid is an incompressible fluid instead (FLIP on a
// MAC grid whose cells are the sim's own cells). Each liquid cell carries its
// velocity in its life value, packed exactly as in classic mode. Every frame,
// for the liquid that is awake (and, in 3D, the sleeping liquid touching it):
//   1. velocities go onto the faces between cells (the mean of the two
//      sides; a wall face is shut; against air, the liquid's own), and
//      gravity is added to every open face below and above a cell;
//   2. a pressure solve (red-black SOR, warm-started from last frame)
//      removes the divergence, with zero pressure in air. That is what lifts
//      the far arm of a U-tube, squirts a jet out of a hole in a tank and
//      throws a splash up where a falling heap lands. A gap inside the
//      liquid is air too, so it closes up (or rises as a bubble) instead of
//      leaving the body full of holes;
//   3. each cell takes back the change in its faces' velocity (FLIP, with a
//      little of the plain face velocity so noise dies down) and moves by it.
//      Moves are made one axis at a time, front of the flow first, so a body
//      moving one way moves as one.
// Heavier liquids sink through lighter ones by swapping, as in classic.
// The work is per liquid cell: cells come from the list the liquid
// behaviours report, and neighbours are found through a grid stamped per
// frame (a hash if the box around them is huge), so a thin splash across a
// big box costs no more than a compact one.
// In 3D, sleeping liquid next to awake liquid joins the solve and wakes if
// the flow pulls on it (so a push travels into a settled pool); further
// sleeping liquid acts as a wall. A cell that has stayed put for a while goes
// to sleep, once the body it belongs to is level; with nothing awake the
// solve is skipped entirely.
(function () {
  const E = PG.E, els = PG.elements, NT = els.length;
  const FLOWS = PG.FLOWS, DENS = PG.DENS;

  // what blocks the flow: walls, powders, creatures (gas and fire don't)
  const SOLIDT = new Uint8Array(NT);
  els.forEach((el, t) => {
    if (el && t && (el.state === "static" || el.state === "powder" || el.state === "life")) SOLIDT[t] = 1;
  });
  // per liquid: how much the air carries it, and how much speed survives a
  // frame (magma is thick, everything else runs freely)
  const ADV = new Float32Array(NT), KEEP = new Float32Array(NT);
  [[E.WATER, "water"], [E.SALTWATER, "salt"], [E.OIL, "oil"], [E.MERCURY, "mercury"],
   [E.NITRO, "nitro"], [E.SOAPY, "soapy"], [E.ACID, "acid"], [E.MAGMA, "magma"]]
    .forEach(([t, k]) => { ADV[t] = PG.LIQUID[k].adv; KEEP[t] = t === E.MAGMA ? 0.86 : 0.996; });

  const G = 0.05;        // gravity, cells per frame per frame
  const VMAX = 3.6;      // speed cap, cells per frame (the packed range is ±4)
  const FLIP = 0.94;     // share of FLIP (the rest is PIC: smoother, damps noise)
  const OMEGA = 1.7;     // over-relaxation of the pressure solve
  PG.fluidIter = [30, 12];  // pressure iterations: 2D, 3D (warm-started, so few will do)
  const WAKE = 0.15;     // speed that wakes a sleeping cell
  const REST = 0.3;      // a cell that didn't move and isn't faster than this is still…
  const STILL = 20;      // …and one still this many frames running goes to sleep (3D),
  const LEVEL = 2.5;     // …if the body it is part of is level to within this many cells
  const KINV = [0, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6];
  const TIP = 0.15;      // sideways nudge for a balanced one-wide stack
  const SLOW = 0.3, SURF = 0;    // surface friction: below SLOW, keep SURF of the speed
  const FLOOR = 0.95;    // speed kept per frame sliding on a solid
  const WAVE_PUSH = [0, 0.02, 0.04];   // 2D wave drive per waves setting

  // the awake liquid this frame, as reported by PG.liquid / liquid3
  let an = 0, alist = new Int32Array(4096);
  PG.fluidAdd = function (x, y, z) {
    if (an === alist.length) { const b = new Int32Array(an * 2); b.set(alist); alist = b; }
    alist[an++] = (z * PG.H + y) * PG.W + x;
  };

  // ---- per-cell buffers (grown on demand, never shrunk) ----
  // Slot Z (= capV, one past the last) is a dummy that stays at zero speed
  // and zero pressure: a face to air or a wall points there, so the solver's
  // inner loops need no branches.
  let capV = 0, Z = 0, vi, lc, tp, px, py, pz, wx, wy, wz, mvl, still, uf, level, hmin, hmax, ox, oy, oz, fvx, fvy, fvz, moved, kk, om, rhs, p, nbp, nbv, red, black;
  function growVoxels(n) {
    if (n <= capV) return;
    const c = Math.max(n, capV * 2, 1024);
    const g = (A, B, k) => { const b = new B((c + 1) * (k || 1)); if (A) b.set(A.subarray(0, capV * (k || 1))); return b; };
    vi = g(vi, Int32Array); lc = g(lc, Int32Array); tp = g(tp, Uint8Array);
    px = g(px, Int32Array); py = g(py, Int32Array); pz = g(pz, Int32Array);
    ox = g(ox, Float32Array); oy = g(oy, Float32Array); oz = g(oz, Float32Array);
    fvx = g(fvx, Float32Array); fvy = g(fvy, Float32Array); fvz = g(fvz, Float32Array);
    moved = g(moved, Uint8Array); kk = g(kk, Uint8Array); om = g(om, Uint8Array); still = g(still, Uint8Array);
    uf = g(uf, Int32Array); level = g(level, Uint8Array); hmin = g(hmin, Float32Array); hmax = g(hmax, Float32Array);
    wx = g(wx, Int8Array); wy = g(wy, Int8Array); wz = g(wz, Int8Array); mvl = g(mvl, Int32Array);
    rhs = g(rhs, Float32Array); p = g(p, Float32Array);
    nbp = g(nbp, Int32Array, 6); nbv = g(nbv, Int32Array, 6);
    red = g(red, Int32Array); black = g(black, Int32Array);
    capV = c; Z = c;
  }

  // ---- open-addressing hashes keyed by cell index ----
  // cur: cell -> slot in this frame's list; old: cell -> last frame's pressure
  let hcap = 0, hmask = 0, hshift = 32, hn = 0, hk = new Int32Array(0), hv = new Int32Array(0);
  let qcap = 0, qmask = 0, qshift = 32, qk = new Int32Array(0), qv = new Float32Array(0), qc = new Uint8Array(0);
  let qstill = 0;                                            // qget's second result
  const HASH = 0x9E3779B1 | 0;
  function hreset(n) {
    let c = 1024; while (c < n * 2) c *= 2;
    if (c > hcap) { hcap = c; hk = new Int32Array(c); hv = new Int32Array(c); } else hk.fill(0, 0, hcap);
    hmask = hcap - 1; hshift = 32 - Math.log2(hcap); hn = 0;
  }
  function hget(i) {
    let h = Math.imul(i + 1, HASH) >>> hshift, k;
    while ((k = hk[h]) !== 0) { if (k === i + 1) return hv[h]; h = (h + 1) & hmask; }
    return -1;
  }
  function hput(i, n) {
    if ((hn + 1) * 2 > hcap) {                               // grow: re-insert everything
      const ok = hk, ov = hv, oc = hcap;
      hcap *= 2; hk = new Int32Array(hcap); hv = new Int32Array(hcap);
      hmask = hcap - 1; hshift = 32 - Math.log2(hcap);
      for (let q = 0; q < oc; q++) if (ok[q]) {
        let h = Math.imul(ok[q], HASH) >>> hshift;
        while (hk[h] !== 0) h = (h + 1) & hmask;
        hk[h] = ok[q]; hv[h] = ov[q];
      }
    }
    let h = Math.imul(i + 1, HASH) >>> hshift;
    while (hk[h] !== 0) h = (h + 1) & hmask;
    hk[h] = i + 1; hv[h] = n; hn++;
  }
  function qget(i) {                                         // last frame's pressure (and stillness)
    qstill = 0;
    if (qcap === 0) return 0;
    let h = Math.imul(i + 1, HASH) >>> qshift, k;
    while ((k = qk[h]) !== 0) { if (k === i + 1) { qstill = qc[h]; return qv[h]; } h = (h + 1) & qmask; }
    return 0;
  }
  function qsave(n) {                                        // this frame's, by the cell it ended in
    let c = 1024; while (c < n * 2) c *= 2;
    if (c > qcap) { qcap = c; qk = new Int32Array(c); qv = new Float32Array(c); qc = new Uint8Array(c); } else qk.fill(0, 0, qcap);
    qmask = qcap - 1; qshift = 32 - Math.log2(qcap);
    for (let m = 0; m < n; m++) {
      const k = vi[m] + 1;
      let h = Math.imul(k, HASH) >>> qshift;
      while (qk[h] !== 0 && qk[h] !== k) h = (h + 1) & qmask;
      qk[h] = k; qv[h] = p[m]; qc[h] = still[m];
    }
  }
  let capB = 0, bucket, lastW = 0, lastH = 0, lastD = 0;
  // the dense lookup grid (see the gather)
  const DENSE_MAX = 1 << 22;
  let capG = 0, gstamp = new Int32Array(0), gslot = new Int32Array(0), tag = 0;

  PG.fluidStep = function (three) {
    const listed = an;
    an = 0;
    if (listed === 0) return;
    const W = PG.W, H = PG.H, D = three ? PG.D : 1, WH = W * H;
    const T = three ? PG.t3 : PG.type, L = three ? PG.l3 : PG.life;
    // last frame's pressures are keyed by cell index: a new grid shape (a
    // resize, or 2D <-> 3D) makes them point at the wrong cells
    if (W !== lastW || H !== lastH || D !== lastD) { lastW = W; lastH = H; lastD = D; qk.fill(0); }
    const s3 = three ? PG.sleep3 : null, ar3 = three ? PG.awakeRow : null;
    const ITER = PG.fluidIter[three ? 1 : 0];

    // ---- gather: the awake liquid, then (3D) the sleeping liquid touching it ----
    let nv = 0, x0 = W, x1 = 0, y0 = H, y1 = 0, z0 = D, z1 = 0;
    for (let q = 0; q < listed; q++) {
      const i = alist[q], t = T[i];
      if (FLOWS[t] !== 1) continue;                          // reacted, or moved, since
      if (nv >= capV) growVoxels(nv + 1);
      const x = i % W, y = ((i / W) | 0) % H, z = (i / WH) | 0;
      vi[nv] = i; tp[nv] = t; px[nv] = x; py[nv] = y; pz[nv] = z; nv++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (nv === 0) return;
    // Cell -> slot lookups: a grid over the box around it (2 cells of room
    // for the sleeping shell and its neighbours), stamped per frame so it is
    // never cleared; a hash instead when that box would be huge and sparse.
    x0 = Math.max(0, x0 - 2); x1 = Math.min(W - 1, x1 + 2);
    y0 = Math.max(0, y0 - 2); y1 = Math.min(H - 1, y1 + 2);
    z0 = Math.max(0, z0 - 2); z1 = Math.min(D - 1, z1 + 2);
    const gx = x1 - x0 + 1, gxy = gx * (y1 - y0 + 1), gn = gxy * (z1 - z0 + 1);
    const dense = gn <= DENSE_MAX;
    if (dense) {
      if (gn > capG) { capG = Math.max(gn, capG * 2); gstamp = new Int32Array(capG); gslot = new Int32Array(capG); }
      if (++tag > 0x7ffffff0) { tag = 1; gstamp.fill(0); }
    } else hreset(nv * 2);
    const local = (x, y, z) => (z - z0) * gxy + (y - y0) * gx + x - x0;
    const slot = dense ? (j, c) => (gstamp[c] === tag ? gslot[c] : -1) : (j) => hget(j);
    function put(n) {
      const c = local(px[n], py[n], pz[n]);
      lc[n] = c;
      if (dense) { if (gstamp[c] === tag) return false; gstamp[c] = tag; gslot[c] = n; return true; }
      if (hget(vi[n]) >= 0) return false;
      hput(vi[n], n); return true;
    }
    { let k = 0;                                             // register, dropping any repeat
      for (let n = 0; n < nv; n++) {
        if (k !== n) { vi[k] = vi[n]; tp[k] = tp[n]; px[k] = px[n]; py[k] = py[n]; pz[k] = pz[n]; }
        if (put(k)) k++;
      }
      nv = k; }
    const awake = nv;
    if (three) {
      const shell = (j, x, y, z) => {
        if (!s3[j] || FLOWS[T[j]] !== 1) return;
        const c = local(x, y, z);
        if (slot(j, c) >= 0) return;
        if (nv >= capV) growVoxels(nv + 1);
        vi[nv] = j; tp[nv] = T[j]; px[nv] = x; py[nv] = y; pz[nv] = z;
        put(nv); nv++;
      };
      for (let n = 0; n < awake; n++) {
        const i = vi[n], x = px[n], y = py[n], z = pz[n];
        if (x > 0) shell(i - 1, x - 1, y, z);
        if (x < W - 1) shell(i + 1, x + 1, y, z);
        if (y > 0) shell(i - W, x, y - 1, z);
        if (y < H - 1) shell(i + W, x, y + 1, z);
        if (z > 0) shell(i - WH, x, y, z - 1);
        if (z < D - 1) shell(i + WH, x, y, z + 1);
      }
    }
    // the box the cells may move in (one pass can carry a cell a few past it)
    x0 = Math.max(0, x0 - 4); x1 = Math.min(W - 1, x1 + 4);
    y0 = Math.max(0, y0 - 4); y1 = Math.min(H - 1, y1 + 4);
    z0 = Math.max(0, z0 - 4); z1 = Math.min(D - 1, z1 + 4);

    // velocities (plus the air's pull) and last frame's pressure
    let nearSleep = false;                                   // is anything about to settle?
    const air3 = three ? PG.air3 : null, air2 = PG.air;
    const airOn = three ? !air3.calm() : true;
    for (let n = 0; n < nv; n++) {
      const i = vi[n], l = L[i];
      let ux = 0, uy = 0, uz = 0;
      if (l > 0) {
        ux = ((l << 22) >> 22) * 0.0078125; uy = ((l << 12) >> 22) * 0.0078125;
        uz = ((l << 2) >> 22) * 0.0078125;
      }
      if (airOn) {
        const a = ADV[tp[n]] * 0.5, x = px[n], y = py[n];
        if (three) { const z = pz[n]; ux += a * air3.velX(x, y, z); uy += a * air3.velY(x, y, z); uz += a * air3.velZ(x, y, z); }
        else { ux += a * air2.velX(x, y); uy += a * air2.velY(x, y); }
      }
      ox[n] = ux; oy[n] = uy; oz[n] = uz;
      p[n] = qget(i); still[n] = qstill;
      if (qstill >= STILL - 1) nearSleep = true;
    }

    // ---- 1+2. pressure: zero in air, walls shut, no divergence in the liquid ----
    // Each of a cell's six faces (left, right, up, down, front, back) is open
    // or shut (bit k of om). Across a face, nbp is the neighbour's slot for
    // pressure (Z, zero, unless it is liquid) and nbv its slot for velocity
    // (the cell itself unless it is liquid): the velocity a face starts with
    // is the mean of the two sides, so the liquid's own against air or a
    // wall. A shut face then ends at zero, an open one gains G (y faces) and
    // loses the pressure difference across it.
    p[Z] = 0; ox[Z] = oy[Z] = oz[Z] = 0;
    let nr = 0, nbk = 0;
    for (let n = 0; n < nv; n++) {
      const i = vi[n], x = px[n], y = py[n], z = pz[n], b = n * 6;
      nbp[b] = nbp[b + 1] = nbp[b + 2] = nbp[b + 3] = nbp[b + 4] = nbp[b + 5] = Z;
      nbv[b] = nbv[b + 1] = nbv[b + 2] = nbv[b + 3] = nbv[b + 4] = nbv[b + 5] = n;
      const c = lc[n];
      let m = 0, j, t, q;
      if (x > 0) {
        t = T[j = i - 1];
        if (t === 0 || (FLOWS[t] !== 1 && !SOLIDT[t])) m |= 1;                              // air: pressure 0
        else if (FLOWS[t] === 1 && (q = dense ? (gstamp[c - 1] === tag ? gslot[c - 1] : -1) : hget(j)) >= 0) {
          nbp[b + 0] = q; nbv[b + 0] = q; m |= 1;
        }
      }
      if (x < W - 1) {
        t = T[j = i + 1];
        if (t === 0 || (FLOWS[t] !== 1 && !SOLIDT[t])) m |= 2;                              // air: pressure 0
        else if (FLOWS[t] === 1 && (q = dense ? (gstamp[c + 1] === tag ? gslot[c + 1] : -1) : hget(j)) >= 0) {
          nbp[b + 1] = q; nbv[b + 1] = q; m |= 2;
        }
      }
      if (y > 0) {
        t = T[j = i - W];
        if (t === 0 || (FLOWS[t] !== 1 && !SOLIDT[t])) m |= 4;                              // air: pressure 0
        else if (FLOWS[t] === 1 && (q = dense ? (gstamp[c - gx] === tag ? gslot[c - gx] : -1) : hget(j)) >= 0) {
          nbp[b + 2] = q; nbv[b + 2] = q; m |= 4;
        }
      }
      if (y < H - 1) {
        t = T[j = i + W];
        if (t === 0 || (FLOWS[t] !== 1 && !SOLIDT[t])) m |= 8;                              // air: pressure 0
        else if (FLOWS[t] === 1 && (q = dense ? (gstamp[c + gx] === tag ? gslot[c + gx] : -1) : hget(j)) >= 0) {
          nbp[b + 3] = q; nbv[b + 3] = q; m |= 8;
        }
      }
      if (three && z > 0) {
        t = T[j = i - WH];
        if (t === 0 || (FLOWS[t] !== 1 && !SOLIDT[t])) m |= 16;                              // air: pressure 0
        else if (FLOWS[t] === 1 && (q = dense ? (gstamp[c - gxy] === tag ? gslot[c - gxy] : -1) : hget(j)) >= 0) {
          nbp[b + 4] = q; nbv[b + 4] = q; m |= 16;
        }
      }
      if (three && z < D - 1) {
        t = T[j = i + WH];
        if (t === 0 || (FLOWS[t] !== 1 && !SOLIDT[t])) m |= 32;                              // air: pressure 0
        else if (FLOWS[t] === 1 && (q = dense ? (gstamp[c + gxy] === tag ? gslot[c + gxy] : -1) : hget(j)) >= 0) {
          nbp[b + 5] = q; nbv[b + 5] = q; m |= 32;
        }
      }
      om[n] = m;
      const k = (m & 1) + (m >> 1 & 1) + (m >> 2 & 1) + (m >> 3 & 1) + (m >> 4 & 1) + (m >> 5 & 1);
      kk[n] = k;
      if (k === 0) { p[n] = 0; rhs[n] = 0; continue; }       // sealed in: nothing to solve
      const ux = ox[n], uy = oy[n], uz = oz[n];
      // outflow through the open faces (shut ones point at Z and drop out)
      const out = (m >> 1 & 1) * (ux + ox[nbv[b + 1]]) - (m & 1) * (ux + ox[nbv[b]]) +
                  (m >> 3 & 1) * (uy + oy[nbv[b + 3]] + 2 * G) - (m >> 2 & 1) * (uy + oy[nbv[b + 2]] + 2 * G) +
                  (m >> 5 & 1) * (uz + oz[nbv[b + 5]]) - (m >> 4 & 1) * (uz + oz[nbv[b + 4]]);
      rhs[n] = -0.5 * out;
      if ((x + y + z) & 1) black[nbk++] = n; else red[nr++] = n;
    }
    for (let it = 0; it < ITER; it++) {
      relax(red, nr); relax(black, nbk);
    }
    function relax(list, cnt) {
      for (let q = 0; q < cnt; q++) {
        const n = list[q], b = n * 6;
        const s = rhs[n] + p[nbp[b]] + p[nbp[b + 1]] + p[nbp[b + 2]] + p[nbp[b + 3]] + p[nbp[b + 4]] + p[nbp[b + 5]];
        p[n] += OMEGA * (s * KINV[kk[n]] - p[n]);
      }
    }

    // ---- is each connected body level? ----
    // Its hydraulic head (height + pressure / G) is the same everywhere in
    // liquid at rest; a body whose heads still differ is on its way somewhere
    // (a U-tube at the turn of a slosh: everything slow, nothing level), so
    // none of it may sleep yet. (Only worked out when something could.)
    if (three && nearSleep) {
      for (let n = 0; n < nv; n++) uf[n] = n;
      const find = (a) => { while (uf[a] !== a) a = uf[a] = uf[uf[a]]; return a; };
      for (let n = 0; n < nv; n++) {
        const b = n * 6;
        for (let k = 1; k < 6; k += 2) {
          const q = nbp[b + k];
          if (q !== Z) { const ra = find(n), rb = find(q); if (ra !== rb) uf[ra] = rb; }
        }
      }
      for (let n = 0; n < nv; n++) { hmin[n] = 1e9; hmax[n] = -1e9; }
      for (let n = 0; n < nv; n++) {
        const r = find(n), h = H - 1 - py[n] + p[n] * (1 / G);
        if (h < hmin[r]) hmin[r] = h;
        if (h > hmax[r]) hmax[r] = h;
      }
      for (let n = 0; n < nv; n++) { const r = find(n); level[n] = hmax[r] - hmin[r] <= LEVEL ? 1 : 0; }
    }

    // ---- 3. back to the cells: FLIP update, damping, speed cap ----
    // h: the cell's velocity as its faces started; g: as they ended (FLIP
    // hands the cell the difference, so running into a wall stops it)
    const ph = (PG.frame * 0.6180339887) % 1;
    const ry = ph, rx = (ph + 0.382) % 1, rz = (ph + 0.764) % 1;  // rounding offsets
    const WV = PG.WAVE, waveA = three ? 0 : WAVE_PUSH[PG.waveStr | 0];
    for (let n = 0; n < nv; n++) {
      const b = n * 6, m = om[n], pc = p[n], ux = ox[n], uy = oy[n], uz = oz[n];
      const o0 = m & 1, o1 = m >> 1 & 1, o2 = m >> 2 & 1, o3 = m >> 3 & 1, o4 = m >> 4 & 1, o5 = m >> 5 & 1;
      const fx0 = ux + ox[nbv[b]], fx1 = ux + ox[nbv[b + 1]];       // (twice the face speeds)
      const fy0 = uy + oy[nbv[b + 2]], fy1 = uy + oy[nbv[b + 3]];
      const fz0 = uz + oz[nbv[b + 4]], fz1 = uz + oz[nbv[b + 5]];
      const hx = 0.25 * (fx0 + fx1), hy = 0.25 * (fy0 + fy1), hz = 0.25 * (fz0 + fz1);
      const gx = 0.5 * (o0 * (0.5 * fx0 - pc + p[nbp[b]]) + o1 * (0.5 * fx1 - p[nbp[b + 1]] + pc));
      const gy = 0.5 * (o2 * (0.5 * fy0 + G - pc + p[nbp[b + 2]]) + o3 * (0.5 * fy1 + G - p[nbp[b + 3]] + pc));
      const gz = 0.5 * (o4 * (0.5 * fz0 - pc + p[nbp[b + 4]]) + o5 * (0.5 * fz1 - p[nbp[b + 5]] + pc));
      const keep = KEEP[tp[n]];
      let vx = (FLIP * (ux - hx) + gx) * keep;
      let vy = (FLIP * (uy - hy) + gy) * keep;
      let vz = (FLIP * (uz - hz) + gz) * keep;
      // Friction with the floor (or any solid under it): a thin film would
      // otherwise glide across the box for ages.
      if (!(m & 8)) { vx *= FLOOR; vz *= FLOOR; }
      // Surface friction: a slow cell resting on something (a solid, or
      // liquid that bears weight: falling liquid has no pressure in it), with
      // air above and beside it, is a loose bit of a part-filled top layer.
      // Pressure from the full layer under it keeps shoving it up and sideways
      // into the gaps, so a still pool would shimmer forever and never sleep;
      // this lets it come to rest. (A whole surface and anything faster than
      // SLOW are left alone.)
      if ((m & 4) && nbp[b + 2] === Z && (!(m & 8) || (nbp[b + 3] !== Z && p[nbp[b + 3]] > 0.5 * G)) &&
          (((m & 1) && nbp[b] === Z) || ((m & 2) && nbp[b + 1] === Z) ||
           ((m & 16) && nbp[b + 4] === Z) || ((m & 32) && nbp[b + 5] === Z))) {
        const sp = (vx < 0 ? -vx : vx) + (vy < 0 ? -vy : vy) + (vz < 0 ? -vz : vz);
        if (sp < SLOW) { vx *= SURF; vy *= SURF; vz *= SURF; }
      }
      // Waves (2D): the surface is pushed toward the crests of the same
      // travelling wave classic mode herds it with, so real waves form and
      // roll. (In 3D a settled pool sleeps and the renderer draws its swell.)
      if (waveA && (m & 4) && nbp[b + 2] === Z) vx += waveA * Math.cos(px[n] * WV.K - PG.frame * WV.SPEED);
      // A cell in a one-wide stack of liquid (liquid above and below, air on
      // both sides of an axis) is perfectly balanced, so nothing would ever
      // tip it: the middle of a symmetric splash leaves such a spike. Nudge
      // it, always the same way for a given column, so it topples.
      if (nbp[b + 2] !== Z && nbp[b + 3] !== Z) {
        if ((m & 3) === 3 && nbp[b] === Z && nbp[b + 1] === Z) vx += (px[n] + pz[n]) & 1 ? TIP : -TIP;
        if ((m & 48) === 48 && nbp[b + 4] === Z && nbp[b + 5] === Z) vz += (px[n] + pz[n]) & 2 ? TIP : -TIP;
      }
      vx = vx > VMAX ? VMAX : vx < -VMAX ? -VMAX : vx;
      vy = vy > VMAX ? VMAX : vy < -VMAX ? -VMAX : vy;
      vz = vz > VMAX ? VMAX : vz < -VMAX ? -VMAX : vz;
      moved[n] = 0; wx[n] = wy[n] = wz[n] = 0;
      if (n >= awake) {
        // a sleeping cell stays asleep unless the flow really pulls on it
        if (vx < WAKE && vx > -WAKE && vy < WAKE && vy > -WAKE && vz < WAKE && vz > -WAKE) {
          moved[n] = 2; continue;                           // 2: leave it be
        }
        const i = vi[n];
        if (s3[i]) { s3[i] = 0; ar3[pz[n] * H + py[n]]++; }
      }
      fvx[n] = vx; fvy[n] = vy; fvz[n] = vz;
      const ax = vx < 0 ? -vx : vx, ay = vy < 0 ? -vy : vy, az = vz < 0 ? -vz : vz;
      // Cells to move per axis: whole cells, plus one more by a rounding
      // that is the same for every cell this frame, so cells moving alike
      // keep step exactly (a per-cell, or even per-column, rounding lets
      // them drift apart, and a falling block grows ragged edges).
      let k = (ay + ry) | 0;
      wy[n] = vy < 0 ? -k : k;
      if (k === 0 && py[n] + 1 < H) {                       // heavier liquid sinks through lighter
        const t = T[vi[n] + W];
        if (t !== 0 && FLOWS[t] !== 0 && DENS[tp[n]] > DENS[t] && (PG.frame + px[n] + pz[n]) & 1) wy[n] = 1;
      }
      k = (ax + rx) | 0; wx[n] = vx < 0 ? -k : k;
      k = (az + rz) | 0; wz[n] = vz < 0 ? -k : k;
    }

    // ---- moves: one axis at a time, the front of the flow first ----
    const mv = three ? PG.tryMove3 : (x, y, z, nx2, ny2) => PG.tryMove(x, y, nx2, ny2);
    // A cell stopped by liquid that hasn't moved out of the way yet (flow
    // turning a corner: the y pass runs before the x pass frees the space)
    // keeps the rest of its move for a second round. (Its speed stays: that
    // push is what drives a landed heap to spread.)
    for (let round = 0; round < 2; round++) {
      movePass(1, py, wy, fvy, y0, y1 + 1, W, H);           // y first: falling and rising
      movePass(0, px, wx, fvx, x0, x1 + 1, 1, W);
      if (three) movePass(2, pz, wz, fvz, z0, z1 + 1, WH, D);
    }

    function movePass(ax, P, WT, V, lo, hi, stride, size) {
      // the movers, counting-sorted by position along the axis (an earlier
      // pass may have carried one just past the range: clamp)
      let nm = 0;
      for (let n = 0; n < nv; n++) if (WT[n] !== 0) mvl[nm++] = n;
      if (nm === 0) return;
      const range = hi - lo;
      if (capB < range + 1 || capB < nm) { capB = Math.max(range + 1, nv) * 2; bucket = new Int32Array(capB * 2); }
      const start = bucket, order = bucket.subarray(capB);
      start.fill(0, 0, range + 1);
      for (let q = 0; q < nm; q++) { let k = P[mvl[q]] - lo; k = k < 0 ? 0 : k >= range ? range - 1 : k; start[k + 1]++; }
      for (let k = 1; k <= range; k++) start[k] += start[k - 1];
      for (let q = 0; q < nm; q++) { const n = mvl[q]; let k = P[n] - lo; k = k < 0 ? 0 : k >= range ? range - 1 : k; order[start[k]++] = n; }
      // positive movers from the far end, negative movers from the near end
      for (let q = nm - 1; q >= 0; q--) { const n = order[q]; if (WT[n] > 0) step(n, ax, 1, WT[n], V, stride, size, WT); }
      for (let q = 0; q < nm; q++) { const n = order[q]; if (WT[n] < 0) step(n, ax, -1, -WT[n], V, stride, size, WT); }
    }

    function step(n, ax, s, want, V, stride, size, WT) {
      const x = px[n], y = py[n], z = pz[n], i = vi[n], t = T[i];
      // a cell another one sank past was swapped out of its slot: it sits
      // out the rest of this frame (its velocity went with it)
      if (t !== tp[n]) { WT[n] = 0; return; }
      const pos = ax === 0 ? x : ax === 1 ? y : z;
      const lim = s > 0 ? size - 1 - pos : pos;
      if (want > lim) want = lim;
      let m = 0, j = i;
      const st = s * stride;
      while (m < want && T[j + st] === 0) { j += st; m++; }
      let cx = x, cy = y, cz = z;
      if (m > 0) {
        if (ax === 0) cx += s * m; else if (ax === 1) cy += s * m; else cz += s * m;
        mv(x, y, z, cx, cy, cz);
      }
      let left = 0;
      if (m < want) {
        // stopped by something: sink into a lighter liquid (or rise through
        // gas); held up by liquid, try the rest again next round; a wall
        // takes the speed out of that axis
        const b = T[j + st];
        let nx2 = cx, ny2 = cy, nz2 = cz;
        if (ax === 0) nx2 += s; else if (ax === 1) ny2 += s; else nz2 += s;
        if (FLOWS[b] === 2 || (FLOWS[b] === 1 && DENS[t] > DENS[b] && !(ax === 1 && s < 0))) {
          if (mv(cx, cy, cz, nx2, ny2, nz2)) { cx = nx2; cy = ny2; cz = nz2; m++; }
        } else if (FLOWS[b] === 1) left = want - m;
        else if (FLOWS[b] === 0) V[n] = 0;
      }
      WT[n] = s * left;
      if (m > 0) {
        px[n] = cx; py[n] = cy; pz[n] = cz; vi[n] = (cz * H + cy) * W + cx; moved[n] = 1;
      }
    }

    // ---- store the velocities; settle what has stopped ----
    // A cell sleeps once it has stayed put for a run of frames, if the body
    // it belongs to is level (see the head check after the solve).
    for (let n = 0; n < nv; n++) {
      if (moved[n] === 2) continue;
      const i = vi[n];
      if (T[i] !== tp[n] || L[i] < 0) continue;             // swapped away, or a conductor cooling down
      const vx = fvx[n], vy = fvy[n], vz = fvz[n];
      let qx = Math.round(vx * 128), qy = Math.round(vy * 128), qz = Math.round(vz * 128);
      qx = qx > 511 ? 511 : qx < -511 ? -511 : qx;
      qy = qy > 511 ? 511 : qy < -511 ? -511 : qy;
      qz = qz > 511 ? 511 : qz < -511 ? -511 : qz;
      L[i] = (qx & 1023) | ((qy & 1023) << 10) | ((qz & 1023) << 20);
      if (!moved[n] && vx < REST && vx > -REST && vy < REST && vy > -REST && vz < REST && vz > -REST &&
          (py[n] + 1 >= H || T[i + W] !== 0)) {
        if (still[n] < 255) still[n]++;
        if (three && nearSleep && level[n] && still[n] >= STILL) PG.sleepCell3(px[n], py[n], pz[n]);
      } else still[n] = 0;
    }
    qsave(nv);
  };
})();
