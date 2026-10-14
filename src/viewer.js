/**
 * viewer.js — WebGPU equirectangular panorama renderer + camera controls.
 *
 * Rendering: the panorama is the scene background (equirectangular mapping),
 * drawn per-pixel from the camera ray direction. The camera sits at the
 * origin; dragging rotates the view (yaw/pitch), wheel / pinch changes FOV.
 */

import { PerspectiveCamera, Scene, MathUtils } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { configureContextHDR } from './hdr.js';

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
        '当前浏览器不支持 WebGPU。请使用 Chrome 113+ / Edge 113+ 或开启 WebGPU 的浏览器。'
      );
    }

    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
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
   * Attempt to switch the WebGPU canvas to HDR output. Must be called after
   * init() (context exists). Returns the HDR config result.
   *
   * Reconfiguring the swapchain to rgba16float is not enough on its own:
   * three.js's WebGPU backend allocates its internal color buffer and picks
   * its render-pass color format from `utils.getPreferredCanvasFormat()`,
   * which returns the 8-bit preferred format (e.g. bgra8unorm). That causes a
   * format mismatch at MSAA-resolve / present time ("resolve target format
   * (RGBA16Float) does not match the color attachment format (BGRA8Unorm)"),
   * invalidating every frame's command buffer -> black screen.
   *
   * So we also override `getPreferredCanvasFormat` to report rgba16float and
   * force the backend to rebuild its framebuffer textures.
   */
  enableHDR() {
    try {
      const backend = this.renderer.backend;
      const context = backend?.context;
      const device = backend?.device;
      const utils = backend?.utils;
      if (!context || !device || !utils) {
        return { ok: false, error: 'WebGPU context 未就绪' };
      }

      const result = configureContextHDR(context, device, false);
      if (!result.ok) {
        this._hdrActive = false;
        return result;
      }

      // Make three.js render its internal buffers in the same HDR format as
      // the reconfigured swapchain.
      if (!this._origGetPreferredCanvasFormat) {
        this._origGetPreferredCanvasFormat =
          utils.getPreferredCanvasFormat.bind(utils);
      }
      utils.getPreferredCanvasFormat = () => 'rgba16float';

      // Force the backend to recreate its color/depth framebuffer textures
      // with the new format. Nudging the size triggers reallocation.
      this._forceFramebufferRebuild();

      this._hdrActive = true;
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Force three's WebGPU backend to rebuild framebuffer textures. */
  _forceFramebufferRebuild() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    // Toggle size so the backend's cached framebuffer is invalidated and
    // recreated with the (now HDR) preferred canvas format.
    this.renderer.setSize(Math.max(1, w - 1), Math.max(1, h - 1), false);
    this.renderer.setSize(w, h, false);
  }

  setPanorama(texture) {
    // Dispose any previously loaded panorama.
    if (this._panoTexture && this._panoTexture !== texture) {
      this._panoTexture.dispose();
    }
    this._panoTexture = texture;
    this.scene.background = texture;
    // backgroundIntensity scales the environment; keep 1 so HDR values pass
    // through unchanged for the extended tone mapping on the HDR canvas.
    this.scene.backgroundIntensity = 1.0;
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
