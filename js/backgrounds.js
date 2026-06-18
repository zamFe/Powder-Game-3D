// Shared data + helpers for the 14 Powder-Game backgrounds (BGs).
// Used by both render.js (2D) and render3d.js (3D).
(function () {
  const E = PG.E, els = PG.elements;

  PG.BG_NAMES = ["non", "air", "line", "blur", "shade", "aura", "light",
                 "toon", "mesh", "gray", "track", "dark", "TG", "siluet"];
  PG.BG = {};
  PG.BG_NAMES.forEach((n, i) => { PG.BG[n.toUpperCase()] = i; });
  PG.bgMode = 0; // index into BG_NAMES (0 = non)

  // ---- pseudo-temperature per element (0 cold .. 255 hot) for the TG thermal BG ----
  const T = new Uint8Array(els.length); T.fill(100);
  const setT = (id, v) => { if (id != null) T[id] = v; };
  setT(E.FIRE, 255); setT(E.MAGMA, 248); setT(E.THUNDER, 252); setT(E.SPARK, 238);
  setT(E.LASER, 250); setT(E.FIREWORK, 236); setT(E.TORCH, 232); setT(E.STEAM, 205);
  setT(E.GAS, 150); setT(E.VIRUS, 145);
  setT(E.WATER, 72); setT(E.SALTWATER, 72); setT(E.OIL, 96); setT(E.ACID, 90);
  setT(E.MERCURY, 100); setT(E.SOAPY, 80); setT(E.BUBBLE, 78); setT(E.CLOUD, 60);
  setT(E.ICE, 18); setT(E.SNOW, 24);
  setT(E.METAL, 120); setT(E.GLASS, 105); setT(E.STONE, 92); setT(E.BLOCK, 90);
  setT(E.ANT, 125); setT(E.BIRD, 125); setT(E.FISH, 88);
  PG.bgTemp = T;
  PG.bgAmbientTemp = 38; // empty space in TG

  // 256-entry temperature gradient: purple(low) -> blue -> green -> yellow -> red -> white(high)
  const stops = [[0, 90, 0, 130], [0.2, 0, 40, 255], [0.42, 0, 200, 80],
                 [0.62, 240, 230, 0], [0.82, 255, 40, 0], [1, 255, 255, 255]];
  const TLUT = new Uint32Array(256);
  for (let k = 0; k < 256; k++) {
    const f = k / 255; let s = 0;
    while (s < stops.length - 2 && f > stops[s + 1][0]) s++;
    const a = stops[s], b = stops[s + 1], lt = (f - a[0]) / (b[0] - a[0]);
    const r = (a[1] + (b[1] - a[1]) * lt) | 0;
    const g = (a[2] + (b[2] - a[2]) * lt) | 0;
    const bl = (a[3] + (b[3] - a[3]) * lt) | 0;
    TLUT[k] = 0xff000000 | (bl << 16) | (g << 8) | r;
  }
  PG.bgTempLUT = TLUT;

  // light emitters (DARK keeps only these + players visible)
  const EM = new Uint8Array(els.length);
  [E.FIRE, E.MAGMA, E.THUNDER, E.SPARK, E.LASER, E.FIREWORK, E.TORCH]
    .forEach(id => { if (id != null) EM[id] = 1; });
  PG.bgEmitter = EM;

  // creatures keep their colour in GRAY mode
  const CR = new Uint8Array(els.length);
  [E.ANT, E.BIRD, E.FISH].forEach(id => { if (id != null) CR[id] = 1; });
  PG.bgCreature = CR;

  // ---- ABGR colour helpers ----
  PG.abgrGray = function (c) {
    const r = c & 255, g = (c >> 8) & 255, b = (c >> 16) & 255;
    const y = (r * 77 + g * 150 + b * 29) >> 8;
    return 0xff000000 | (y << 16) | (y << 8) | y;
  };
  PG.abgrScale = function (c, f) {
    let r = ((c & 255) * f) | 0, g = (((c >> 8) & 255) * f) | 0, b = (((c >> 16) & 255) * f) | 0;
    if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
    return 0xff000000 | (b << 16) | (g << 8) | r;
  };
  // hue (0..1) + value (0..1) -> ABGR (AURA wind colours)
  PG.hsvAbgr = function (h, v) {
    h *= 6; const i = h | 0, f = h - i;
    const q = v * (1 - f), t = v * f;
    let r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = 0; break;
      case 1: r = q; g = v; b = 0; break;
      case 2: r = 0; g = v; b = t; break;
      case 3: r = 0; g = q; b = v; break;
      case 4: r = t; g = 0; b = v; break;
      default: r = v; g = 0; b = q; break;
    }
    return 0xff000000 | ((b * 255) << 16) | ((g * 255) << 8) | (r * 255 | 0);
  };
})();
