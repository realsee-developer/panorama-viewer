/**
 * minimap.js — Equirectangular thumbnail with current-viewport overlay.
 *
 * The minimap is a 2:1 canvas showing the whole panorama. The region the user
 * is currently looking at is kept bright; everything else is darkened. The
 * mapping between screen (lon/lat/fov) and the equirectangular image:
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
    ctx.drawImage(this.bitmap, 0, 0, W, H);

    // Darken the whole map, then "cut out" the visible viewport rectangle
    // by redrawing the bright image clipped to that region.
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Compute viewport footprint in lon/lat.
    const fovY = this.view.fov;
    const fovX = Math.min(
      360,
      2 *
        (Math.atan(Math.tan((fovY * Math.PI) / 360) * this.aspect) * 180) /
          Math.PI
    );

    const cx = ((this.view.lon + 180) / 360) * W;
    const halfW = (fovX / 360) * W;
    const halfH = (fovY / 180) * H;
    const cy = ((90 - this.view.lat) / 180) * H;

    // The viewport can wrap horizontally; draw up to two bright slices.
    const slices = this._wrapSlices(cx - halfW, cx + halfW, W);
    ctx.save();
    for (const [x0, x1] of slices) {
      const y0 = Math.max(0, cy - halfH);
      const y1 = Math.min(H, cy + halfH);
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      ctx.drawImage(this.bitmap, 0, 0, W, H);
      ctx.restore();
      ctx.save();
    }
    ctx.restore();

    // Viewport outline + crosshair at center.
    ctx.strokeStyle = '#e2231a';
    ctx.lineWidth = 1.5;
    for (const [x0, x1] of slices) {
      const y0 = Math.max(0, cy - halfH);
      const y1 = Math.min(H, cy + halfH);
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    }
    // center dot
    ctx.fillStyle = '#e2231a';
    ctx.beginPath();
    ctx.arc(cx % W, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Split a [x0,x1] range that may exceed [0,W] into wrapped slices. */
  _wrapSlices(x0, x1, W) {
    const slices = [];
    let a = x0;
    let b = x1;
    if (b - a >= W) return [[0, W]];
    a = ((a % W) + W) % W;
    b = ((b % W) + W) % W;
    if (a <= b) {
      slices.push([a, b]);
    } else {
      slices.push([a, W]);
      slices.push([0, b]);
    }
    return slices;
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
