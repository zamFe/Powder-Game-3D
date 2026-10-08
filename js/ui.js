// UI: sidebar, pointer/keyboard input, main loop, save/load.
(function () {
  const E = PG.E, els = PG.elements;
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const $ = id => document.getElementById(id);

  PG.scale = 4;
  PG.speed = 1;        // sim steps per frame
  PG.paused = false;
  PG.keys = {};

  let penSize = 4;
  // Pen footprint: the cell offsets a pen of size N paints — a disc exactly N
  // cells across (1 = a single dot, 2 = 2x2). Even sizes put the extra cell on
  // the +x/+y side. Rebuilt only when the size changes.
  let penCells = [], penLo = 0, penHi = 0;
  function buildPen(n) {
    penLo = -((n - 1) >> 1); penHi = n >> 1;
    const c = (penLo + penHi) / 2, r2 = n * n / 4;
    penCells = [];
    for (let dy = penLo; dy <= penHi; dy++) {
      for (let dx = penLo; dx <= penHi; dx++) {
        if ((dx - c) * (dx - c) + (dy - c) * (dy - c) <= r2) penCells.push(dx, dy);
      }
    }
  }
  buildPen(penSize);
  let current = { kind: "element", id: E.POWDER };
  let strokeDir = 2;   // DIR8 index, default = right
  let drawing = 0;     // 1 = left (draw), 2 = right (erase)
  let lastCX = -1, lastCY = -1;
  let lastG3 = null;   // last 3D grid point during a stroke
  let orbiting = false, panning = false, lastPX = 0, lastPY = 0;

  // ---- 3D camera ------------------------------------------------------------
  // The view 3D mode opens with; Reset camera glides back to it.
  const DEFAULT_CAM = { yaw: -0.45, pitch: 0.30, zoom: 1, panX: 0, panY: 0 };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let camTween = null; // { from, to, t } while a reset is gliding
  function resetCamera() {
    const v3 = PG.v3, TAU = Math.PI * 2;
    // turn back the short way: the default yaw nearest the current one
    const to = Object.assign({}, DEFAULT_CAM,
      { yaw: DEFAULT_CAM.yaw + TAU * Math.round((v3.yaw - DEFAULT_CAM.yaw) / TAU) });
    if (reduceMotion) { Object.assign(v3, DEFAULT_CAM); camTween = null; return; }
    camTween = { from: { yaw: v3.yaw, pitch: v3.pitch, zoom: v3.zoom, panX: v3.panX, panY: v3.panY }, to, t: 0 };
  }
  function stepCamTween() {
    if (!camTween) return;
    const v3 = PG.v3, { from, to } = camTween;
    camTween.t = Math.min(1, camTween.t + 1 / 20);
    const k = camTween.t * camTween.t * (3 - 2 * camTween.t);
    for (const key of ["yaw", "pitch", "panX", "panY"]) v3[key] = from[key] + (to[key] - from[key]) * k;
    v3.zoom = from.zoom * Math.pow(to.zoom / from.zoom, k); // zoom eases evenly on a log scale
    if (camTween.t >= 1) { Object.assign(v3, DEFAULT_CAM); camTween = null; }
  }

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

  // Re-fit the backing store to the stage and re-derive the grid size. Keeps
  // whatever mode you're in: a window resize or a scale change no longer
  // throws away a 3D scene.
  function rebuild() {
    const vw = Math.max(1, canvas.clientWidth), vh = Math.max(1, canvas.clientHeight);
    canvas.width = vw; canvas.height = vh;
    const [tw, th] = targetDims();
    if (PG.mode3d) {
      PG.resizeGrid3(tw, th, PG.D);
      syncDepthUI();
      setFocusZ(PG.v3.focusZ);
    } else if (PG.type) {
      PG.resizeGrid(tw, th); // keep the scene across resizes
    } else {
      PG.initGrid(tw, th);
    }
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
    const bx = Math.round(cx), by = Math.round(cy);
    for (let k = 0; k < penCells.length; k += 2) {
      const x = bx + penCells[k], y = by + penCells[k + 1];
      if (!PG.inBounds(x, y)) continue;
      if (erase) { PG.set(x, y, 0, 0); continue; }
      if (!PG.isEmpty(x, y)) continue;
      let l = PG.initLife(id);
      if (id === E.FAN || id === E.LASER) l = strokeDir;
      PG.set(x, y, id, l);
    }
  }

  function applyTool(cx, cy, dx, dy, isErase) {
    if (isErase) {
      // right-click with the player tool picks the player back up
      if (current.kind === "tool" && current.id === "player" && PG.player) PG.player = null;
      stamp(cx, cy, 0, true);
      return;
    }
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
    const bx = Math.round(gx), by = Math.round(gy), bz = Math.round(gz);
    for (let k = 0; k < penCells.length; k += 2) {
      const da = penCells[k], db = penCells[k + 1];
      if (mode === "slice") {               // footprint lies in the x-y slice
        const x = bx + da, y = by + db, z = bz;
        if (!PG.inBounds3(x, y, z)) continue;
        if (erase) { PG.set3(x, y, z, 0, 0); continue; }
        if (!PG.isEmpty3(x, y, z)) continue;
        let l = PG.initLife(id);
        if (id === E.FAN || id === E.LASER) l = strokeDir;
        PG.set3(x, y, z, id, l);
      } else {                              // footprint lies on the x-z plane
        const x = bx + da, z = bz + db;
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

  function applyTool3At(g, gd, isErase) {
    if (isErase) {
      if (current.kind === "tool" && current.id === "player" && PG.player) PG.player = null;
      stamp3(g[0], g[1], g[2], 0, true);
      return;
    }
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
    dismissHint();
    const [mx, my] = screenPos(ev);
    // 3D camera: middle-drag moves the box, left-drag started outside it orbits
    if (PG.mode3d && (ev.button === 1 || (ev.button === 0 && outsideBox(mx, my)))) {
      ev.preventDefault();
      camTween = null; // grabbing the camera cancels a reset in progress
      if (ev.button === 1) panning = true; else orbiting = true;
      canvas.style.cursor = panning ? "move" : "grabbing";
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
  // In 3D the cursor says what a drag will do: orbit (outside the box) or paint.
  function setCursor(mx, my) {
    const c = !PG.mode3d ? "" : panning ? "move" : orbiting ? "grabbing" :
      outsideBox(mx, my) ? "grab" : "";
    if (canvas.style.cursor !== c) canvas.style.cursor = c;
  }
  canvas.addEventListener("pointermove", ev => {
    moveBrush(ev);
    setCursor(...screenPos(ev));
    if (panning) { // the renderer keeps the box from leaving the view
      const [mx, my] = screenPos(ev);
      PG.v3.panX += mx - lastPX; PG.v3.panY += my - lastPY;
      lastPX = mx; lastPY = my;
      return;
    }
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
  const stopDraw = () => { drawing = 0; orbiting = panning = false; lastG3 = null; };
  // a middle press would otherwise start the browser's autoscroll
  canvas.addEventListener("mousedown", ev => { if (ev.button === 1) ev.preventDefault(); });
  canvas.addEventListener("auxclick", ev => { if (ev.button === 1) ev.preventDefault(); });
  canvas.addEventListener("pointerup", stopDraw);
  canvas.addEventListener("pointercancel", stopDraw);
  // alt-tabbing mid-stroke used to leave the brush latched down
  window.addEventListener("blur", () => { stopDraw(); PG.keys = {}; });
  canvas.addEventListener("wheel", ev => {
    if (!PG.mode3d) return;
    ev.preventDefault();
    camTween = null;
    PG.v3.zoom = Math.max(0.3, Math.min(3.5, PG.v3.zoom * (ev.deltaY < 0 ? 1.1 : 0.9)));
  }, { passive: false });

  // ---- brush preview -------------------------------------------------------
  const brushEl = $("brush");
  // the ring encloses exactly the cells the next stamp paints: N cells across
  // (+2 for its border), centred on the footprint and snapped to the cell grid
  function brushDiameter() { return penSize * PG.scale + 2; }
  let brushCX = 0, brushCY = 0;
  function placeBrush() {
    const mid = (penLo + penHi + 1) / 2; // footprint centre, in cells from its origin cell
    brushEl.style.width = brushEl.style.height = brushDiameter() + "px";
    brushEl.style.left = PG.viewOffX + (brushCX + mid) * PG.scale + "px";
    brushEl.style.top = PG.viewOffY + (brushCY + mid) * PG.scale + "px";
  }
  function moveBrush(ev) {
    if (PG.mode3d) { brushEl.classList.add("hidden"); return; } // no circular footprint in 3D
    [brushCX, brushCY] = cellPos(ev);
    placeBrush();
    brushEl.classList.remove("hidden");
  }
  canvas.addEventListener("pointerleave", () => brushEl.classList.add("hidden"));

  const hintEl = $("hint");
  let hintGone = false;
  function dismissHint() {
    if (hintGone) return;
    hintGone = true;
    hintEl.classList.add("gone");
    setTimeout(() => hintEl.classList.add("hidden"), 500);
  }
  setTimeout(dismissHint, 9000);

  // ---- toast ---------------------------------------------------------------
  const toastEl = $("toast");
  let toastTimer = null;
  function toast(msg, warn) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("warn", !!warn);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  // ---- keyboard ----------------------------------------------------------
  function isTyping(ev) {
    const t = ev.target;
    return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
  }
  // Letters are stored lower-case: with Shift (or Caps Lock) a key can go down
  // as "x" and come up as "X", which used to leave the player firing forever.
  const keyName = ev => ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  window.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { closeHelp(); return; }
    if (!helpEl.classList.contains("hidden")) { // modal: keys stay with the dialog
      if (ev.key === "Tab") { ev.preventDefault(); $("help-close").focus(); }
      else if (ev.key === "?") { ev.preventDefault(); closeHelp(); }
      return;
    }
    if (isTyping(ev)) return;              // don't steer the player while filtering
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    PG.keys[keyName(ev)] = true;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(ev.key)) {
      ev.preventDefault();
    }
    if (ev.key === "p" || ev.key === "P") togglePause();
    if (ev.key === "?") { ev.preventDefault(); toggleHelp(); }
    if (ev.key === "/") { ev.preventDefault(); searchEl.focus(); searchEl.select(); }
    if (ev.key >= "1" && ev.key <= "5") setPen(PEN_SIZES[+ev.key - 1]);
    if (PG.mode3d) {
      if (ev.key === "r" || ev.key === "R") resetCamera();
      if (ev.key === "[") setFocusZ(PG.v3.focusZ - 1);
      if (ev.key === "]") setFocusZ(PG.v3.focusZ + 1);
    }
  });
  window.addEventListener("keyup", ev => { PG.keys[keyName(ev)] = false; });

  // ---- sidebar -----------------------------------------------------------
  function makeBtn(parent, label, swatchColor, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (swatchColor) {
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = swatchColor;
      sw.style.color = swatchColor;
      btn.appendChild(sw);
    }
    const text = document.createElement("span");
    text.textContent = label;
    btn.appendChild(text);
    btn.title = label;
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
    return btn;
  }
  function selectIn(container, btn) {
    container.querySelectorAll("button").forEach(b => {
      b.classList.remove("selected");
      b.setAttribute("aria-pressed", "false");
    });
    btn.classList.add("selected");
    btn.setAttribute("aria-pressed", "true");
  }
  // A real click leaves focus on the button, so a later Enter/Space re-fires it
  // (press Clear, hit Enter, lose the scene). Drop focus after pointer clicks
  // only — keyboard users keep theirs.
  document.getElementById("sidebar").addEventListener("click", ev => {
    const b = ev.target.closest("button");
    if (b && ev.detail > 0) b.blur();
  });

  const paletteEl = $("palette");
  const toolsEl = $("tools");
  const selChip = $("stat-sel");

  function setBrushLabel(name, color) {
    selChip.textContent = name;
    selChip.title = "Brush: " + name;
    selChip.style.setProperty("--sw", color);
  }
  function clearSelections() {
    paletteEl.querySelectorAll("button").forEach(b => {
      b.classList.remove("selected"); b.setAttribute("aria-pressed", "false");
    });
    toolsEl.querySelectorAll("button").forEach(b => {
      b.classList.remove("selected"); b.setAttribute("aria-pressed", "false");
    });
  }
  function choose(btn, next, name, color) {
    current = next;
    clearSelections();
    btn.classList.add("selected");
    btn.setAttribute("aria-pressed", "true");
    setBrushLabel(name, color);
  }

  // What each element does — shown as the palette tooltip.
  const ABOUT = {
    [E.POWDER]: "falls and piles up", [E.WATER]: "flows and levels; dissolves salt",
    [E.FIRE]: "burns what it touches; water douses it to steam", [E.SEED]: "sprouts into vine when wet",
    [E.GPOWDER]: "gunpowder: blasts when lit", [E.FAN]: "blows air the way you drag it",
    [E.ICE]: "slowly freezes water it touches", [E.SNOW]: "light powder; melts in water",
    [E.GAS]: "drifts up; burns with a pressure pop", [E.CLONE]: "copies the first thing that touches it",
    [E.SALT]: "powder; dissolves into saltwater", [E.SALTWATER]: "liquid; conducts electricity",
    [E.OIL]: "floats on water and burns", [E.THUNDER]: "lightning: strikes, ignites, electrifies",
    [E.SPARK]: "electricity; runs through metal, mercury, saltwater", [E.NITRO]: "liquid explosive",
    [E.C4]: "solid explosive; huge blast when lit", [E.STONE]: "heavy powder; magma melts it",
    [E.MAGMA]: "molten rock; cools to stone in water", [E.VIRUS]: "infects almost anything, then dies off",
    [E.SOAPY]: "liquid; whips into bubbles in wind", [E.PUMP]: "vacuum: sucks air and swallows loose dots",
    [E.MERCURY]: "dense liquid metal; conducts", [E.ACID]: "dissolves nearly anything; glass resists",
    [E.VINE]: "grows upward", [E.WOOD]: "solid; burns slowly", [E.FUSE]: "solid; burns along at a steady pace",
    [E.LASER]: "beam the way you drag; passes glass, ignites", [E.CLOUD]: "soaks up steam and rains",
    [E.ANT]: "crawls, climbs walls, builds tunnels", [E.TORCH]: "an endless flame",
    [E.BIRD]: "flies about and eats ants; water kills it", [E.FISH]: "swims in water; flops out of it",
    [E.METAL]: "solid; conducts electricity", [E.BOMB]: "arms, then explodes on contact",
    [E.BUBBLE]: "floats up and pops", [E.STEAM]: "rises and condenses back to water",
    [E.GLASS]: "solid; shrugs off acid and blasts", [E.FIREWORK]: "rockets up and bursts",
  };
  for (const id of PG.paletteOrder) {
    const el = els[id];
    const btn = makeBtn(paletteEl, el.name, el.color,
      () => choose(btn, { kind: "element", id }, el.name, el.color));
    if (ABOUT[id]) btn.title = el.name + " \u2014 " + ABOUT[id];
    btn.dataset.name = el.name;
    btn.setAttribute("aria-pressed", String(id === E.POWDER));
    if (id === E.POWDER) btn.classList.add("selected");
  }

  const toolDefs = [
    ["wind", "#9ad", "wind", "drag to push the air that way"],
    ["cyclone", "#7cf", "cyclone", "spin the air into a vortex"],
    ["block", "#777", "block", "unbreakable wall: stops blasts and acid"],
    ["erase", "#222", "erase", "remove dots (right-drag erases with anything)"],
    ["player", "#fff", "player", "place the stick figure; right-click removes it"],
  ];
  for (const [tid, color, label, about] of toolDefs) {
    const btn = makeBtn(toolsEl, label, color,
      () => choose(btn, { kind: "tool", id: tid }, label, color));
    btn.title = label + " \u2014 " + about;
    btn.setAttribute("aria-pressed", "false");
  }

  // ---- element filter --------------------------------------------------------
  const searchEl = $("palette-search");
  const paletteCountEl = $("palette-count");
  const paletteEmptyEl = $("palette-empty");
  const paletteBtns = [...paletteEl.querySelectorAll("button")];

  function applyFilter() {
    const q = searchEl.value.trim().toLowerCase();
    let shown = 0;
    for (const b of paletteBtns) {
      const hit = !q || b.dataset.name.includes(q);
      b.classList.toggle("hidden", !hit);
      if (hit) shown++;
    }
    paletteEmptyEl.classList.toggle("hidden", shown > 0);
    paletteCountEl.textContent = q ? shown + " / " + paletteBtns.length : paletteBtns.length;
  }
  searchEl.addEventListener("input", applyFilter);
  searchEl.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { // jump straight to the first match
      const first = paletteBtns.find(b => !b.classList.contains("hidden"));
      if (first) { first.click(); searchEl.blur(); }
    } else if (ev.key === "Escape") {
      if (searchEl.value) { searchEl.value = ""; applyFilter(); }
      else searchEl.blur();
      ev.stopPropagation();
    }
  });
  applyFilter();

  // ---- pen / options ----------------------------------------------------------
  const PEN_SIZES = [1, 2, 4, 8, 16];
  const penEl = $("pen-sizes");
  const penBtns = new Map();
  function setPen(s) {
    if (!penBtns.has(s)) return;
    penSize = s;
    buildPen(s);
    selectIn(penEl, penBtns.get(s));
    if (!brushEl.classList.contains("hidden")) placeBrush(); // resize the visible ring now
  }
  for (const s of PEN_SIZES) {
    const btn = makeBtn(penEl, String(s), null, () => setPen(s));
    btn.title = (s === 1 ? "1 dot" : s + " dots") + " across (key " + (PEN_SIZES.indexOf(s) + 1) + ")";
    btn.setAttribute("aria-pressed", String(s === penSize));
    penBtns.set(s, btn);
    if (s === penSize) btn.classList.add("selected");
  }

  const scaleEl = $("scale-btns");
  for (const s of [2, 3, 4, 6]) {
    const btn = makeBtn(scaleEl, s + "px", null, () => {
      PG.scale = s; selectIn(scaleEl, btn); rebuild();
    });
    btn.title = "Each dot is " + s + " screen pixels; smaller fits more dots";
    btn.setAttribute("aria-pressed", String(s === PG.scale));
    if (s === PG.scale) btn.classList.add("selected");
  }

  const speedEl = $("speed-btns");
  for (const s of [1, 2, 4]) {
    const btn = makeBtn(speedEl, s + "x", null, () => {
      PG.speed = s; selectIn(speedEl, btn);
    });
    btn.title = s === 1 ? "Normal speed" : s + " simulation steps per frame";
    btn.setAttribute("aria-pressed", String(s === PG.speed));
    if (s === PG.speed) btn.classList.add("selected");
  }

  const bgSel = $("bg-select");
  const VIEW_LABELS = { non: "none", air: "air pressure", line: "wind lines", blur: "motion blur",
    shade: "shade", aura: "wind aura", light: "light", toon: "toon", mesh: "air mesh",
    gray: "grayscale", track: "trails", dark: "dark (glow only)", TG: "thermal", siluet: "silhouette" };
  PG.BG_NAMES.forEach((name, idx) => {
    const opt = document.createElement("option");
    opt.value = idx; opt.textContent = VIEW_LABELS[name] || name;
    bgSel.appendChild(opt);
  });
  bgSel.value = PG.bgMode;
  bgSel.addEventListener("change", () => { PG.bgMode = +bgSel.value; });

  const wavesEl = $("waves-btns");
  [["off", 0, "Liquid surfaces lie still"], ["on", 1, "Gentle waves roll across liquids"],
   ["max", 2, "Big rolling swells"]].forEach(([name, str, about]) => {
    const btn = makeBtn(wavesEl, name, null, () => {
      PG.waveStr = str; selectIn(wavesEl, btn);
    });
    btn.title = about;
    btn.setAttribute("aria-pressed", String(str === PG.waveStr));
    if (str === PG.waveStr) btn.classList.add("selected");
  });

  const liquidEl = $("liquid-btns");
  [["classic", 0, "Powder Game's liquid: falls, spreads and levels, but pressure doesn't carry through it"],
   ["fluid", 1, "A real fluid: pressure evens out U-tubes, drops splash, pools slosh (heavier on the CPU)"]].forEach(([name, mode, about]) => {
    const btn = makeBtn(liquidEl, name, null, () => {
      PG.fluidMode = mode; selectIn(liquidEl, btn); PG.wakeLiquids && PG.wakeLiquids();
    });
    btn.title = about;
    btn.setAttribute("aria-pressed", String(mode === PG.fluidMode));
    if (mode === PG.fluidMode) btn.classList.add("selected");
  });

  // ---- 3D mode controls ----------------------------------------------------
  const btn3d = $("btn-3d");
  const ctl3d = $("threed-controls");
  const sliceVal = $("slice-val");
  const modeChip = $("stat-mode");

  function setFocusZ(z) {
    PG.v3.focusZ = Math.max(0, Math.min((PG.D || 1) - 1, z));
    sliceVal.textContent = PG.v3.focusZ + " / " + Math.max(0, (PG.D || 1) - 1);
  }
  const camBtn = $("btn-cam");
  camBtn.addEventListener("click", resetCamera);
  function set3DUI(on) {
    camBtn.classList.toggle("hidden", !on);
    btn3d.textContent = on ? "Exit 3D" : "Enter 3D";
    btn3d.classList.toggle("selected", on);
    btn3d.setAttribute("aria-pressed", String(on));
    ctl3d.classList.toggle("hidden", !on);
    modeChip.textContent = on ? "3D" : "2D";
    modeChip.classList.toggle("on", on);
    if (on) brushEl.classList.add("hidden");
  }
  PG.on3DExited = () => { set3DUI(false); syncDepthUI(); };

  btn3d.addEventListener("click", () => {
    if (!PG.mode3d) {
      PG.enter3D();
      PG.v3.t = 0; PG.v3.entering = true; PG.v3.exiting = false;
      Object.assign(PG.v3, DEFAULT_CAM); camTween = null;
      setFocusZ(0);
      syncDepthUI();
      set3DUI(true);
      ctl3d.scrollIntoView({ block: "nearest" }); // the new controls just appeared
    } else if (PG.v3.exiting) {            // changed your mind mid-exit: turn back
      PG.v3.exiting = false; PG.v3.entering = true;
      set3DUI(true);
    } else {                                // leave 3D (also reverses a half-done entry)
      PG.v3.exiting = true; PG.v3.entering = false;
      set3DUI(false);                       // the button now offers what a click will do
    }
  });

  const draw3dEl = $("draw3d-btns");
  [["slice", "slice", "Paint on the current slice ([ ] to move it)"],
   ["top", "top", "Rain down from the top of the box"],
   ["floor", "floor", "Pile up on whatever is already on the floor"]].forEach(([label, mode, about]) => {
    const btn = makeBtn(draw3dEl, label, null, () => {
      PG.v3.drawMode = mode; selectIn(draw3dEl, btn);
    });
    btn.title = about;
    btn.setAttribute("aria-pressed", String(mode === "slice"));
    if (mode === "slice") btn.classList.add("selected");
  });
  $("slice-minus").addEventListener("click", () => setFocusZ(PG.v3.focusZ - 1));
  $("slice-plus").addEventListener("click", () => setFocusZ(PG.v3.focusZ + 1));

  // ---- size sliders ---------------------------------------------------------
  const slW = $("sl-w"), slWv = $("sl-w-val");
  const slH = $("sl-h"), slHv = $("sl-h-val");
  const slD = $("sl-d"), slDv = $("sl-d-val");

  function syncDepthUI() { // show the depth you actually get, not the raw slider
    if (PG.mode3d) { slD.value = Math.min(+slD.max, PG.D); slDv.textContent = PG.D; }
    else slDv.textContent = PG.depthPref ? slD.value : "auto";
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
      setFocusZ(PG.v3.focusZ);
    }
    syncDepthUI();
  });

  const pauseBtn = $("btn-pause");
  function togglePause() {
    PG.paused = !PG.paused;
    pauseBtn.innerHTML = PG.paused
      ? '<span class="glyph">&#9654;</span> Resume'
      : '<span class="glyph">&#10074;&#10074;</span> Pause';
    pauseBtn.setAttribute("aria-pressed", String(PG.paused));
    pauseBtn.classList.toggle("selected", PG.paused);
  }
  pauseBtn.addEventListener("click", togglePause);
  $("btn-clear").addEventListener("click", () => {
    if (PG.mode3d) PG.clearGrid3(); else PG.clearGrid();
    toast("cleared");
  });

  // ---- save / load ---------------------------------------------------------
  // Payload: run-length encoded element ids plus the directions of fans/lasers
  // (they keep their aim in `life`). v2 adds a depth so 3D boxes round-trip;
  // a payload with no version is a legacy 2D save and still loads.
  const SAVE_KEY = "powdergame-save";

  function rleEncode(arr) {
    const rle = [];
    let run = 1;
    for (let i = 1; i <= arr.length; i++) {
      if (i < arr.length && arr[i] === arr[i - 1] && run < 65535) run++;
      else { rle.push(run, arr[i - 1]); run = 1; }
    }
    return rle;
  }
  function rleDecode(rle, limit, cb) {
    let i = 0;
    for (let k = 0; k + 1 < rle.length; k += 2) {
      const run = rle[k] | 0, t = rle[k + 1] | 0;
      if (run <= 0) continue;
      if (t === 0) { i += run; if (i >= limit) return; continue; }
      for (let r = 0; r < run; r++, i++) {
        if (i >= limit) return;
        cb(i, t);
      }
    }
  }
  function aimedCells(types, lifes) {
    const out = [];
    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      if (t === E.FAN || t === E.LASER) out.push(i, lifes[i]);
    }
    return out;
  }

  $("btn-save").addEventListener("click", () => {
    const t = PG.mode3d ? PG.t3 : PG.type, l = PG.mode3d ? PG.l3 : PG.life;
    const payload = {
      v: 2, mode: PG.mode3d ? "3d" : "2d",
      w: PG.W, h: PG.H, d: PG.mode3d ? PG.D : 1,
      scale: PG.scale, rle: rleEncode(t), fans: aimedCells(t, l),
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      toast(PG.mode3d ? "saved 3D scene" : "saved");
    } catch (e) {
      toast(e && e.name === "QuotaExceededError" ? "scene too big to save" : "save failed", true);
    }
  });

  function readSave() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    let s;
    try { s = JSON.parse(raw); } catch (e) { return "corrupt"; }
    if (!s || typeof s !== "object" || !Array.isArray(s.rle) ||
        !(s.w > 0) || !(s.h > 0)) return "corrupt";
    if (!Array.isArray(s.fans)) s.fans = [];
    if (!(s.d > 0)) s.d = 1;
    return s;
  }

  // Saves land anchored bottom-centre (and front in z), matching how the grid
  // itself re-anchors on a resize, so a scene reloads roughly where you left it.
  function offsets(s) {
    return [Math.floor((PG.W - s.w) / 2), PG.H - s.h];
  }
  function loadPlane(s, srcZ) { // one z-plane of the save -> the 2D grid
    const plane = s.w * s.h, base = plane * srcZ;
    const [ox, oy] = offsets(s);
    PG.clearGrid();
    rleDecode(s.rle, base + plane, (i, t) => {
      if (i < base) return;
      const j = i - base, x = (j % s.w) + ox, y = ((j / s.w) | 0) + oy;
      if (PG.inBounds(x, y)) PG.set(x, y, t, PG.initLife(t));
    });
    for (let k = 0; k + 1 < s.fans.length; k += 2) {
      const j = s.fans[k] - base;
      if (j < 0 || j >= plane) continue;
      const x = (j % s.w) + ox, y = ((j / s.w) | 0) + oy;
      if (!PG.inBounds(x, y)) continue;
      const i = PG.idx(x, y);
      if (PG.type[i] === E.FAN || PG.type[i] === E.LASER) PG.life[i] = s.fans[k + 1];
    }
  }
  function loadBox(s, dstZ) { // whole save -> the 3D box (dstZ offsets flat saves)
    const plane = s.w * s.h;
    const [ox, oy] = offsets(s);
    PG.clearGrid3();
    rleDecode(s.rle, plane * s.d, (i, t) => {
      const z = ((i / plane) | 0) + dstZ, j = i % plane;
      const x = (j % s.w) + ox, y = ((j / s.w) | 0) + oy;
      if (PG.inBounds3(x, y, z)) PG.set3(x, y, z, t, PG.initLife(t));
    });
    for (let k = 0; k + 1 < s.fans.length; k += 2) {
      const i = s.fans[k], z = ((i / plane) | 0) + dstZ, j = i % plane;
      const x = (j % s.w) + ox, y = ((j / s.w) | 0) + oy;
      if (!PG.inBounds3(x, y, z)) continue;
      const c = PG.idx3(x, y, z);
      if (PG.t3[c] === E.FAN || PG.t3[c] === E.LASER) PG.l3[c] = s.fans[k + 1];
    }
  }

  $("btn-load").addEventListener("click", () => {
    const s = readSave();
    if (!s) { toast("nothing saved yet", true); return; }
    if (s === "corrupt") { toast("save file is unreadable", true); return; }
    const is3d = s.d > 1;
    if (PG.mode3d) {
      loadBox(s, is3d ? 0 : PG.v3.focusZ);
      setFocusZ(PG.v3.focusZ);
      toast(is3d ? "loaded 3D scene" : "loaded into slice " + PG.v3.focusZ);
    } else {
      loadPlane(s, 0);
      toast(is3d ? "loaded front slice of 3D save" : "loaded");
    }
  });

  // ---- png export ----------------------------------------------------------
  $("btn-shot").addEventListener("click", () => {
    try {
      canvas.toBlob(blob => {
        if (!blob) { toast("export failed", true); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "powder-game-" + Date.now() + ".png";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast("PNG downloaded");
      }, "image/png");
    } catch (e) { toast("export failed", true); }
  });

  // ---- help overlay --------------------------------------------------------
  const helpEl = $("help-overlay");
  function openHelp() {
    helpEl.classList.remove("hidden");
    $("help-close").focus();
  }
  function closeHelp() {
    if (helpEl.classList.contains("hidden")) return;
    helpEl.classList.add("hidden");
    $("btn-help").focus();
  }
  function toggleHelp() {
    if (helpEl.classList.contains("hidden")) openHelp(); else closeHelp();
  }
  $("btn-help").addEventListener("click", toggleHelp);
  $("help-close").addEventListener("click", closeHelp);
  helpEl.addEventListener("click", ev => { if (ev.target === helpEl) closeHelp(); });

  // ---- collapsible panel (narrow screens) ----------------------------------
  const panelBtn = $("btn-panel");
  panelBtn.addEventListener("click", () => {
    const hidden = document.body.classList.toggle("panel-hidden");
    panelBtn.setAttribute("aria-expanded", String(!hidden));
    panelBtn.blur();
  });
  if (window.matchMedia("(max-width: 760px)").matches) {
    document.body.classList.add("panel-hidden");
    panelBtn.setAttribute("aria-expanded", "false");
  }

  // ---- main loop -----------------------------------------------------------
  const fpsEl = $("stat-fps");
  const partsEl = $("stat-parts");
  const dimsEl = $("stat-dims");
  let frames = 0, lastFps = performance.now();

  function loop() {
    if (PG.mode3d) {
      if (PG.keys.q || PG.keys.e) camTween = null; // spinning takes over from a reset
      stepCamTween();
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
      dimsEl.textContent = PG.mode3d
        ? PG.W + "×" + PG.H + "×" + PG.D
        : PG.W + "×" + PG.H;
      frames = 0; lastFps = now;
    }
    requestAnimationFrame(loop);
  }

  // ---- opening scene -------------------------------------------------------
  // A dune with a pond in it, so the field shows powder and liquid settling the
  // moment the page loads instead of opening on an empty black rectangle.
  function seedScene() {
    const W = PG.W, H = PG.H;
    const base = Math.max(6, Math.round(H * 0.13));
    const basin = 0.19; // half-width of the pond, as a fraction of the field
    for (let x = 0; x < W; x++) {
      const t = x / W, off = Math.abs(t - 0.5);
      let h = base + Math.round(Math.sin(t * 7.5) * base * 0.26 +
                                Math.sin(t * 2.3 + 1) * base * 0.2);
      if (off < basin) h -= Math.round(base * 0.75 * (1 - off / basin));
      h = Math.max(2, h);
      for (let y = H - h; y < H; y++) PG.set(x, y, E.POWDER, 0);
      if (off < basin - 0.005) {
        for (let y = H - base + 1; y < H - h; y++) PG.set(x, y, E.WATER, 0);
      }
    }
  }

  setBrushLabel(els[E.POWDER].name, els[E.POWDER].color);
  set3DUI(false);
  rebuild();
  syncDepthUI();
  seedScene();
  loop();
})();
