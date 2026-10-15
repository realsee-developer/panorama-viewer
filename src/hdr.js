/**
 * hdr.js — display HDR capability detection.
 *
 * (The WebGPU HDR *canvas* is handled natively by three.js: the renderer is
 * created with `outputType: HalfFloatType`, which configures the context as
 * rgba16float + "extended" tone mapping — see viewer.js.)
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
