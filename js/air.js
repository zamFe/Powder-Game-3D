// Air simulation: coarse pressure + velocity field (1 air cell = 4 sim cells).
// Powder-Toy / Powder-Game style: a COUPLED pressure+velocity field where the
// velocity self-advects (semi-Lagrangian), so gusts travel and swirl and
// persist instead of just dissipating. Moving particles drag the air (see
// engine.js coupling), giving the classic "rivers of particles" behaviour.
PG.air = (function () {
  const CELL = 4, INV = 1 / CELL;
  let AW = 0, AH = 0;
  let vx, vy, p, vx2, vy2, p2, wall;

  // Lower loss + advection -> longer-lived, gustier wind than plain diffusion.
  const VEL_LOSS = 0.985, PRS_LOSS = 0.96, GRAD = 0.16, MAXV = 12, MAXP = 40;

  function init(w, h) {
    AW = Math.ceil(w / CELL);
    AH = Math.ceil(h / CELL);
    const n = AW * AH;
    vx = new Float32Array(n);  vy = new Float32Array(n);  p = new Float32Array(n);
    vx2 = new Float32Array(n); vy2 = new Float32Array(n); p2 = new Float32Array(n);
    wall = new Uint8Array(n);
  }

  function clear() { vx.fill(0); vy.fill(0); p.fill(0); wall.fill(0); }

  function setWall(ax, ay) { wall[ay * AW + ax] = 1; }
  function clearWalls() { wall.fill(0); }

  function clamp(v, m) { return v > m ? m : (v < -m ? -m : v); }

  // bilinear sample of array `a` at fractional air-grid coords (cx,cy)
  function sample(a, cx, cy) {
    if (cx < 0.5) cx = 0.5; else if (cx > AW - 1.5) cx = AW - 1.5;
    if (cy < 0.5) cy = 0.5; else if (cy > AH - 1.5) cy = AH - 1.5;
    const x0 = cx | 0, y0 = cy | 0;
    const fx = cx - x0, fy = cy - y0;
    const i = y0 * AW + x0;
    const top = a[i] + (a[i + 1] - a[i]) * fx;
    const bot = a[i + AW] + (a[i + AW + 1] - a[i + AW]) * fx;
    return top + (bot - top) * fy;
  }

  function step() {
    // 1. TRANSPORT: semi-Lagrangian self-advection (gusts travel in the flow
    //    direction and curl into vortices) blended with neighbor diffusion
    //    (so localized gusts spread to neighbors instead of vanishing — pure
    //    backward advection drops isolated spikes).
    for (let y = 1; y < AH - 1; y++) {
      for (let x = 1; x < AW - 1; x++) {
        const i = y * AW + x;
        if (wall[i]) { vx2[i] = 0; vy2[i] = 0; continue; }
        const sx = x - vx[i] * INV, sy = y - vy[i] * INV;
        const nax = (vx[i - 1] + vx[i + 1] + vx[i - AW] + vx[i + AW]) * 0.25;
        const nay = (vy[i - 1] + vy[i + 1] + vy[i - AW] + vy[i + AW]) * 0.25;
        vx2[i] = sample(vx, sx, sy) * 0.72 + nax * 0.28;
        vy2[i] = sample(vy, sx, sy) * 0.72 + nay * 0.28;
      }
    }
    // 2. PRESSURE from divergence of the advected field (+ light smoothing).
    for (let y = 1; y < AH - 1; y++) {
      for (let x = 1; x < AW - 1; x++) {
        const i = y * AW + x;
        if (wall[i]) { p2[i] = 0; continue; }
        const div = (vx2[i - 1] - vx2[i + 1] + vy2[i - AW] - vy2[i + AW]) * GRAD;
        const avg = (p[i - 1] + p[i + 1] + p[i - AW] + p[i + AW]) * 0.25;
        p2[i] = clamp((p[i] * 0.7 + avg * 0.3 + div) * PRS_LOSS, MAXP);
      }
    }
    // 3. VELOCITY accelerated down the new pressure gradient, with loss.
    for (let y = 1; y < AH - 1; y++) {
      for (let x = 1; x < AW - 1; x++) {
        const i = y * AW + x;
        if (wall[i]) continue;
        let nvx = (vx2[i] + (p2[i - 1] - p2[i + 1]) * GRAD) * VEL_LOSS;
        let nvy = (vy2[i] + (p2[i - AW] - p2[i + AW]) * GRAD) * VEL_LOSS;
        if (nvx > 0 && wall[i + 1]) nvx = 0;
        if (nvx < 0 && wall[i - 1]) nvx = 0;
        if (nvy > 0 && wall[i + AW]) nvy = 0;
        if (nvy < 0 && wall[i - AW]) nvy = 0;
        vx2[i] = clamp(nvx, MAXV);
        vy2[i] = clamp(nvy, MAXV);
      }
    }
    // 4. Closed-box borders.
    for (let x = 0; x < AW; x++) {
      vx2[x] = vy2[x] = p2[x] = 0;
      const b = (AH - 1) * AW + x;
      vx2[b] = vy2[b] = p2[b] = 0;
    }
    for (let y = 0; y < AH; y++) {
      const l = y * AW, r = l + AW - 1;
      vx2[l] = vy2[l] = p2[l] = 0;
      vx2[r] = vy2[r] = p2[r] = 0;
    }
    [vx, vx2] = [vx2, vx]; [vy, vy2] = [vy2, vy]; [p, p2] = [p2, p];
  }

  function idxFor(x, y) {
    let ax = (x * INV) | 0, ay = (y * INV) | 0;
    if (ax < 0) ax = 0; else if (ax >= AW) ax = AW - 1;
    if (ay < 0) ay = 0; else if (ay >= AH) ay = AH - 1;
    return ay * AW + ax;
  }
  function velX(x, y) { return vx[idxFor(x, y)]; }
  function velY(x, y) { return vy[idxFor(x, y)]; }
  function pressureAt(x, y) { return p[idxFor(x, y)]; }
  function addVel(x, y, dvx, dvy) {
    const i = idxFor(x, y);
    vx[i] = clamp(vx[i] + dvx, MAXV);
    vy[i] = clamp(vy[i] + dvy, MAXV);
  }
  function addPressure(x, y, dp) {
    const i = idxFor(x, y);
    p[i] = clamp(p[i] + dp, MAXP);
  }
  function blast(x, y, radius, power) {
    const r = Math.ceil(radius * INV);
    const cx = (x * INV) | 0, cy = (y * INV) | 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const ax = cx + dx, ay = cy + dy;
        if (ax < 1 || ay < 1 || ax >= AW - 1 || ay >= AH - 1) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const i = ay * AW + ax;
        const f = power * (1 - Math.sqrt(d2) / (r + 1));
        p[i] = clamp(p[i] + f, MAXP);
        // also kick velocity radially outward for an immediate shove
        const d = Math.sqrt(d2) || 1;
        vx[i] = clamp(vx[i] + (dx / d) * f * 0.4, MAXV);
        vy[i] = clamp(vy[i] + (dy / d) * f * 0.4, MAXV);
      }
    }
  }
  // Swirl: tangential velocity around a center (cyclone tool).
  function swirl(x, y, radius, power, suck) {
    const r = Math.ceil(radius * INV);
    const cx = (x * INV) | 0, cy = (y * INV) | 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const ax = cx + dx, ay = cy + dy;
        if (ax < 1 || ay < 1 || ax >= AW - 1 || ay >= AH - 1) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r || d < 0.5) continue;
        const i = ay * AW + ax;
        const fall = (1 - d / (r + 1)) * power;
        // tangential (perpendicular to radius) + inward suck
        vx[i] = clamp(vx[i] + (-dy / d) * fall - (dx / d) * suck, MAXV);
        vy[i] = clamp(vy[i] + (dx / d) * fall - (dy / d) * suck, MAXV);
      }
    }
  }

  return {
    init, clear, step, setWall, clearWalls,
    velX, velY, pressureAt, addVel, addPressure, blast, swirl,
    get CELL() { return CELL; },
    get AW() { return AW; }, get AH() { return AH; },
    get vx() { return vx; }, get vy() { return vy; }, get p() { return p; },
  };
})();
