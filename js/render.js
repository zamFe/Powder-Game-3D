// Rendering: sim grid -> ImageData -> scaled blit. Supports 14 Powder-Game BGs.
(function () {
  const E = PG.E;
  let off = null, offCtx = null, img = null, buf32 = null, prevType = null;

  PG.viewOffX = 0; PG.viewOffY = 0; // screen offset of the field (sliders)

  PG.initRender = function () {
    off = document.createElement("canvas");
    off.width = PG.W; off.height = PG.H;
    offCtx = off.getContext("2d");
    img = offCtx.createImageData(PG.W, PG.H);
    buf32 = new Uint32Array(img.data.buffer);
    prevType = new Uint8Array(PG.W * PG.H);
  };

  function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v | 0); }

  PG.render = function (ctx, viewW, viewH) {
    const W = PG.W, H = PG.H, type = PG.type, life = PG.life;
    const air = PG.air, AW = air.AW, AC = air.CELL;
    const p = air.p, avx = air.vx, avy = air.vy;
    const variants = PG.colorVariants, fireC = PG.fireColors, fwC = PG.fireworkColors;
    const bg = PG.bgMode, frame = PG.frame, B = PG.BG;
    const temp = PG.bgTemp, tlut = PG.bgTempLUT, emit = PG.bgEmitter, creat = PG.bgCreature;
    const ambT = PG.bgAmbientTemp;
    const gray = PG.abgrGray, scale = PG.abgrScale;

    function elemColor(t, x, y, l) {
      if (t === E.FIRE) { const idx = l > 70 ? 1 + ((x + y + frame) & 1) : 4 - Math.min(4, (l / 14) | 0); return fireC[idx]; }
      if (t === E.FIREWORK) { return l < 0 ? fwC[((-l) & 15) % 6] : 0xffffffff; }
      if (t === E.SPARK || t === E.THUNDER) { return ((x + y + frame) & 1) ? 0xffffffff : fireC[0]; }
      return variants[t][(x * 7 + y * 13) & 3];
    }

    let i = 0;
    for (let y = 0; y < H; y++) {
      const arow = ((y / AC) | 0) * AW;
      for (let x = 0; x < W; x++, i++) {
        const t = type[i];
        const ai = arow + ((x / AC) | 0);

        // ---- trail BGs keep the previous frame and fade it ----
        if (bg === B.BLUR) {
          buf32[i] = t !== 0 ? elemColor(t, x, y, life[i]) : scale(buf32[i], 0.80);
          continue;
        }
        if (bg === B.TRACK) {
          if (t !== 0) buf32[i] = elemColor(t, x, y, life[i]);
          else { const pv = p[ai]; buf32[i] = (pv > 1.2 || pv < -1.2) ? 0xff000000 : scale(buf32[i], 0.95); }
          continue;
        }
        if (bg === B.SILUET) {
          const pt = prevType[i];
          if (t !== 0) buf32[i] = (t !== pt) ? 0xffc0b8d0 : 0xff121216;       // moving tint / static black
          else buf32[i] = (pt !== 0) ? 0xff6c6c74 : 0xffd8dce4;              // just-vacated blur / light bg
          continue;
        }

        // ---- empty cells: background fill ----
        if (t === 0) {
          switch (bg) {
            case B.AIR: { const pv = p[ai]; buf32[i] = 0xff000000 | (clamp255(-pv * 14) << 16) | (clamp255(pv * 14) << 8); break; }
            case B.GRAY: { const g = clamp255(18 + Math.abs(p[ai]) * 16); buf32[i] = 0xff000000 | (g << 16) | (g << 8) | g; break; }
            case B.AURA: {
              const vx = avx[ai], vy = avy[ai], mag = Math.abs(vx) + Math.abs(vy);
              if (mag < 0.5) { buf32[i] = 0xff000000; break; }
              let hue = Math.atan2(vy, vx) / (Math.PI * 2); if (hue < 0) hue += 1;
              buf32[i] = PG.hsvAbgr(hue, Math.min(1, mag * 0.2)); break;
            }
            case B.MESH: {
              const mx = x + avx[ai] * 1.5, my = y + avy[ai] * 1.5;
              if ((((mx % 8) + 8) % 8) < 1 || (((my % 8) + 8) % 8) < 1) {
                const pv = p[ai];
                buf32[i] = 0xff000000 | (clamp255(45 - pv * 12) << 16) | (clamp255(60 + pv * 12) << 8) | 45;
              } else buf32[i] = 0xff000000;
              break;
            }
            case B.TG: buf32[i] = tlut[ambT]; break;
            case B.SHADE: case B.TOON: {
              const nb = (x > 0 && type[i - 1]) || (x < W - 1 && type[i + 1]) ||
                         (y > 0 && type[i - W]) || (y < H - 1 && type[i + W]);
              if (!nb) { buf32[i] = 0xff000000; break; }
              if (bg === B.TOON) buf32[i] = 0xffffffff;
              else buf32[i] = scale(elemColor(nb, x, y, 0), 0.32);
              break;
            }
            default: buf32[i] = 0xff000000; // non, line, light, dark
          }
          continue;
        }

        // ---- occupied cells: element colour, possibly transformed ----
        switch (bg) {
          case B.DARK: buf32[i] = emit[t] ? elemColor(t, x, y, life[i]) : 0xff000000; break;
          case B.TG: buf32[i] = tlut[temp[t]]; break;
          case B.GRAY: buf32[i] = creat[t] ? elemColor(t, x, y, life[i]) : gray(elemColor(t, x, y, life[i])); break;
          case B.LIGHT: {
            let n = 0;
            if (x > 0 && type[i - 1] === t) n++; if (x < W - 1 && type[i + 1] === t) n++;
            if (y > 0 && type[i - W] === t) n++; if (y < H - 1 && type[i + W] === t) n++;
            if (x > 0 && y > 0 && type[i - W - 1] === t) n++; if (x < W - 1 && y > 0 && type[i - W + 1] === t) n++;
            if (x > 0 && y < H - 1 && type[i + W - 1] === t) n++; if (x < W - 1 && y < H - 1 && type[i + W + 1] === t) n++;
            buf32[i] = scale(elemColor(t, x, y, life[i]), 0.42 + n * 0.09); break;
          }
          default: buf32[i] = elemColor(t, x, y, life[i]);
        }
      }
    }

    // LINE overlay: brown streaks pointing along the wind
    if (bg === B.LINE) {
      const brown = 0xff326eaa;
      for (let cy = 0; cy < H; cy += AC) for (let cx = 0; cx < W; cx += AC) {
        const a2 = ((cy / AC) | 0) * AW + ((cx / AC) | 0);
        const vx = avx[a2], vy = avy[a2], mag = Math.sqrt(vx * vx + vy * vy);
        if (mag < 0.5) continue;
        const len = Math.min(AC * 1.8, mag * 1.3), ux = vx / mag, uy = vy / mag;
        const sx = cx + AC / 2, sy = cy + AC / 2;
        for (let s = 0; s < len; s++) {
          const px = (sx + ux * s) | 0, py = (sy + uy * s) | 0;
          if (px >= 0 && py >= 0 && px < W && py < H && type[py * W + px] === 0) buf32[py * W + px] = brown;
        }
      }
    }

    if (bg === B.SILUET) prevType.set(type);
    if (PG.player) PG.player.draw(buf32, W);

    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, viewW, viewH);
    ctx.drawImage(off, 0, 0, W, H, PG.viewOffX, PG.viewOffY, W * PG.scale, H * PG.scale);
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.strokeRect(PG.viewOffX - 0.5, PG.viewOffY - 0.5, W * PG.scale + 1, H * PG.scale + 1);
  };
})();
