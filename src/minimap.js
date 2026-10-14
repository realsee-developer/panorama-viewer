/**
 * minimap.js — Equirectangular thumbnail with current-viewport overlay.
 *
 * The minimap is a 2:1 canvas showing the whole panorama. The region the user
 * is currently looking at is kept bright; everything else is darkened.
 *
 * The visible region of a perspective camera is NOT a rectangle on an
 * equirectangular map — straight screen edges become curves (and bow strongly
 * near the poles). So we trace the actual view frustum: we sample points along
 * the four screen edges, turn each into a world-space ray direction, convert
 * that to lon/lat, and draw the resulting polygon. Horizontal wraparound is
 * handled by drawing the polygon shifted by ±W.
 *
 * Equirect mapping:
 *   x = (lon + 180) / 360 * W      (lon in [-180,180])
 *   y = (90 - lat) / 180 * H       (lat in [-90,90])
 *
 * Clicking the minimap sets the view direction to that lon/lat.
 */

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bitmap = null;
    this.view = { lon: 0, lat: 0, fov: 75 };
    this.aspect = 16 / 9; // viewport aspect, updated by setViewportAspect
    this.onPick = null; // callback(lon, lat)

    this._w = 0;
    this._h = 0;

    canvas.addEventListener('click', (e) => this._handleClick(e));
    canvas.addEventListener('pointerdown', (e) => {
      // allow click-drag scrubbing
      this._scrub = true;
      this._handleClick(e);
    });
    window.addEventListener('pointerup', () => (this._scrub = false));
    canvas.addEventListener('pointermove', (e) => {
      if (this._scrub) this._handleClick(e);
    });
  }

  setImage(bitmap) {
    this.bitmap = bitmap;
    this._resizeBacking();
    this.draw();
  }

  setViewportAspect(aspect) {
    this.aspect = aspect;
  }

  update(lon, lat, fov) {
    this.view.lon = lon;
    this.view.lat = lat;
    this.view.fov = fov;
    this.draw();
  }

  _resizeBacking() {
    // Match backing store to displayed size * DPR for crispness.
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._w = Math.max(2, Math.round(rect.width));
    this._h = Math.max(1, Math.round(rect.width / 2)); // enforce 2:1
    this.canvas.width = this._w * dpr;
    this.canvas.height = this._h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw() {
    if (!this.bitmap || !this._w) return;
    const ctx = this.ctx;
    const W = this._w;
    const H = this._h;

    ctx.clearRect(0, 0, W, H);

    // Base: darkened whole map.
    ctx.drawImage(this.bitmap, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, W, H);

    // Build the frustum outline (array of {x,y} in map pixels; x may wrap).
    const loops = this._frustumLoops(W, H);
    if (loops.length === 0) return;

    // Reveal the bright image inside the frustum region (clip + redraw).
    ctx.save();
    ctx.beginPath();
    for (const loop of loops) this._tracePath(ctx, loop);
    ctx.clip();
    ctx.drawImage(this.bitmap, 0, 0, W, H);
    ctx.restore();

    // Outline.
    ctx.strokeStyle = '#e2231a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const loop of loops) this._tracePath(ctx, loop);
    ctx.stroke();

    // Center (look direction) dot.
    const c = this._dirToMap(this._viewDir(0, 0), W, H);
    ctx.fillStyle = '#e2231a';
    ctx.beginPath();
    ctx.arc(((c.x % W) + W) % W, c.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  _tracePath(ctx, loop) {
    ctx.moveTo(loop[0].x, loop[0].y);
    for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i].x, loop[i].y);
    ctx.closePath();
  }

  /**
   * Trace the camera frustum boundary into closed loops in map pixel space.
   *
   * The hard case is when a pole (zenith/nadir) falls inside the view: the
   * visible region then wraps all 360° of longitude as a "cap" touching the
   * top/bottom map edge, which a simple perimeter polygon can't represent. We
   * detect that and build the cap explicitly from the per-longitude latitude
   * extent of the sampled frustum boundary.
   */
  _frustumLoops(W, H) {
    const fovY = (this.view.fov * Math.PI) / 180;
    const tanY = Math.tan(fovY / 2);
    const tanX = tanY * this.aspect;

    // Dense sample of the whole screen-rectangle perimeter.
    const N = 48;
    const samples = [];
    const edge = (ax, ay, bx, by) => {
      for (let i = 0; i < N; i++) {
        const t = i / N;
        const nx = ax + (bx - ax) * t;
        const ny = ay + (by - ay) * t;
        samples.push(this._dirToLonLat(this._viewDir(nx * tanX, ny * tanY)));
      }
    };
    edge(-1, -1, 1, -1);
    edge(1, -1, 1, 1);
    edge(1, 1, -1, 1);
    edge(-1, 1, -1, -1);

    const zenithIn = this._poleInView(1, tanX, tanY); // (0,+1,0)
    const nadirIn = this._poleInView(-1, tanX, tanY); // (0,-1,0)

    if (zenithIn || nadirIn) {
      return this._capLoops(samples, W, H, zenithIn);
    }

    // Normal case: continuous perimeter polygon, longitude unwrapped.
    const base = [];
    let prevX = null;
    for (const { lon, lat } of samples) {
      let x = ((lon + 180) / 360) * W;
      const y = ((90 - lat) / 180) * H;
      if (prevX !== null) {
        while (x - prevX > W / 2) x -= W;
        while (x - prevX < -W / 2) x += W;
      }
      base.push({ x, y });
      prevX = x;
    }
    return [-W, 0, W].map((off) => base.map((p) => ({ x: p.x + off, y: p.y })));
  }

  /**
   * Build a pole-cap polygon: for each longitude column, find how far the
   * frustum boundary reaches away from the pole, then close the shape along
   * the pole edge across the full map width.
   */
  _capLoops(samples, W, H, isZenith) {
    const BINS = 180;
    // For a zenith cap we track the *max* y (lowest point) the boundary
    // reaches per column; the bright region is from the top edge down to it.
    // For a nadir cap it's the *min* y, bright region from bottom edge up.
    const bound = new Array(BINS).fill(isZenith ? 0 : H);
    for (const { lon, lat } of samples) {
      const col = Math.min(
        BINS - 1,
        Math.max(0, Math.floor(((lon + 180) / 360) * BINS))
      );
      const y = ((90 - lat) / 180) * H;
      if (isZenith) bound[col] = Math.max(bound[col], y);
      else bound[col] = Math.min(bound[col], y);
    }
    // Fill gaps (columns with no sample) by nearest-neighbour so the curve is
    // continuous all the way around.
    let last = isZenith ? 0 : H;
    for (let i = 0; i < BINS; i++) {
      if (
        (isZenith && bound[i] === 0) ||
        (!isZenith && bound[i] === H)
      ) {
        bound[i] = last;
      } else {
        last = bound[i];
      }
    }

    const loop = [];
    for (let i = 0; i < BINS; i++) {
      loop.push({ x: (i / BINS) * W, y: bound[i] });
    }
    loop.push({ x: W, y: bound[BINS - 1] });
    if (isZenith) {
      // Close along the top edge.
      loop.push({ x: W, y: 0 });
      loop.push({ x: 0, y: 0 });
    } else {
      // Close along the bottom edge.
      loop.push({ x: W, y: H });
      loop.push({ x: 0, y: H });
    }
    return [loop];
  }

  /** Is the pole (dirY = +1 zenith / -1 nadir) inside the view frustum? */
  _poleInView(dirY, tanX, tanY) {
    // Transform the pole world direction into camera space and test the tan
    // bounds. Reuse the same basis as _viewDir.
    const lon = (this.view.lon * Math.PI) / 180;
    const lat = (this.view.lat * Math.PI) / 180;
    const f = {
      x: Math.cos(lat) * Math.sin(lon),
      y: Math.sin(lat),
      z: Math.cos(lat) * Math.cos(lon),
    };
    let r = { x: f.z, y: 0, z: -f.x };
    const rl = Math.hypot(r.x, r.y, r.z) || 1;
    r = { x: r.x / rl, y: r.y / rl, z: r.z / rl };
    const u = {
      x: f.y * r.z - f.z * r.y,
      y: f.z * r.x - f.x * r.z,
      z: f.x * r.y - f.y * r.x,
    };
    const p = { x: 0, y: dirY, z: 0 };
    const cz = p.x * f.x + p.y * f.y + p.z * f.z; // forward
    if (cz <= 1e-4) return false; // behind camera
    const cx = p.x * r.x + p.y * r.y + p.z * r.z;
    const cy = p.x * u.x + p.y * u.y + p.z * u.z;
    return Math.abs(cx / cz) <= tanX && Math.abs(cy / cz) <= tanY;
  }

  /** World ray direction for a screen offset (xTan, yTan) from view center. */
  _viewDir(xTan, yTan) {
    const lon = (this.view.lon * Math.PI) / 180;
    const lat = (this.view.lat * Math.PI) / 180;

    // Camera forward (toward look direction), right, up basis.
    const f = {
      x: Math.cos(lat) * Math.sin(lon),
      y: Math.sin(lat),
      z: Math.cos(lat) * Math.cos(lon),
    };
    // right = normalize(cross(worldUp, f)) with worldUp = (0,1,0)
    let r = { x: f.z, y: 0, z: -f.x };
    const rl = Math.hypot(r.x, r.y, r.z) || 1;
    r = { x: r.x / rl, y: r.y / rl, z: r.z / rl };
    // up = cross(f, r)
    const u = {
      x: f.y * r.z - f.z * r.y,
      y: f.z * r.x - f.x * r.z,
      z: f.x * r.y - f.y * r.x,
    };

    // dir = f + xTan*right + yTan*up  (yTan positive = up on screen)
    return {
      x: f.x + xTan * r.x + yTan * u.x,
      y: f.y + xTan * r.y + yTan * u.y,
      z: f.z + xTan * r.z + yTan * u.z,
    };
  }

  _dirToLonLat(d) {
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    const x = d.x / len;
    const y = d.y / len;
    const z = d.z / len;
    const lon = (Math.atan2(x, z) * 180) / Math.PI; // 0 at +Z, matches _viewDir
    const lat = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
    return { lon, lat };
  }

  _dirToMap(d, W, H) {
    const { lon, lat } = this._dirToLonLat(d);
    return { x: ((lon + 180) / 360) * W, y: ((90 - lat) / 180) * H };
  }

  _handleClick(e) {
    if (!this.bitmap || !this.onPick) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width; // 0..1
    const y = (e.clientY - rect.top) / rect.height; // 0..1
    const lon = x * 360 - 180;
    const lat = 90 - y * 180;
    this.onPick(lon, lat);
  }

  resize() {
    this._resizeBacking();
    this.draw();
  }
}
