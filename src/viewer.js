/**
 * viewer.js — WebGPU equirectangular panorama renderer + camera controls.
 *
 * Rendering: the panorama is the scene background (equirectangular mapping),
 * drawn per-pixel from the camera ray direction. The camera sits at the
 * origin; dragging rotates the view (yaw/pitch), wheel / pinch changes FOV.
 */

import {
  PerspectiveCamera,
  Scene,
  MathUtils,
  HalfFloatType,
  WebGPURenderer,
} from 'three/webgpu';
// TSL node functions live in the dedicated `three/tsl` entry (three r171+).
import {
  texture as textureNode,
  uniform,
  equirectUV,
  normalWorld,
  vec2,
  vec3,
  vec4,
  float,
  pow,
  mix,
  clamp,
  Fn,
} from 'three/tsl';

const MIN_FOV = 25;
const MAX_FOV = 100;
const LOOK_RADIUS = 100; // arbitrary positive distance for the lookAt target

export class PanoramaViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new Scene();

    this.camera = new PerspectiveCamera(
      75,
      canvas.clientWidth / canvas.clientHeight || 1,
      0.1,
      1100
    );
    this.camera.position.set(0, 0, 0.01);

    // View orientation as yaw (lon) / pitch (lat) in degrees.
    this.lon = 0;
    this.lat = 0;

    // The panorama is rendered as the scene background with equirectangular
    // mapping. three.js's WebGPU renderer has a dedicated, HDR-correct
    // equirectangular background path, which handles large half-float
    // textures reliably (unlike mapping a huge float texture onto a sphere
    // mesh material). FOV zoom still works because the background is drawn
    // per-pixel from the camera ray direction.
    this.scene.background = null;
    this.scene.backgroundIntensity = 1.0;
    this._panoTexture = null;

    this._pointers = new Map();
    this._dragging = false;
    this._last = { x: 0, y: 0 };
    this._pinchDist = 0;
    this._hdrActive = false;

    this.onViewChange = null; // callback(lon, lat, fov)
  }

  async init() {
    if (!navigator.gpu) {
      throw new Error(
        'WebGPU is not supported in this browser. Please use Chrome 113+ / Edge 113+ or a browser with WebGPU enabled.'
      );
    }

    // Render to a half-float (rgba16float) canvas. three.js r171+ natively
    // configures the WebGPU context for HDR when outputType is HalfFloatType:
    // the preferred canvas format becomes rgba16float and the context tone
    // mapping is set to "extended", so values above SDR white (> 1.0) map into
    // the display's HDR headroom. For SDR content (values <= 1.0) this is a
    // no-op, so it's safe to always use it.
    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      outputType: HalfFloatType,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      false
    );

    await this.renderer.init();

    this._bindControls();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.renderer.setAnimationLoop(() => this._render());
    return this;
  }

  /**
   * Report the HDR canvas status. With the renderer created as HalfFloatType,
   * three configures the context as rgba16float + extended tone mapping
   * natively, so there's nothing to reconfigure here — we just surface the
   * state for the UI badge.
   */
  enableHDR() {
    const fmt = this.renderer?.backend?.utils?.getPreferredCanvasFormat?.();
    const ok = fmt === 'rgba16float';
    this._hdrActive = ok;
    return ok
      ? { ok: true, format: 'rgba16float', colorSpace: 'srgb', toneMapping: 'extended' }
      : { ok: false, error: 'HDR canvas not available' };
  }

  /**
   * Set the panorama. Accepts either:
   *   - an SDR `THREE.Texture` (equirectangular), or
   *   - an HDR descriptor `{ sdrTexture, gainTexture, gainMeta }` for both
   *     Ultra HDR JPEGs and .exr/.hdr files (the latter are converted to an
   *     SDR base + gain map in the loader), composited on the GPU so
   *     maxDisplayBoost can be adjusted live.
   */
  setPanorama(input) {
    this._disposePano();

    if (input && input.sdrTexture) {
      this._setHDRPanorama(input);
    } else {
      this._setSDRPanorama(input);
    }
    this.scene.backgroundIntensity = 1.0;
  }

  _setSDRPanorama(texture) {
    this.scene.backgroundNode = null;
    this.scene.background = texture;
    this._panoTexture = texture;
    this._hdrPano = null;
  }

  /**
   * Build a TSL background node that recovers HDR from the SDR base image and
   * the gain map per the Android / ISO 21496-1 formula, driven by a live
   * `maxDisplayBoost` uniform (log2 units):
   *
   *   logRecovery = pow(gain, 1/gamma)
   *   logBoost    = mix(gainMapMin, gainMapMax, logRecovery)
   *   weight      = clamp((log2DisplayBoost - hdrCapMin)/(hdrCapMax - hdrCapMin), 0, 1)
   *   hdr         = (sdrLinear + offsetSDR) * exp2(logBoost*weight) - offsetHDR
   */
  _setHDRPanorama({ sdrTexture, gainTexture, gainMeta }) {
    const m = gainMeta;

    // Live-adjustable: target display boost in log2 units. Default = content's
    // full HDR capacity (full intent). Range is applied by the UI.
    this._boostUniform = uniform(m.hdrCapacityMax);
    this._gainMeta = m;

    const gainMapMin = float(m.gainMapMin);
    const gainMapMax = float(m.gainMapMax);
    const gammaInv = float(1.0 / (m.gamma || 1.0));
    const offsetSDR = float(m.offsetSDR);
    const offsetHDR = float(m.offsetHDR);
    const hdrCapMin = float(m.hdrCapacityMin);
    const hdrCapMax = float(m.hdrCapacityMax);

    const node = Fn(() => {
      // equirectUV(normalWorld) maps the ray direction to equirectangular UV.
      // We sample the textures with this explicit UV, so the textures' own
      // `flipY` flag does NOT apply here — flip V ourselves so the HDR
      // orientation matches the SDR (`scene.background`) path.
      const baseUV = equirectUV(normalWorld);
      const uv = vec2(baseUV.x, float(1.0).sub(baseUV.y));
      // In TSL, texture(tex, uv) performs the sample; the SDR texture is tagged
      // sRGB so three returns it already linearized.
      const sdrLinear = textureNode(sdrTexture, uv).rgb;
      const gain = textureNode(gainTexture, uv).rgb;

      const logRecovery = pow(gain, gammaInv);
      const logBoost = mix(gainMapMin, gainMapMax, logRecovery);

      const denom = hdrCapMax.sub(hdrCapMin).max(float(1e-6));
      const weight = clamp(
        this._boostUniform.sub(hdrCapMin).div(denom),
        float(0.0),
        float(1.0)
      );

      // exp2(x) == pow(2, x)
      const boost = pow(float(2.0), logBoost.mul(weight));
      const hdr = sdrLinear.add(offsetSDR).mul(boost).sub(offsetHDR).max(vec3(0));

      return vec4(hdr, float(1.0));
    })();

    this.scene.background = null;
    this.scene.backgroundNode = node;

    this._hdrPano = { sdrTexture, gainTexture, gainMeta: m };
    this._panoTexture = null;
  }

  /** Live-set the HDR display boost (as a linear multiple of SDR white). */
  setMaxDisplayBoost(linearBoost) {
    if (!this._boostUniform) return;
    const log2 = Math.log2(Math.max(1, linearBoost));
    this._boostUniform.value = log2;
  }

  /** HDR capability info for the currently loaded panorama (or null). */
  getHDRInfo() {
    if (!this._gainMeta) return null;
    return {
      hdrCapacityMaxLinear: Math.pow(2, this._gainMeta.hdrCapacityMax),
      hdrCapacityMinLinear: Math.pow(2, this._gainMeta.hdrCapacityMin),
      gainMeta: this._gainMeta,
    };
  }

  _disposePano() {
    if (this._panoTexture) {
      this._panoTexture.dispose();
      this._panoTexture = null;
    }
    if (this._hdrPano) {
      this._hdrPano.sdrTexture?.dispose();
      this._hdrPano.gainTexture?.dispose();
      this._hdrPano = null;
    }
    this._boostUniform = null;
    this._gainMeta = null;
    this.scene.backgroundNode = null;
    this.scene.background = null;
  }

  /* ---------- camera orientation ---------- */
  setView(lon, lat) {
    this.lon = lon;
    this.lat = MathUtils.clamp(lat, -85, 85);
  }

  getView() {
    return { lon: this.lon, lat: this.lat, fov: this.camera.fov };
  }

  _updateCamera() {
    const phi = MathUtils.degToRad(90 - this.lat);
    const theta = MathUtils.degToRad(this.lon);
    const target = {
      x: LOOK_RADIUS * Math.sin(phi) * Math.cos(theta),
      y: LOOK_RADIUS * Math.cos(phi),
      z: LOOK_RADIUS * Math.sin(phi) * Math.sin(theta),
    };
    this.camera.lookAt(target.x, target.y, target.z);
  }

  /* ---------- input ---------- */
  _bindControls() {
    const el = this.canvas;

    el.addEventListener('pointerdown', (e) => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic / unsupported pointer — ignore */
      }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 1) {
        this._dragging = true;
        this._last = { x: e.clientX, y: e.clientY };
        el.classList.add('grabbing');
      }
    });

    const onMove = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size >= 2) {
        this._handlePinch();
        return;
      }

      if (!this._dragging) return;
      const dx = e.clientX - this._last.x;
      const dy = e.clientY - this._last.y;
      this._last = { x: e.clientX, y: e.clientY };

      // Scale rotation speed by FOV so zoomed-in dragging feels natural.
      const speed = this.camera.fov / 75 / 10;
      this.lon -= dx * speed;
      this.lat += dy * speed;
      this.lat = MathUtils.clamp(this.lat, -85, 85);
    };
    el.addEventListener('pointermove', onMove);
    // Also listen on window so a drag continues even if the pointer briefly
    // leaves the canvas (and to be robust to synthetic test events).
    window.addEventListener('pointermove', onMove);

    const endPointer = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinchDist = 0;
      if (this._pointers.size === 0) {
        this._dragging = false;
        el.classList.remove('grabbing');
      }
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
    window.addEventListener('pointerup', endPointer);

    // Wheel -> FOV zoom.
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this._zoom(e.deltaY * 0.05);
      },
      { passive: false }
    );
  }

  _handlePinch() {
    const pts = [...this._pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (this._pinchDist > 0) {
      const delta = this._pinchDist - dist;
      this._zoom(delta * 0.1);
    }
    this._pinchDist = dist;
  }

  _zoom(delta) {
    this.camera.fov = MathUtils.clamp(
      this.camera.fov + delta,
      MIN_FOV,
      MAX_FOV
    );
    this.camera.updateProjectionMatrix();
  }

  /* ---------- loop ---------- */
  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  _render() {
    this._updateCamera();
    this.renderer.render(this.scene, this.camera);
    if (this.onViewChange) {
      this.onViewChange(this.lon, this.lat, this.camera.fov);
    }
  }

  get hdrActive() {
    return this._hdrActive;
  }
}
