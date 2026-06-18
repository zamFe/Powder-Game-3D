// 3D rendering: rotating orthographic voxel view drawn back-to-front into an
// ImageData buffer. Scene lighting: a fixed warm sun (upper-front-left) with
// per-face shading, cast shadows via a per-column heightmap, a glossy floor
// with true mirrored reflections, translucent liquids/glass, and sky specular
// on reflective surfaces.
(function () {
  const E = PG.E;

  PG.v3 = {
    t: 0, entering: false, exiting: false,
    yaw: -0.45, pitch: 0.30, zoom: 1,
    focusZ: 0, drawMode: "slice", // slice | top | floor
    _proj: null,
  };

  let img = null, buf = null, bgBuf = null, imgW = 0, imgH = 0;
  let offCanvas = null, offCtx = null;
  function ensureBuf(w, h) {
    if (imgW === w && imgH === h) return;
    imgW = w; imgH = h;
    if (!offCanvas) offCanvas = document.createElement("canvas");
    offCanvas.width = w; offCanvas.height = h;
    offCtx = offCanvas.getContext("2d");
    img = offCtx.createImageData(w, h);
    buf = new Uint32Array(img.data.buffer);
    // cached sky gradient — blitted with a fast memcpy each frame
    bgBuf = new Uint32Array(w * h);
    for (let yy = 0; yy < h; yy++) {
      const tg = yy / h;
      const r = (16 - 12 * tg) | 0, g = (14 - 10 * tg) | 0, bl = (24 - 16 * tg) | 0;
      bgBuf.fill(0xff000000 | (bl << 16) | (g << 8) | r, yy * w, yy * w + w);
    }
  }

  // Adaptive render resolution: drop below 1.0 only when frames get heavy, so
  // typical scenes stay crisp and dense scenes stay at 60fps (upscaled with
  // smoothing). EMA-controlled from measured render time.
  let adaptRS = 1, renderEma = 6;
  const BUDGET_MS = 11; // render budget; rest of 16.6ms is sim + overhead

  // ---- material tables (built once) ----
  let bR = null, bG = null, bB = null, ALPHA = null, REFL = null, NOSHADOW = null;
  function buildTables() {
    const n = PG.elements.length;
    bR = new Uint8Array(n); bG = new Uint8Array(n); bB = new Uint8Array(n);
    ALPHA = new Uint8Array(n); REFL = new Uint8Array(n); NOSHADOW = new Uint8Array(n);
    for (let id = 0; id < n; id++) {
      const el = PG.elements[id];
      if (!el) continue;
      const c = parseInt(el.color.slice(1), 16);
      bR[id] = (c >> 16) & 255; bG[id] = (c >> 8) & 255; bB[id] = c & 255;
    }
    // water/saltwater render as a plain solid (like oil) — no translucency/glint
    ALPHA[E.ACID] = 175;
    ALPHA[E.GLASS] = 95; ALPHA[E.ICE] = 185; ALPHA[E.STEAM] = 130;
    ALPHA[E.GAS] = 140; ALPHA[E.BUBBLE] = 110; ALPHA[E.SOAPY] = 180;
    [E.ICE, E.GLASS, E.MERCURY, E.SOAPY]
      .forEach(id => { REFL[id] = 1; });
    [E.FIRE, E.SPARK, E.THUNDER, E.FIREWORK, E.LASER, E.STEAM, E.GAS, E.BUBBLE]
      .forEach(id => { NOSHADOW[id] = 1; }); // these don't block the sun
  }

  // per-column min occupied y (sun heightmap), double-buffered (1-frame lag)
  let heightPrev = null, heightCur = null, floorShadow = null;
  function ensureHeights(n) {
    if (heightPrev && heightPrev.length === n) return;
    heightPrev = new Int16Array(n); heightPrev.fill(32000);
    heightCur = new Int16Array(n);
    floorShadow = new Uint8Array(n);
  }

  const ease = t => t * t * (3 - 2 * t);
  const REFL_BAND = 36; // reflections fade out this many cells above the floor

  PG.render3 = function (ctx, viewW, viewH) {
    if (!bR) buildTables();
    const t0 = performance.now();

    const v3 = PG.v3, tt = ease(v3.t);
    // hold full resolution during the enter/exit morph (needs to match 2D),
    // adapt only once fully in 3D
    const RS = (tt < 1) ? 1 : adaptRS;
    const rw = Math.max(2, Math.round(viewW * RS)), rh = Math.max(2, Math.round(viewH * RS));
    ensureBuf(rw, rh);
    const dispX = viewW / rw, dispY = viewH / rh; // buffer px -> display px

    const W = PG.W, H = PG.H, D = PG.D, WH = W * H;
    const yaw = v3.yaw * tt, pitch = v3.pitch * tt;
    const sinT = Math.sin(yaw), cosT = Math.cos(yaw);
    const sinP = Math.sin(pitch), cosP = Math.cos(pitch);

    // PERSPECTIVE camera orbiting the box centre. Eases from near-orthographic
    // (tt=0, to match the flat 2D view) to full perspective (tt=1).
    const PS = PG.scale * RS; // 2D pixel scale, in buffer px
    const extX = Math.abs(cosT) * W / 2 + Math.abs(sinT) * D / 2;
    const extY = cosP * H / 2 + sinP * (Math.abs(sinT) * W / 2 + Math.abs(cosT) * D / 2);
    const fit = Math.min(rw * 0.64 / (2 * extX), rh * 0.64 / (2 * extY)); // room for near-enlargement
    const s = PS + (fit * v3.zoom - PS) * tt;
    const cx2d = (PG.viewOffX + W * PG.scale / 2) * RS;
    const cy2d = (PG.viewOffY + H * PG.scale / 2) * RS;
    const ox = cx2d + (rw / 2 - cx2d) * tt;
    const oy = cy2d + (rh / 2 - cy2d) * tt;

    const sinTP = sinT * sinP, cosTP = cosT * sinP;
    const dX = -sinT * cosP, dY = sinP, dZ = cosT * cosP; // view-forward (depth) axis
    // camera distance from box centre — smaller = stronger perspective; eased in
    const boxRad = 0.5 * Math.sqrt(W * W + H * H + D * D);
    const Rp = boxRad * 3 + (1 - tt) * boxRad * 40;
    const focal = s * Rp; // so a voxel at the centre (ez = Rp) projects at scale s

    // perspective projection of a box-relative point -> [bufX, bufY, scale]
    function projP(xr, yr, zr) {
      const ez = Rp + xr * dX + yr * dY + zr * dZ;
      const inv = focal / ez;
      return [ox + (xr * cosT + zr * sinT) * inv, oy + (xr * sinTP + yr * cosP - zr * cosTP) * inv, inv];
    }
    // _proj (display space) for pointer unprojection + the wireframe overlay
    v3._proj = { focal: focal * dispX, ox: ox * dispX, oy: oy * dispY, Rp,
                 sinT, cosT, sinP, cosP, dispX, dispY };

    let minD = Infinity, maxD = -Infinity;
    for (let c = 0; c < 8; c++) {
      const cx = (c & 1 ? W : 0) - W / 2, cy = (c & 2 ? H : 0) - H / 2,
            cz = (c & 4 ? D : 0) - D / 2;
      const d = cx * dX + cy * dY + cz * dZ;
      if (d < minD) minD = d; if (d > maxD) maxD = d;
    }
    const dRange = Math.max(1e-6, maxD - minD);

    const t3 = PG.t3, l3 = PG.l3, sc = PG.sliceCount, rc = PG.rowCount;
    const fireC = PG.fireColors, fwC = PG.fireworkColors;
    const frame = PG.frame;

    // ---- background mode (subset of the 14 BGs that map to a 3D volume) ----
    const bgMode = PG.bgMode, B = PG.BG;
    const trail3 = (bgMode === B.BLUR || bgMode === B.TRACK);
    const vxform = (bgMode === B.TG || bgMode === B.GRAY || bgMode === B.LIGHT);
    const tlut = PG.bgTempLUT, bgTemp = PG.bgTemp, emit = PG.bgEmitter, creat = PG.bgCreature;
    const gray3 = PG.abgrGray, scale3 = PG.abgrScale;
    const isDark = bgMode === B.DARK, isTG = bgMode === B.TG;
    const skipFloor = isDark || isTG;

    // per-voxel splat size q (perspective: near = bigger). clamp box ONCE.
    function plotAt(sx, sy, color, q) {
      const q2 = q * 0.5;
      let x0 = (sx - q2) | 0, y0 = (sy - q2) | 0, x1 = x0 + q, y1 = y0 + q;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
      if (x1 > imgW) x1 = imgW; if (y1 > imgH) y1 = imgH;
      for (let yy = y0; yy < y1; yy++) {
        let o = yy * imgW + x0;
        for (let xx = x0; xx < x1; xx++) buf[o++] = color;
      }
    }
    function plotBlend(sx, sy, color, a, q) { // a = source weight 0..255
      const cr = color & 255, cg = (color >> 8) & 255, cb = (color >> 16) & 255;
      const q2 = q * 0.5;
      let x0 = (sx - q2) | 0, y0 = (sy - q2) | 0, x1 = x0 + q, y1 = y0 + q;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
      if (x1 > imgW) x1 = imgW; if (y1 > imgH) y1 = imgH;
      for (let yy = y0; yy < y1; yy++) {
        let o = yy * imgW + x0;
        for (let xx = x0; xx < x1; xx++, o++) {
          const d = buf[o];
          const r = (d & 255) + (((cr - (d & 255)) * a) >> 8);
          const g = ((d >> 8) & 255) + (((cg - ((d >> 8) & 255)) * a) >> 8);
          const bl = ((d >> 16) & 255) + (((cb - ((d >> 16) & 255)) * a) >> 8);
          buf[o] = 0xff000000 | (bl << 16) | (g << 8) | r;
        }
      }
    }

    // ---- background ----
    if (trail3) {                                   // blur / track: fade last frame
      const f = bgMode === B.BLUR ? 0.80 : 0.93;
      for (let k = 0; k < buf.length; k++) buf[k] = scale3(buf[k], f);
    } else if (isDark) {
      buf.fill(0xff000000);
    } else if (isTG) {
      buf.fill(tlut[PG.bgAmbientTemp]);
    } else {
      buf.set(bgBuf);                               // cached sky gradient
    }

    ensureHeights(W * D);
    const floorVis = (sinP > 0.05) && !skipFloor;

    // ---- glossy floor: checker tiles, fog, directional cast shadows ----
    if (floorVis) {
      floorShadow.fill(0);
      for (let z = 0; z < D; z++) {
        const srow = z * W;
        for (let x = 0; x < W; x++) {
          const ty = heightPrev[srow + x];
          if (ty >= H) continue;
          const h = H - ty;
          const sxc = x + ((h * 82) >> 8), szc = z + ((h * 40) >> 8);
          if (sxc < W && szc < D) floorShadow[szc * W + sxc] = 1;
        }
      }
      const fyr = H / 2;
      for (let z = 0; z < D; z++) {
        const zr = z - D / 2, srow = z * W;
        for (let x = 0; x < W; x++) {
          const xr = x - W / 2;
          const ez = Rp + xr * dX + fyr * dY + zr * dZ, inv = focal / ez;
          let k = 1 - ((ez - Rp) - minD) / dRange; // 1 = near
          let f = (150 + 130 * k) | 0;
          if (floorShadow[srow + x]) f = (f * 110) >> 8;
          const checker = ((x >> 3) + (z >> 3)) & 1 ? 38 : 30;
          let r = (checker * f) >> 8, g = ((checker + 2) * f) >> 8,
              bl = ((checker + 9) * f) >> 8;
          plotAt(ox + (xr * cosT + zr * sinT) * inv, oy + (xr * sinTP + fyr * cosP - zr * cosTP) * inv,
                 0xff000000 | (bl << 16) | (g << 8) | r, inv < 1 ? 1 : (inv + 0.5) | 0);
        }
      }
    }

    heightCur.fill(32000);

    // back-to-front sweep
    const zs = dZ > 0 ? D - 1 : 0, ze = dZ > 0 ? -1 : D, zd = dZ > 0 ? -1 : 1;
    const ys = dY > 0 ? H - 1 : 0, ye = dY > 0 ? -1 : H, yd = dY > 0 ? -1 : 1;
    const xs = dX > 0 ? W - 1 : 0, xe = dX > 0 ? -1 : W, xd = dX > 0 ? -1 : 1;

    const playerZ = PG.player ? Math.round(PG.player.z) : -1;

    for (let z = zs; z !== ze; z += zd) {
      const hasPlayer = z === playerZ;
      if (sc[z] === 0 && !hasPlayer) continue;
      const zr = z - D / 2;
      const exZ = zr * sinT, eyZ = -zr * cosTP, ezZ = zr * dZ; // perspective slice bases
      const scol = z * W, zrow = z * H;
      for (let y = ys; y !== ye; y += yd) {
        if (rc[zrow + y] === 0) continue; // skip empty rows (most of the box)
        // Buried-row skip: if this row AND its 4 neighbour rows are completely
        // full, every interior cell is occluded — only the x=0 / x=W-1 walls are
        // visible. Lets a full container render its shell, not its 2M interior.
        const rowI = (z * H + y) * W, rcRow = rc[zrow + y];
        const interiorFull = rcRow === W && y > 0 && y < H - 1 && z > 0 && z < D - 1 &&
          rc[zrow + y - 1] === W && rc[zrow + y + 1] === W &&
          rc[(z - 1) * H + y] === W && rc[(z + 1) * H + y] === W;
        // rows whose ONLY occupied cells are the x-end walls (air gaps inside a
        // walled box) also reduce to endpoints — without this, a tall container
        // scans W cells per empty air row just to draw two wall pixels.
        const wallsOnly = rcRow === (t3[rowI] !== 0 ? 1 : 0) + (t3[rowI + W - 1] !== 0 ? 1 : 0);
        const endpointsOnly = interiorFull || wallsOnly;
        const yr = y - H / 2;
        const eyRow = eyZ + yr * cosP, ezRow = Rp + ezZ + yr * dY;
        // buried/endpoint rows visit only the two walls (far then near);
        // surface rows visit every cell in painter's-order direction
        const xcount = endpointsOnly ? 2 : W;
        for (let n = 0; n < xcount; n++) {
          const x = endpointsOnly ? (n === 0 ? xs : W - 1 - xs) : xs + n * xd;
          const i = rowI + x;
          const t = t3[i];
          if (t === 0) continue;
          if (isDark && !emit[t]) continue; // dark: only light-emitters show
          if (!NOSHADOW[t] && y < heightCur[scol + x]) heightCur[scol + x] = y;
          // OCCLUSION CULL: a voxel buried on all 6 faces is never visible
          // (translucent materials saturate within a few cells, so this is
          // visually free). Cuts dense volumes down to their surface shell.
          if (x > 0 && x < W - 1 && y > 0 && y < H - 1 && z > 0 && z < D - 1 &&
              t3[i - 1] && t3[i + 1] && t3[i - W] && t3[i + W] &&
              t3[i - WH] && t3[i + WH]) continue;
          const xr = x - W / 2;
          const ez = ezRow + xr * dX, inv = focal / ez;
          const sx = ox + (exZ + xr * cosT) * inv, sy = oy + (eyRow + xr * sinTP) * inv;
          const dd = ez - Rp;
          const qv = inv < 1 ? 1 : (inv + 0.5) | 0;
          const l = l3[i];
          let color;
          if (t === E.FIRE) {
            color = fireC[l > 70 ? 1 + ((x + y + frame) & 1) : 4 - Math.min(4, (l / 14) | 0)];
          } else if (t === E.FIREWORK) {
            color = l < 0 ? fwC[((-l) & 15) % 6] : 0xffffffff;
          } else if (t === E.SPARK || t === E.THUNDER || t === E.LASER) {
            color = ((x + y + z + frame) & 1) ? 0xffffffff : fireC[0];
          } else {
            // sun lighting from exposed faces (light: upper-front-left)
            const upE = y === 0 || t3[i - W] === 0;
            const leftE = x === 0 || t3[i - 1] === 0;
            const rightE = x === W - 1 || t3[i + 1] === 0;
            const frontE = z === 0 || t3[i - WH] === 0;
            let f = 150 + (((x * 7 + y * 13 + z * 5) & 7) << 1) - 7; // grain
            if (upE) f += 112; else f -= 10;
            if (leftE) f += 40; else f -= 10;
            if (frontE) f += 24;
            if (rightE) f -= 8;
            if (y > heightPrev[scol + x]) f = (f * 148) >> 8; // in cast shadow
            const nearK = 1 - (dd - minD) / dRange;
            f = (f * (190 + 66 * nearK)) >> 8; // distance fade
            if (t === E.MAGMA) f = Math.max(f, 285 + ((x + z + frame) & 7) * 5);
            if (f < 56) f = 56;
            let r = (bR[t] * f) >> 8, g = (bG[t] * f) >> 8, bl = (bB[t] * f) >> 8;
            if (r > 255) r = 255; if (g > 255) g = 255; if (bl > 255) bl = 255;
            if (upE && REFL[t]) { // sky glint on reflective surfaces
              r += ((255 - r) * 64) >> 8;
              g += ((255 - g) * 72) >> 8;
              bl += ((255 - bl) * 96) >> 8;
            }
            color = 0xff000000 | (bl << 16) | (g << 8) | r;
          }
          // per-voxel BG transforms (thermal / grayscale / clump-brightness)
          if (vxform) {
            if (isTG) color = tlut[bgTemp[t]];
            else if (bgMode === B.GRAY) { if (!creat[t]) color = gray3(color); }
            else { // LIGHT: brighter where same-type voxels clump
              let n = 0;
              if (t3[i - 1] === t) n++; if (t3[i + 1] === t) n++;
              if (t3[i - W] === t) n++; if (t3[i + W] === t) n++;
              if (t3[i - WH] === t) n++; if (t3[i + WH] === t) n++;
              color = scale3(color, 0.5 + n * 0.1);
            }
          }
          const al = ALPHA[t];
          if (al) plotBlend(sx, sy, color, al, qv);
          else plotAt(sx, sy, color, qv);
        }
      }
      if (hasPlayer) {
        PG.player.draw3((px, py, c) => {
          const pp = projP(px - W / 2, py - H / 2, zr);
          plotAt(pp[0], pp[1], c, pp[2] < 1 ? 1 : (pp[2] + 0.5) | 0);
        });
      }
    }

    [heightPrev, heightCur] = [heightCur, heightPrev];

    // blit the (possibly reduced-res) buffer up to the display, smoothing only
    // when upscaling so full-res frames stay pixel-crisp
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = RS < 1;
    ctx.clearRect(0, 0, viewW, viewH);
    ctx.drawImage(offCanvas, 0, 0, rw, rh, 0, 0, viewW, viewH);

    // ---- wireframe box + draw-plane indicator (vector overlay, display px) ----
    function proj(gx, gy, gz) {
      const p = projP(gx - W / 2, gy - H / 2, gz - D / 2);
      return [p[0] * dispX, p[1] * dispY];
    }
    const C = [];
    let bxMin = Infinity, byMin = Infinity, bxMax = -Infinity, byMax = -Infinity;
    for (let c = 0; c < 8; c++) {
      const p = proj(c & 1 ? W : 0, c & 2 ? H : 0, c & 4 ? D : 0);
      C.push(p);
      if (p[0] < bxMin) bxMin = p[0]; if (p[0] > bxMax) bxMax = p[0];
      if (p[1] < byMin) byMin = p[1]; if (p[1] > byMax) byMax = p[1];
    }
    v3._bbox = [bxMin, byMin, bxMax, byMax]; // screen bounds of the box (for orbit-vs-draw)
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7],
                   [0, 4], [1, 5], [2, 6], [3, 7]];
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, bb] of edges) {
      ctx.moveTo(C[a][0], C[a][1]); ctx.lineTo(C[bb][0], C[bb][1]);
    }
    ctx.stroke();

    if (tt > 0.5) {
      ctx.strokeStyle = "rgba(255,179,64,0.55)";
      ctx.beginPath();
      let R;
      if (v3.drawMode === "slice") {
        const fz = v3.focusZ + 0.5;
        R = [proj(0, 0, fz), proj(W, 0, fz), proj(W, H, fz), proj(0, H, fz)];
      } else {
        const fy = v3.drawMode === "top" ? 0.5 : H - 0.5;
        R = [proj(0, fy, 0), proj(W, fy, 0), proj(W, fy, D), proj(0, fy, D)];
      }
      ctx.moveTo(R[0][0], R[0][1]);
      for (let k = 1; k <= 4; k++) ctx.lineTo(R[k & 3][0], R[k & 3][1]);
      ctx.stroke();
    }

    // ---- adaptive resolution controller (safety net) ----
    // Over budget -> drop resolution; under budget -> recover toward full res.
    // No dead-zone, so crisp 1.0 is restored whenever frames are cheap.
    // Gentle resolution scaling only (no flat-shading tier): a mild, slow blur
    // on very heavy scenes, recovering to crisp 1.0 — keeps the look consistent.
    const dt = performance.now() - t0;
    renderEma = renderEma * 0.9 + dt * 0.1;
    if (tt >= 1) {
      if (renderEma > BUDGET_MS && adaptRS > 0.6) adaptRS = Math.max(0.6, adaptRS - 0.03);
      else if (renderEma < BUDGET_MS - 2 && adaptRS < 1) adaptRS = Math.min(1, adaptRS + 0.03);
    }
    PG._renderMs = dt; PG._rs = adaptRS;
  };

  // ---- unprojection: cast the camera ray through (mx,my), intersect a plane ----
  // (perspective inverse; ex/ez = A, ey/ez = B, point = ex*right+ey*up+(ez-Rp)*fwd)
  PG.unprojSlice = function (mx, my, z) {
    const p = PG.v3._proj;
    if (!p) return null;
    const A = (mx - p.ox) / p.focal, B = (my - p.oy) / p.focal;
    const sinTP = p.sinT * p.sinP, cosTP = p.cosT * p.sinP;
    const dX = -p.sinT * p.cosP, dY = p.sinP, dZ = p.cosT * p.cosP;
    const zr = z - PG.D / 2;
    let den = A * p.sinT - B * cosTP + dZ;
    if (Math.abs(den) < 1e-4) den = den < 0 ? -1e-4 : 1e-4;
    const ez = (zr + p.Rp * dZ) / den, dd = ez - p.Rp;
    const xr = A * ez * p.cosT + B * ez * sinTP + dd * dX;
    const yr = B * ez * p.cosP + dd * dY;
    return [xr + PG.W / 2, yr + PG.H / 2];
  };

  PG.unprojPlaneY = function (mx, my, yPlane) {
    const p = PG.v3._proj;
    if (!p) return null;
    const A = (mx - p.ox) / p.focal, B = (my - p.oy) / p.focal;
    const sinTP = p.sinT * p.sinP, cosTP = p.cosT * p.sinP;
    const dX = -p.sinT * p.cosP, dY = p.sinP, dZ = p.cosT * p.cosP;
    const yr = yPlane - PG.H / 2;
    let den = B * p.cosP + dY;
    if (Math.abs(den) < 0.08) return null; // ray nearly parallel to the plane
    const ez = (yr + p.Rp * dY) / den, dd = ez - p.Rp;
    const xr = A * ez * p.cosT + B * ez * sinTP + dd * dX;
    const zr = A * ez * p.sinT - B * ez * cosTP + dd * dZ;
    return [xr + PG.W / 2, zr + PG.D / 2];
  };

  // advance enter/exit animation
  PG.tick3D = function () {
    const v3 = PG.v3;
    if (v3.entering) {
      v3.t = Math.min(1, v3.t + 0.045);
      if (v3.t >= 1) v3.entering = false;
    } else if (v3.exiting) {
      v3.t = Math.max(0, v3.t - 0.045);
      if (v3.t <= 0) {
        v3.exiting = false;
        PG.exit3D(Math.max(0, Math.min(PG.D - 1, v3.focusZ)));
        if (PG.on3DExited) PG.on3DExited();
      }
    }
  };
})();
