// UI: sidebar, pointer/keyboard input, main loop, save/load.
(function () {
  const E = PG.E, els = PG.elements;
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  PG.scale = 4;
  PG.speed = 1;        // sim steps per frame
  PG.paused = false;
  PG.keys = {};

  let penSize = 4;
  let current = { kind: "element", id: E.POWDER };
  let strokeDir = 2;   // DIR8 index, default = right
  let drawing = 0;     // 1 = left (draw), 2 = right (erase)
  let lastCX = -1, lastCY = -1;
  let lastG3 = null;   // last 3D grid point during a stroke
  let orbiting = false, lastPX = 0, lastPY = 0;

  // ---- sizing ------------------------------------------------------------
  let pctW = 100, pctH = 100; // field size sliders, % of window

  function targetDims() {
    return [
      Math.max(40, Math.floor(canvas.width * (pctW / 100) / PG.scale)),
      Math.max(40, Math.floor(canvas.height * (pctH / 100) / PG.scale)),
    ];
  }
  function updateViewOffsets() {
    PG.viewOffX = Math.max(0, Math.floor((canvas.width - PG.W * PG.scale) / 2));
    PG.viewOffY = Math.max(0, canvas.height - PG.H * PG.scale);
  }

  function rebuild() {
    instantExit3D();
    const vw = window.innerWidth - 216, vh = window.innerHeight;
    canvas.width = vw; canvas.height = vh;
    const [tw, th] = targetDims();
    if (PG.type) PG.resizeGrid(tw, th); // keep the scene across resizes
    else PG.initGrid(tw, th);
    updateViewOffsets();
    PG.initRender();
  }

  function applyDims() { // width/height/depth slider commit
    const [tw, th] = targetDims();
    if (PG.mode3d) {
      PG.resizeGrid3(tw, th, PG.boxDepthFor(tw));
      syncDepthUI();
      setFocusZ(PG.v3.focusZ);
    } else {
      PG.resizeGrid(tw, th);
    }
    updateViewOffsets();
    PG.initRender();
  }
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuild, 200);
  });

  // ---- painting ----------------------------------------------------------
  function stamp(cx, cy, id, erase) {
    const r = Math.max(1, penSize / 2);
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (!PG.inBounds(x, y)) continue;
        if (erase) { PG.set(x, y, 0, 0); continue; }
        if (!PG.isEmpty(x, y)) continue;
        let l = PG.initLife(id);
        if (id === E.FAN || id === E.LASER) l = strokeDir;
        PG.set(x, y, id, l);
      }
    }
  }

  function applyTool(cx, cy, dx, dy, isErase) {
    if (isErase) { stamp(cx, cy, 0, true); return; }
    if (current.kind === "tool") {
      switch (current.id) {
        case "wind": {
          const s = 0.7;
          PG.air.addVel(cx, cy, dx * s, dy * s);
          PG.air.addVel(cx + 4, cy, dx * s, dy * s);
          PG.air.addVel(cx - 4, cy, dx * s, dy * s);
          PG.air.addVel(cx, cy + 4, dx * s, dy * s);
          PG.air.addVel(cx, cy - 4, dx * s, dy * s);
          return;
        }
        case "cyclone": PG.air.swirl(cx, cy, 18, 1.4, 0.5); return;
        case "erase": stamp(cx, cy, 0, true); return;
        case "block": stamp(cx, cy, E.BLOCK, false); return;
        case "player":
          if (!PG.player) PG.player = new PG.Player(cx, cy);
          else { PG.player.x = cx; PG.player.y = cy; PG.player.vx = PG.player.vy = 0; }
          return;
      }
    } else {
      stamp(cx, cy, current.id, false);
    }
  }

  function cellPos(ev) {
    const r = canvas.getBoundingClientRect();
    return [
      Math.floor((ev.clientX - r.left - PG.viewOffX) / PG.scale),
      Math.floor((ev.clientY - r.top - PG.viewOffY) / PG.scale),
    ];
  }
  function screenPos(ev) {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  // ---- 3D painting --------------------------------------------------------
  // Maps a screen point onto the active draw plane -> [gx, gy, gz]
  function gridPoint3(mx, my) {
    const v3 = PG.v3;
    if (v3.drawMode === "slice") {
      const r = PG.unprojSlice(mx, my, v3.focusZ);
      return r && [r[0], r[1], v3.focusZ];
    }
    const yPlane = v3.drawMode === "top" ? 1 : PG.H - 2;
    const r = PG.unprojPlaneY(mx, my, yPlane);
    if (!r) { // plane edge-on, fall back to the focus slice
      const s = PG.unprojSlice(mx, my, v3.focusZ);
      return s && [s[0], s[1], v3.focusZ];
    }
    // the cursor ray may hit the plane outside the box: clamp into it
    return [Math.max(0, Math.min(PG.W - 1, r[0])), yPlane,
            Math.max(0, Math.min(PG.D - 1, r[1]))];
  }

  function surfaceY3(x, z) { // first empty cell above the pile, from the floor
    let y = PG.H - 1;
    while (y > 0 && !PG.isEmpty3(x, y, z)) y--;
    return y;
  }

  function stamp3(gx, gy, gz, id, erase) {
    const mode = PG.v3.drawMode;
    const r = Math.max(1, penSize / 2), r2 = r * r;
    for (let da = -r; da <= r; da++) {
      for (let db = -r; db <= r; db++) {
        if (da * da + db * db > r2) continue;
        if (mode === "slice") {
          const x = Math.round(gx + da), y = Math.round(gy + db), z = Math.round(gz);
          if (!PG.inBounds3(x, y, z)) continue;
          if (erase) { PG.set3(x, y, z, 0, 0); continue; }
          if (!PG.isEmpty3(x, y, z)) continue;
          let l = PG.initLife(id);
          if (id === E.FAN || id === E.LASER) l = strokeDir;
          PG.set3(x, y, z, id, l);
        } else {
          const x = Math.round(gx + da), z = Math.round(gz + db);
          if (x < 0 || z < 0 || x >= PG.W || z >= PG.D) continue;
          if (erase) { // mine the column surface from above
            for (let y = 0; y < PG.H; y++) {
              if (PG.t3[PG.idx3(x, y, z)] !== 0) { PG.set3(x, y, z, 0, 0); break; }
            }
            continue;
          }
          const y = mode === "top" ? 1 + PG.rand(2) : surfaceY3(x, z);
          if (!PG.isEmpty3(x, y, z)) continue;
          let l = PG.initLife(id);
          if (id === E.FAN || id === E.LASER) l = strokeDir;
          PG.set3(x, y, z, id, l);
        }
      }
    }
  }

  function applyTool3At(g, gd, isErase) {
    if (isErase) { stamp3(g[0], g[1], g[2], 0, true); return; }
    if (current.kind === "tool") {
      switch (current.id) {
        case "wind":
          PG.air3.addVel(g[0], g[1], g[2], gd[0] * 0.9, gd[1] * 0.9, gd[2] * 0.9);
          return;
        case "cyclone": PG.air3.swirl(g[0], g[1], g[2], 18, 1.4, 0.5); return;
        case "erase": stamp3(g[0], g[1], g[2], 0, true); return;
        case "block": stamp3(g[0], g[1], g[2], E.BLOCK, false); return;
        case "player": {
          const z = Math.max(0, Math.min(PG.D - 1, Math.round(g[2])));
          const y = PG.v3.drawMode === "slice" ? g[1] : surfaceY3(Math.round(g[0]), z);
          if (!PG.player) PG.player = new PG.Player(g[0], y, z);
          else {
            PG.player.x = g[0]; PG.player.y = y; PG.player.z = z;
            PG.player.vx = PG.player.vy = 0;
          }
          return;
        }
      }
    } else {
      stamp3(g[0], g[1], g[2], current.id, false);
    }
  }

  canvas.addEventListener("contextmenu", e => e.preventDefault());
  // is a screen point outside the projected box? (left-drag there orbits)
  function outsideBox(mx, my) {
    const b = PG.v3._bbox;
    if (!b) return false;
    const m = 8;
    return mx < b[0] - m || mx > b[2] + m || my < b[1] - m || my > b[3] + m;
  }
  canvas.addEventListener("pointerdown", ev => {
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic events */ }
    const [mx, my] = screenPos(ev);
    // orbit the camera: middle-drag anywhere, or left-drag started outside the box
    if (PG.mode3d && (ev.button === 1 || (ev.button === 0 && outsideBox(mx, my)))) {
      ev.preventDefault();
      orbiting = true;
      lastPX = mx; lastPY = my;
      return;
    }
    if (ev.button !== 0 && ev.button !== 2) return;
    drawing = ev.button === 2 ? 2 : 1;
    if (PG.mode3d) {
      const g = gridPoint3(mx, my);
      lastG3 = g;
      if (g) applyTool3At(g, [0, 0, 0], drawing === 2);
      return;
    }
    const [cx, cy] = cellPos(ev);
    lastCX = cx; lastCY = cy;
    applyTool(cx, cy, 0, 0, drawing === 2);
  });
  canvas.addEventListener("pointermove", ev => {
    if (orbiting) {
      const [mx, my] = screenPos(ev);
      PG.v3.yaw += (mx - lastPX) * 0.008;                                  // full 360, no clamp
      PG.v3.pitch = Math.max(-1.5, Math.min(1.5, PG.v3.pitch + (my - lastPY) * 0.008));
      lastPX = mx; lastPY = my;
      return;
    }
    if (!drawing) return;
    if (PG.mode3d) {
      const [mx, my] = screenPos(ev);
      const g = gridPoint3(mx, my);
      if (!g) return;
      if (!lastG3) lastG3 = g;
      const gd = [g[0] - lastG3[0], g[1] - lastG3[1], g[2] - lastG3[2]];
      if (gd[0] || gd[1]) {
        strokeDir = (2 + Math.round(Math.atan2(
          PG.v3.drawMode === "slice" ? gd[1] : gd[2], gd[0]) / (Math.PI / 4))) & 7;
      }
      const steps = Math.max(1, Math.round(
        Math.max(Math.abs(gd[0]), Math.abs(gd[1]), Math.abs(gd[2]))));
      for (let s = 1; s <= steps; s++) {
        applyTool3At(
          [lastG3[0] + gd[0] * s / steps, lastG3[1] + gd[1] * s / steps,
           lastG3[2] + gd[2] * s / steps],
          [gd[0] / steps, gd[1] / steps, gd[2] / steps], drawing === 2);
      }
      lastG3 = g;
      return;
    }
    const [cx, cy] = cellPos(ev);
    const dx = cx - lastCX, dy = cy - lastCY;
    if (dx || dy) {
      strokeDir = (2 + Math.round(Math.atan2(dy, dx) / (Math.PI / 4))) & 7;
    }
    // interpolate along the stroke so fast moves leave no gaps
    const steps = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)));
    for (let s = 1; s <= steps; s++) {
      applyTool(
        lastCX + (dx * s) / steps, lastCY + (dy * s) / steps,
        dx / steps, dy / steps, drawing === 2);
    }
    lastCX = cx; lastCY = cy;
  });
  const stopDraw = () => { drawing = 0; orbiting = false; lastG3 = null; };
  canvas.addEventListener("pointerup", stopDraw);
  canvas.addEventListener("pointercancel", stopDraw);
  canvas.addEventListener("wheel", ev => {
    if (!PG.mode3d) return;
    ev.preventDefault();
    PG.v3.zoom = Math.max(0.3, Math.min(3.5, PG.v3.zoom * (ev.deltaY < 0 ? 1.1 : 0.9)));
  }, { passive: false });

  // ---- keyboard ----------------------------------------------------------
  window.addEventListener("keydown", ev => {
    PG.keys[ev.key] = true;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(ev.key)) {
      ev.preventDefault();
    }
    if (ev.key === "p") togglePause();
    if (PG.mode3d) {
      if (ev.key === "[") setFocusZ(PG.v3.focusZ - 1);
      if (ev.key === "]") setFocusZ(PG.v3.focusZ + 1);
    }
  });
  window.addEventListener("keyup", ev => { PG.keys[ev.key] = false; });

  // ---- sidebar -----------------------------------------------------------
  function makeBtn(parent, label, swatchColor, onClick) {
    const btn = document.createElement("button");
    if (swatchColor) {
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = swatchColor;
      btn.appendChild(sw);
    }
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
    return btn;
  }
  function selectIn(container, btn) {
    container.querySelectorAll("button").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
  }

  const paletteEl = document.getElementById("palette");
  const toolsEl = document.getElementById("tools");
  function clearSelections() {
    paletteEl.querySelectorAll("button").forEach(b => b.classList.remove("selected"));
    toolsEl.querySelectorAll("button").forEach(b => b.classList.remove("selected"));
  }

  for (const id of PG.paletteOrder) {
    const el = els[id];
    const btn = makeBtn(paletteEl, el.name, el.color, () => {
      current = { kind: "element", id };
      clearSelections(); btn.classList.add("selected");
    });
    if (id === E.POWDER) btn.classList.add("selected");
  }

  const toolDefs = [
    ["wind", "#9ad", "wind"], ["cyclone", "#7cf", "cyclone"], ["block", "#777", "block"],
    ["erase", "#222", "erase"], ["player", "#fff", "player"],
  ];
  for (const [tid, color, label] of toolDefs) {
    const btn = makeBtn(toolsEl, label, color, () => {
      current = { kind: "tool", id: tid };
      clearSelections(); btn.classList.add("selected");
    });
  }

  const penEl = document.getElementById("pen-sizes");
  for (const s of [1, 2, 4, 8, 16]) {
    const btn = makeBtn(penEl, String(s), null, () => {
      penSize = s; selectIn(penEl, btn);
    });
    if (s === penSize) btn.classList.add("selected");
  }

  const scaleEl = document.getElementById("scale-btns");
  for (const s of [2, 3, 4, 6]) {
    const btn = makeBtn(scaleEl, s + "px", null, () => {
      PG.scale = s; selectIn(scaleEl, btn); rebuild();
    });
    if (s === PG.scale) btn.classList.add("selected");
  }

  const speedEl = document.getElementById("speed-btns");
  for (const s of [1, 2, 4]) {
    const btn = makeBtn(speedEl, s + "x", null, () => {
      PG.speed = s; selectIn(speedEl, btn);
    });
    if (s === PG.speed) btn.classList.add("selected");
  }

  const bgSel = document.getElementById("bg-select");
  PG.BG_NAMES.forEach((name, idx) => {
    const opt = document.createElement("option");
    opt.value = idx; opt.textContent = name;
    bgSel.appendChild(opt);
  });
  bgSel.value = PG.bgMode;
  bgSel.addEventListener("change", () => { PG.bgMode = +bgSel.value; });

  const wavesEl = document.getElementById("waves-btns");
  [["off", 0], ["on", 1], ["max", 2]].forEach(([name, str]) => {
    const btn = makeBtn(wavesEl, name, null, () => {
      PG.waveStr = str; selectIn(wavesEl, btn);
    });
    if (str === PG.waveStr) btn.classList.add("selected");
  });

  const liquidEl = document.getElementById("liquid-btns");
  [["classic", 0], ["fluid", 1]].forEach(([name, mode]) => {
    const btn = makeBtn(liquidEl, name, null, () => {
      PG.fluidMode = mode; selectIn(liquidEl, btn); PG.wakeLiquids && PG.wakeLiquids();
    });
    if (mode === PG.fluidMode) btn.classList.add("selected");
  });

  // ---- 3D mode controls ----------------------------------------------------
  const btn3d = document.getElementById("btn-3d");
  const ctl3d = document.getElementById("threed-controls");
  const sliceVal = document.getElementById("slice-val");

  function setFocusZ(z) {
    PG.v3.focusZ = Math.max(0, Math.min((PG.D || 1) - 1, z));
    sliceVal.textContent = PG.v3.focusZ;
  }
  function set3DUI(on) {
    btn3d.textContent = on ? "Exit 3D" : "Enter 3D";
    btn3d.classList.toggle("selected", on);
    ctl3d.classList.toggle("hidden", !on);
  }
  function instantExit3D() {
    if (!PG.mode3d) return;
    PG.v3.entering = PG.v3.exiting = false;
    PG.v3.t = 0;
    PG.exit3D(Math.max(0, Math.min(PG.D - 1, PG.v3.focusZ)));
    set3DUI(false);
  }
  PG.on3DExited = () => set3DUI(false);

  btn3d.addEventListener("click", () => {
    if (!PG.mode3d) {
      PG.enter3D();
      PG.v3.t = 0; PG.v3.entering = true; PG.v3.exiting = false;
      PG.v3.yaw = -0.45; PG.v3.pitch = 0.30; PG.v3.zoom = 1;
      setFocusZ(0);
      syncDepthUI();
      set3DUI(true);
    } else if (!PG.v3.exiting) {
      PG.v3.exiting = true; PG.v3.entering = false;
    }
  });

  const draw3dEl = document.getElementById("draw3d-btns");
  [["slice", "slice"], ["top", "top"], ["floor", "floor"]].forEach(([label, mode]) => {
    const btn = makeBtn(draw3dEl, label, null, () => {
      PG.v3.drawMode = mode; selectIn(draw3dEl, btn);
    });
    if (mode === "slice") btn.classList.add("selected");
  });
  document.getElementById("slice-minus").addEventListener("click",
    () => setFocusZ(PG.v3.focusZ - 1));
  document.getElementById("slice-plus").addEventListener("click",
    () => setFocusZ(PG.v3.focusZ + 1));

  // ---- size sliders ---------------------------------------------------------
  const slW = document.getElementById("sl-w"), slWv = document.getElementById("sl-w-val");
  const slH = document.getElementById("sl-h"), slHv = document.getElementById("sl-h-val");
  const slD = document.getElementById("sl-d"), slDv = document.getElementById("sl-d-val");

  function syncDepthUI() { // show the actual (budget-clamped) depth
    if (PG.mode3d) { slD.value = PG.D; slDv.textContent = PG.D; }
    else slDv.textContent = slD.value;
  }
  slW.addEventListener("input", () => { slWv.textContent = slW.value + "%"; });
  slH.addEventListener("input", () => { slHv.textContent = slH.value + "%"; });
  slD.addEventListener("input", () => { slDv.textContent = slD.value; });
  slW.addEventListener("change", () => { pctW = +slW.value; applyDims(); });
  slH.addEventListener("change", () => { pctH = +slH.value; applyDims(); });
  slD.addEventListener("change", () => {
    PG.depthPref = +slD.value;
    if (PG.mode3d) {
      PG.resizeGrid3(PG.W, PG.H, PG.depthPref);
      syncDepthUI();
      setFocusZ(PG.v3.focusZ);
    }
  });

  const pauseBtn = document.getElementById("btn-pause");
  function togglePause() {
    PG.paused = !PG.paused;
    pauseBtn.innerHTML = PG.paused ? "&#9654; Resume" : "&#10074;&#10074; Pause";
  }
  pauseBtn.addEventListener("click", togglePause);
  document.getElementById("btn-clear").addEventListener("click", () => {
    if (PG.mode3d) PG.clearGrid3(); else PG.clearGrid();
  });

  // ---- save / load (RLE of types + fan directions, 2D only) ----------------
  document.getElementById("btn-save").addEventListener("click", () => {
    if (PG.mode3d) { flashStat("save: 2D only"); return; }
    const rle = [];
    let run = 1;
    for (let i = 1; i <= PG.type.length; i++) {
      if (i < PG.type.length && PG.type[i] === PG.type[i - 1] && run < 65535) run++;
      else { rle.push(run, PG.type[i - 1]); run = 1; }
    }
    const fans = [];
    for (let i = 0; i < PG.type.length; i++) {
      if (PG.type[i] === E.FAN || PG.type[i] === E.LASER) fans.push(i, PG.life[i]);
    }
    try {
      localStorage.setItem("powdergame-save", JSON.stringify(
        { w: PG.W, h: PG.H, scale: PG.scale, rle, fans }));
      flashStat("saved");
    } catch (e) { flashStat("save failed"); }
  });

  document.getElementById("btn-load").addEventListener("click", () => {
    if (PG.mode3d) { flashStat("load: 2D only"); return; }
    const raw = localStorage.getItem("powdergame-save");
    if (!raw) { flashStat("no save"); return; }
    const s = JSON.parse(raw);
    PG.clearGrid();
    // paint saved grid into current grid (centered top-left aligned)
    let i = 0;
    outer:
    for (let k = 0; k < s.rle.length; k += 2) {
      const run = s.rle[k], t = s.rle[k + 1];
      for (let r = 0; r < run; r++, i++) {
        if (i >= s.w * s.h) break outer;
        const x = i % s.w, y = (i / s.w) | 0;
        if (t !== 0 && x < PG.W && y < PG.H) PG.set(x, y, t, PG.initLife(t));
      }
    }
    for (let k = 0; k < s.fans.length; k += 2) {
      const x = s.fans[k] % s.w, y = (s.fans[k] / s.w) | 0;
      if (x < PG.W && y < PG.H) {
        const j = PG.idx(x, y);
        if (PG.type[j] === E.FAN || PG.type[j] === E.LASER) PG.life[j] = s.fans[k + 1];
      }
    }
    flashStat("loaded");
  });

  const fpsEl = document.getElementById("stat-fps");
  const partsEl = document.getElementById("stat-parts");
  function flashStat(msg) {
    partsEl.textContent = msg;
  }

  // ---- main loop -----------------------------------------------------------
  let frames = 0, lastFps = performance.now();
  function loop() {
    if (PG.mode3d) {
      if (PG.keys.q) PG.v3.yaw -= 0.04;
      if (PG.keys.e) PG.v3.yaw += 0.04;
      PG.tick3D(); // may finish the exit transition and leave 3D mode
    }
    if (PG.mode3d) {
      if (!PG.paused) {
        for (let s = 0; s < PG.speed; s++) PG.stepSim3();
      } else if (PG.player) {
        PG.player.update();
      }
      PG.render3(ctx, canvas.width, canvas.height);
    } else {
      if (!PG.paused) {
        for (let s = 0; s < PG.speed; s++) PG.stepSim();
      } else if (PG.player) {
        PG.player.update(); // let the player move while time is frozen
      }
      PG.render(ctx, canvas.width, canvas.height);
    }

    frames++;
    const now = performance.now();
    if (now - lastFps >= 500) {
      fpsEl.textContent = Math.round(frames * 1000 / (now - lastFps));
      partsEl.textContent = PG.partCount;
      frames = 0; lastFps = now;
    }
    requestAnimationFrame(loop);
  }

  rebuild();
  loop();
})();
