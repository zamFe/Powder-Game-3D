// The classic stick-figure player. Arrow keys / WASD move, X shoots the
// element currently stored in its head (head absorbs dots it touches).
// In 3D mode the player lives on a z-slice and behaves exactly like in 2D.
(function () {
  const E = PG.E, els = PG.elements;

  function solidCell(t) {
    if (t === 0) return false;
    if (t === E.ANT) return true; // players/fighters can walk on ants
    const s = els[t].state;
    return s === "static" || s === "powder";
  }

  const DEADLY = {};
  DEADLY[E.FIRE] = DEADLY[E.MAGMA] = DEADLY[E.ACID] = DEADLY[E.VIRUS] =
  DEADLY[E.THUNDER] = DEADLY[E.LASER] = 1;

  class Player {
    constructor(x, y, z) {
      this.x = x; this.y = y;     // feet position, float, sim cells
      this.z = z || 0;            // depth (3D mode only)
      this.vx = 0; this.vy = 0; this.vz = 0;
      this.facing = 1;
      this.headType = E.POWDER;
      this.shootCd = 0;
      this.h = 6;                 // body height in cells
    }

    // --- mode-aware cell access (2D grid, or this player's z-slice in 3D) ---
    rz() { return Math.round(this.z); }
    gc(x, y) { return PG.mode3d ? PG.get3(x, y, this.rz()) : PG.get(x, y); }
    sc(x, y, t, l) {
      if (PG.mode3d) PG.set3(x, y, this.rz(), t, l);
      else PG.set(x, y, t, l);
    }
    emptyC(x, y) { return this.gc(x, y) === 0 && PG.inBounds(x, y); }
    airVX(x, y) { return PG.mode3d ? PG.air3.velX(x, y, this.rz()) : PG.air.velX(x, y); }
    airVY(x, y) { return PG.mode3d ? PG.air3.velY(x, y, this.rz()) : PG.air.velY(x, y); }
    blastAt(x, y, r, p) {
      if (PG.mode3d) PG.air3.blast(x, y, this.rz(), r, p);
      else PG.air.blast(x, y, r, p);
    }
    pushAir(x, y, dx, dy) {
      if (PG.mode3d) PG.air3.addVel(x, y, this.rz(), dx, dy, 0);
      else PG.air.addVel(x, y, dx, dy);
    }
    solidAt(x, y) { return solidCell(this.gc(Math.round(x), Math.round(y))); }
    liquidAt(x, y) {
      const t = this.gc(Math.round(x), Math.round(y));
      return t !== 0 && els[t].state === "liquid";
    }

    bodyCells() {
      const out = [], rx = Math.round(this.x);
      for (let dy = 0; dy <= this.h; dy++) out.push([rx, Math.round(this.y) - dy]);
      return out;
    }

    die() {
      const rx = Math.round(this.x), ry = Math.round(this.y);
      for (let k = 0; k < 14; k++) {
        const sx = rx + PG.rand(5) - 2, sy = ry - PG.rand(7);
        if (this.emptyC(sx, sy)) this.sc(sx, sy, E.FIRE, 20 + PG.rand(20));
      }
      this.blastAt(rx, ry - 3, 4, 2);
      PG.player = null;
    }

    hitByBlast(bx, by, r) {
      const dx = this.x - bx, dy = (this.y - 3) - by;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < r + 2) { this.die(); return; }
      if (d < r * 3) {
        this.vx += (dx / d) * 3; this.vy += (dy / d) * 3 - 1;
      }
    }

    update() {
      const keys = PG.keys || {};
      const inLiquid = this.liquidAt(this.x, this.y - 2);

      // hazards + head absorption
      const headY = Math.round(this.y) - this.h;
      for (const [cx, cy] of this.bodyCells()) {
        for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0]]) {
          const t = this.gc(cx + dx, cy + dy);
          if (DEADLY[t]) { this.die(); return; }
          if (cy <= headY + 1 && t !== 0 && !PG.isSolid(t) && t !== E.BOMB) {
            this.headType = t;
            this.sc(cx + dx, cy + dy, 0, 0);
          }
        }
      }

      // input (in 3D, W/S walk in depth instead of W meaning jump)
      const L = keys.ArrowLeft || keys.a, R = keys.ArrowRight || keys.d;
      const U = keys.ArrowUp || (!PG.mode3d && keys.w);
      const accel = inLiquid ? 0.1 : 0.2, maxSpd = inLiquid ? 0.6 : 1.1;
      if (L) { this.vx = Math.max(this.vx - accel, -maxSpd); this.facing = -1; }
      else if (R) { this.vx = Math.min(this.vx + accel, maxSpd); this.facing = 1; }
      else this.vx *= 0.7;

      const onGround = this.solidAt(this.x, this.y + 1) || this.y >= PG.H - 2.5;
      if (U && onGround) this.vy = -2.0;
      else if (U && inLiquid) this.vy = Math.max(this.vy - 0.25, -0.8);

      this.vy += inLiquid ? 0.04 : 0.12;
      if (inLiquid) this.vy = Math.min(this.vy, 0.5);
      this.vy = Math.max(-2.5, Math.min(2.5, this.vy));

      this.vx += this.airVX(Math.round(this.x), Math.round(this.y) - 3) * 0.05;
      this.vy += this.airVY(Math.round(this.x), Math.round(this.y) - 3) * 0.05;

      // move x, stepping up 1-cell ledges
      let nx = this.x + this.vx;
      if (!this.collidesAt(nx, this.y)) this.x = nx;
      else if (!this.collidesAt(nx, this.y - 1)) { this.x = nx; this.y -= 1; }
      else this.vx = 0;

      // move y
      let ny = this.y + this.vy;
      if (!this.collidesAt(this.x, ny)) this.y = ny;
      else {
        if (this.vy > 0) {
          while (this.vy > 0 && !this.solidAt(this.x, Math.round(this.y) + 1) &&
                 Math.round(this.y) < PG.H - 1) this.y += 1;
        }
        this.vy = 0;
      }
      this.x = Math.max(1, Math.min(PG.W - 2, this.x));
      this.y = Math.max(this.h + 1, Math.min(PG.H - 2, this.y));

      // move z (3D only): W = deeper into the box, S = toward the camera
      if (PG.mode3d) {
        const zAccel = inLiquid ? 0.08 : 0.15, zMax = inLiquid ? 0.45 : 0.8;
        if (keys.w) this.vz = Math.min(this.vz + zAccel, zMax);
        else if (keys.s) this.vz = Math.max(this.vz - zAccel, -zMax);
        else this.vz *= 0.6;
        this.vz += PG.air3.velZ(Math.round(this.x), Math.round(this.y) - 3, this.rz()) * 0.05;
        const nz = this.z + this.vz;
        if (!this.collidesAtZ(this.x, this.y, nz)) {
          this.z = Math.max(0, Math.min(PG.D - 1, nz));
        } else if (!this.collidesAtZ(this.x, this.y - 1, nz)) { // step up ledges
          this.z = Math.max(0, Math.min(PG.D - 1, nz)); this.y -= 1;
        } else this.vz = 0;
      }

      if (this.shootCd > 0) this.shootCd--;
      if ((keys.x || keys[" "]) && this.shootCd === 0) {
        this.shoot();
        this.shootCd = 3;
      }
    }

    collidesAt(px, py) {
      const rx = Math.round(px);
      for (let dy = 0; dy <= this.h; dy++) {
        if (solidCell(this.gc(rx, Math.round(py) - dy))) return true;
      }
      return false;
    }

    collidesAtZ(px, py, pz) {
      const rx = Math.round(px), rzz = Math.round(pz);
      if (rzz < 0 || rzz >= PG.D) return true;
      for (let dy = 0; dy <= this.h; dy++) {
        if (solidCell(PG.get3(rx, Math.round(py) - dy, rzz))) return true;
      }
      return false;
    }

    shoot() {
      const t = this.headType || E.POWDER;
      const hy = Math.round(this.y) - this.h + 1;
      const dir = this.facing;
      for (let k = 2; k <= 4; k++) {
        const sx = Math.round(this.x) + dir * k, sy = hy + PG.rand(2) - 1;
        if (this.emptyC(sx, sy)) {
          let l = PG.initLife(t);
          if (t === E.LASER) l = dir > 0 ? 2 : 6;
          this.sc(sx, sy, t, l);
        }
      }
      this.pushAir(Math.round(this.x) + dir * 3, hy, dir * 2.5, 0);
    }

    // pixel list shared by both renderers
    pixels() {
      const px = Math.round(this.x), py = Math.round(this.y);
      const white = 0xffffffff;
      const headCol = PG.colorVariants[this.headType]
        ? PG.colorVariants[this.headType][0] : white;
      const hy = py - this.h;
      const pts = [
        [px, hy, headCol], [px + 1, hy, headCol],
        [px, hy + 1, headCol], [px + 1, hy + 1, headCol],
        [px, hy + 2, white], [px, hy + 3, white], [px, hy + 4, white],
        [px - 1, hy + 3, white], [px + 1, hy + 3, white],
        [px - 1, py, white], [px + 1, py, white], [px, py - 1, white],
      ];
      return pts;
    }

    draw(buf, W) {
      for (const [x, y, c] of this.pixels()) {
        if (x >= 0 && y >= 0 && x < W && y < PG.H) buf[y * W + x] = c;
      }
    }

    draw3(plot) {
      for (const [x, y, c] of this.pixels()) plot(x, y, c);
    }
  }

  PG.Player = Player;
})();
