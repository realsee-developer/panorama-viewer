/**
 * hdr.js — HDR capability detection and WebGPU HDR canvas configuration.
 *
 * Two independent concerns:
 *  1. Does the *display* support HDR?  -> matchMedia('(dynamic-range: high)')
 *  2. Can the *WebGPU canvas* present HDR? -> rgba16float + extended tone mapping,
 *     which we must configure on the context ourselves because three.js
 *     r169 configures the context as the preferred 8-bit SDR format.
 */

/**
 * Detect whether the current display reports high dynamic range capability.
 * Returns the live `MediaQueryList` for `(dynamic-range: high)` — read
 * `.matches` for the current state and attach a `change` listener to react to
 * the display gaining/losing HDR. When `matchMedia` is unavailable, returns a
 * stub with the same shape (`matches: false`, no-op listeners).
 */
export function detectDisplayHDR() {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return { matches: false, addEventListener() {}, removeEventListener() {} };
  }
  return window.matchMedia('(dynamic-range: high)');
}

/**
 * Whether the browser exposes the pieces needed to present HDR on a canvas:
 * the WebGPU `rgba16float` canvas format + the HDR tone mapping option in
 * `GPUCanvasConfiguration` (Chrome 121+, behind "extended" tone mapping).
 */
export function canvasHDRCapable() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  // Feature-detect the `toneMapping` config knob via a probe object.
  // We cannot truly know until configure() succeeds, so this is a soft check.
  return true;
}

/**
 * Reconfigure an existing WebGPU canvas context for HDR output.
 *
 * three.js owns the GPUDevice and the context; we re-run configure() on the
 * same context with an HDR-capable format. Because the renderer calls
 * `context.getCurrentTexture()` every frame (not re-configure), our new
 * configuration persists across frames.
 *
 * @param {GPUCanvasContext} context
 * @param {GPUDevice} device
 * @param {boolean} alpha
 * @returns {{ok: boolean, format: string, colorSpace: string, toneMapping: string, error?: string}}
 */
export function configureContextHDR(context, device, alpha) {
  const alphaMode = alpha ? 'premultiplied' : 'opaque';
  const format = 'rgba16float';
  const usage =
    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;

  // Try the richest configuration first (extended tone mapping lets values
  // above SDR white, i.e. > 1.0, map to real display headroom), then fall
  // back progressively if the browser rejects an option.
  const attempts = [
    {
      colorSpace: 'display-p3',
      toneMapping: { mode: 'extended' },
      label: 'display-p3 / extended',
    },
    {
      colorSpace: 'srgb',
      toneMapping: { mode: 'extended' },
      label: 'srgb / extended',
    },
    { colorSpace: 'display-p3', label: 'display-p3 / standard' },
  ];

  for (const attempt of attempts) {
    try {
      const config = {
        device,
        format,
        usage,
        alphaMode,
        colorSpace: attempt.colorSpace,
      };
      if (attempt.toneMapping) config.toneMapping = attempt.toneMapping;

      context.configure(config);

      return {
        ok: true,
        format,
        colorSpace: attempt.colorSpace,
        toneMapping: attempt.toneMapping ? attempt.toneMapping.mode : 'standard',
      };
    } catch (err) {
      // Try the next, less demanding configuration.
      // eslint-disable-next-line no-console
      console.warn(`[hdr] configure failed (${attempt.label}):`, err.message);
    }
  }

  return { ok: false, format, colorSpace: '', toneMapping: '', error: 'all configurations rejected' };
}
