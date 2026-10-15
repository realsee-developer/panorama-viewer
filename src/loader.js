/**
 * loader.js — Decode dropped files into equirectangular panorama sources.
 *
 * Supported inputs:
 *   - Ultra HDR JPG (gain-map): parsed in-house (MPF + XMP) into an SDR base
 *     + gain-map + metadata, composited to HDR on the GPU in viewer.js (so
 *     maxDisplayBoost is adjustable live).
 *   - Radiance HDR (.hdr) / OpenEXR (.exr): true linear-float equirectangular
 *     panoramas. Decoded to half-float, then converted to an SDR base + gain
 *     map (hdrToGainMap) so they render through the same gain-map path.
 *   - Plain JPG / PNG / AVIF (SDR): decoded via createImageBitmap.
 *
 * Unified pipeline: every format is decoded into PixelBuffer(s), run through a
 * SINGLE letterbox step (letterboxPixelBuffer), then turned into DataTextures.
 *
 * Aspect-ratio policy (equirectangular panoramas are 2:1):
 *   - ratio < 2:1  -> reject (not a panorama / too tall).
 *   - ratio == 2:1 -> use as-is.
 *   - ratio > 2:1  -> too wide/short; letterbox onto a 2:1 buffer (black bars
 *     top & bottom) so the equirectangular mapping stays correct. The same
 *     letterbox runs for SDR, Ultra HDR (base + gain) and EXR/HDR.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

const RATIO = 2; // target width : height

/** Sniff the real format from magic bytes (extension can lie). */
export function sniffFormat(bytes) {
  const b = new Uint8Array(bytes.slice(0, 16));
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'png';
  // AVIF / HEIF: ....ftyp(avif|avis|mif1|heic)
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand.startsWith('avi')) return 'avif';
    return 'heif';
  }
  // OpenEXR: magic number 0x76 0x2F 0x31 0x01 (little-endian 20000630).
  if (b[0] === 0x76 && b[1] === 0x2f && b[2] === 0x31 && b[3] === 0x01)
    return 'exr';
  // Radiance HDR / RGBE: ASCII header starts with "#?RADIANCE" or "#?RGBE".
  if (b[0] === 0x23 && b[1] === 0x3f) {
    const sig = String.fromCharCode(b[2], b[3], b[4], b[5], b[6], b[7]);
    if (sig.startsWith('RADIAN') || sig.startsWith('RGBE')) return 'hdr';
  }
  return 'unknown';
}

/**
 * Detect whether a JPEG carries an Ultra HDR gain map. The gain-map metadata
 * lives in an APP1 XMP packet referencing the GContainer / hdrgm namespace,
 * or an MPF (APP2) multi-picture structure. We scan for the XMP marker.
 */
export function isUltraHDR(bytes) {
  const u8 = new Uint8Array(bytes);
  // Search within the first ~256KB for the gain map XMP signatures.
  const limit = Math.min(u8.length, 262144);
  const needle1 = 'hdrgm:'; // Adobe gain map namespace
  const needle2 = 'GContainer'; // Google container (Ultra HDR)
  const needle3 = 'Item:Semantic="GainMap"';
  const text = latin1(u8, limit);
  return (
    text.includes(needle1) ||
    text.includes(needle2) ||
    text.includes(needle3)
  );
}

function latin1(u8, limit) {
  let s = '';
  const chunk = 8192;
  for (let i = 0; i < limit; i += chunk) {
    s += String.fromCharCode.apply(
      null,
      u8.subarray(i, Math.min(i + chunk, limit))
    );
  }
  return s;
}

export class AspectRatioError extends Error {
  constructor(ratio, width, height) {
    super(
      `Aspect ratio is ${ratio.toFixed(3)}:1 (${width}×${height}). ` +
        `Panoramas require an aspect ratio ≥ 2:1. Please use an equirectangular panorama.`
    );
    this.name = 'AspectRatioError';
    this.ratio = ratio;
  }
}

/* ============================================================================
 * Unified pipeline
 *
 * Every input format is decoded into one or more PixelBuffers (a plain,
 * format-agnostic pixel container), run through a SINGLE letterbox step, and
 * only then turned into GPU textures. This keeps the aspect-ratio handling
 * identical for SDR, Ultra HDR and EXR/HDR instead of three separate code
 * paths.
 *
 *   PixelBuffer = {
 *     data: Uint8ClampedArray | Uint16Array,  // RGBA, row-major, top-origin
 *     width, height,
 *     kind: 'u8' | 'half',                     // 8-bit sRGB codes vs half-float
 *     flipY: boolean,                          // flip vertically on GPU upload
 *                                              // (texture.flipY); it also tells
 *                                              // the preview to read bottom-up
 *   }
 *
 * Flow per format:
 *   SDR        decode -> [pb]            -> letterbox -> DataTexture (sRGB)
 *   Ultra HDR  decode -> [base, gain]    -> letterbox -> 2x DataTexture
 *   EXR/HDR    decode -> [pb(half)]      -> letterbox -> hdrToGainMap -> 2x tex
 * ========================================================================== */

/**
 * Load and decode a File into a panorama source descriptor:
 *   - SDR:  { texture, format, width, height, ratio, isHDR:false, letterboxed, previewBitmap }
 *   - HDR:  { hdr: { sdrTexture, gainTexture, gainMeta }, texture:null, format, ... isHDR:true }
 *
 * For SDR, `texture` is ready to assign to scene.background. For HDR, the
 * `hdr` ingredients are composited on the GPU by the viewer. `previewBitmap`
 * is an SDR ImageBitmap used for the minimap thumbnail.
 */
export async function loadPanorama(file) {
  const buffer = await file.arrayBuffer();
  let format = sniffFormat(buffer);

  // Extension fallback: some valid Radiance files don't begin exactly with the
  // signatures we sniff; trust a .hdr / .exr extension when magic bytes are
  // inconclusive.
  if (format === 'unknown') {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.exr')) format = 'exr';
    else if (name.endsWith('.hdr')) format = 'hdr';
  }

  if (format === 'exr' || format === 'hdr') {
    return loadFloatHDR(buffer, format);
  }
  if (format === 'jpeg' && isUltraHDR(buffer)) {
    return loadUltraHDR(buffer);
  }
  return loadSDR(buffer, format);
}

/* ---------- PixelBuffer core ---------- */

/**
 * Letterbox a PixelBuffer onto a 2:1 canvas: center it vertically with opaque
 * black bars top & bottom. Works identically for 8-bit and half-float buffers
 * — only the array type and the "alpha = 1.0" constant differ. Rows are copied
 * whole (nearest-neighbour vertically; no resampling), so content is never
 * blurred or stretched. If the buffer is already ≤ 2:1 it's returned as-is.
 */
function letterboxPixelBuffer(pb) {
  if (pb.width / pb.height <= RATIO + 1e-3) return pb;

  const dstW = pb.width;
  const dstH = Math.round(pb.width / RATIO); // taller than source
  const Ctor = pb.data.constructor; // Uint8ClampedArray | Uint16Array
  const dst = new Ctor(dstW * dstH * 4); // zero-filled = black

  // Opaque bars: set alpha to 1.0 everywhere (half-float 1.0 == 0x3c00).
  const alphaOne = pb.kind === 'half' ? 0x3c00 : 255;
  for (let i = 3; i < dst.length; i += 4) dst[i] = alphaOne;

  const yOff = Math.round((dstH - pb.height) / 2);
  const rowLen = pb.width * 4;
  for (let dy = 0; dy < pb.height; dy++) {
    const ty = dy + yOff;
    if (ty < 0 || ty >= dstH) continue;
    dst.set(pb.data.subarray(dy * rowLen, dy * rowLen + rowLen), ty * dstW * 4);
  }

  return { data: dst, width: dstW, height: dstH, kind: pb.kind, flipY: pb.flipY };
}

/** Build a DataTexture from an 8-bit sRGB PixelBuffer. */
function textureFromU8(pb, colorSpace) {
  const tex = new DataTexture(pb.data, pb.width, pb.height, RGBAFormat);
  tex.colorSpace = colorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = pb.flipY;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Downsample any PixelBuffer to an SDR ImageBitmap for the minimap thumbnail.
 * `tone(r,g,b) -> [r,g,b]` maps source pixels (linear-ish) into display [0,1];
 * for 8-bit sRGB buffers it's identity (values already display-ready).
 */
async function pixelBufferToPreview(pb, tone) {
  const maxW = 1024;
  const outW = Math.min(maxW, pb.width);
  const outH = Math.max(1, Math.round(outW * (pb.height / pb.width)));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(outW, outH);
  const out = img.data;
  const isHalf = pb.kind === 'half';
  const read = isHalf ? (v) => DataUtils.fromHalfFloat(v) : (v) => v;

  for (let y = 0; y < outH; y++) {
    const sy = Math.min(pb.height - 1, Math.floor((y / outH) * pb.height));
    const readY = pb.flipY ? pb.height - 1 - sy : sy;
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(pb.width - 1, Math.floor((x / outW) * pb.width));
      const si = (readY * pb.width + sx) * 4;
      const di = (y * outW + x) * 4;
      let r = read(pb.data[si]);
      let g = read(pb.data[si + 1]);
      let b = read(pb.data[si + 2]);
      if (tone) [r, g, b] = tone(r, g, b);
      out[di] = isHalf ? Math.round(255 * clamp01(r)) : r;
      out[di + 1] = isHalf ? Math.round(255 * clamp01(g)) : g;
      out[di + 2] = isHalf ? Math.round(255 * clamp01(b)) : b;
      out[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return createImageBitmap(canvas);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Decode an ImageBitmap into an 8-bit RGBA PixelBuffer. The canvas gives
 * top-origin rows — the same pixel order `new Texture(bitmap)` used to upload —
 * so we tag `flipY: true` to reproduce the previous (correct) orientation on
 * upload for both the SDR background path and the gain-map node.
 */
function bitmapToPixelBuffer(bitmap) {
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h); // Uint8ClampedArray
  return { data, width: w, height: h, kind: 'u8', flipY: true };
}

/* ---------- Float HDR path (.exr / .hdr) ----------
 *
 * Radiance (.hdr) and OpenEXR (.exr) store true, absolute, linear HDR radiance
 * per pixel. We decode to a half-float PixelBuffer, letterbox it (unified
 * step), then convert to an SDR base + gain map so it renders through the exact
 * same gain-map path as Ultra HDR JPEGs.
 */
async function loadFloatHDR(buffer, format) {
  const loader =
    format === 'exr'
      ? new EXRLoader().setDataType(HalfFloatType)
      : new HDRLoader().setDataType(HalfFloatType);

  // Both loaders extend DataTextureLoader; createDataTexture(buffer) parses an
  // in-memory ArrayBuffer and returns a fully configured DataTexture.
  let texture;
  try {
    texture = loader.createDataTexture(buffer);
  } catch (e) {
    throw new Error(
      `Could not decode ${format.toUpperCase()} file: ${e.message || e}`
    );
  }

  validateRatio(texture.image.width, texture.image.height);
  const ratio = texture.image.width / texture.image.height;
  const letterboxed = ratio > RATIO + 1e-3;

  // Decoded half-float data -> PixelBuffer -> unified letterbox.
  let pb = {
    data: texture.image.data, // Uint16Array half-float, RGBA
    width: texture.image.width,
    height: texture.image.height,
    kind: 'half',
    flipY: texture.flipY,
  };
  texture.dispose?.(); // free the decoded GPU texture; we keep the pixels
  pb = letterboxPixelBuffer(pb);

  // Convert the (letterboxed) linear HDR into an SDR base + gain map.
  const { sdrTexture, gainTexture, gainMeta, previewBitmap } =
    await hdrToGainMap(pb);

  return {
    hdr: { sdrTexture, gainTexture, gainMeta },
    texture: null,
    format: format === 'exr' ? 'OpenEXR → gain map' : 'Radiance HDR → gain map',
    width: pb.width,
    height: pb.height,
    ratio: pb.width / pb.height,
    isHDR: true,
    hdrKind: 'gainmap',
    letterboxed,
    previewBitmap,
  };
}

/**
 * Convert a linear-light half-float HDR texture into an Ultra HDR style
 * SDR base + gain map, returning ready-to-render DataTextures plus the
 * gain-map metadata expected by the viewer's `_setHDRPanorama`.
 *
 * Port of @realsee/hdr-toolbox `linearHdrToUltraHdr` (convert.ts), minus the
 * JPEG round-trip: we build the SDR as 8-bit sRGB codes and derive the gain
 * map from those quantized codes (so recovery stays consistent), but keep the
 * data as GPU textures instead of encoding to JPEG.
 *
 *   y      = luminance(rgb);  ySdr = y/(1+y)             (Reinhard by luma)
 *   scale  = ySdr / y                                     (chroma-preserving)
 *   code   = round(linearToSrgb(min(1, hdr*scale)) * 255) (8-bit SDR)
 *   ratio  = (hdr + offset) / (srgbToLinear(code) + offset)
 *   gain   = round(min(1, log2(max(1,ratio)) / log2(maxContentBoost)) * 255)
 *
 * @param {{data:Uint16Array,width,height,kind:'half',flipY}} pb half-float PixelBuffer
 */
async function hdrToGainMap(pb) {
  const w = pb.width;
  const h = pb.height;
  const src = pb.data; // Uint16Array half-float, RGBA
  const flipY = pb.flipY;

  const toLin = (hf) => DataUtils.fromHalfFloat(hf);
  const OFFSET = 1 / 64; // 0.015625, matches convert.ts

  // Peak linear value -> content boost headroom (clamped to 2^14 like toolbox).
  let peak = 1;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const r = toLin(src[o]);
    const g = toLin(src[o + 1]);
    const b = toLin(src[o + 2]);
    if (r > peak) peak = r;
    if (g > peak) peak = g;
    if (b > peak) peak = b;
  }
  const maxContentBoost = Math.max(1.0001, Math.min(peak, Math.pow(2, 14)));
  const logMax = Math.log2(maxContentBoost);

  // Output buffers: RGBA8 for both (alpha = 255). SDR holds sRGB codes; gain
  // holds normalized log-ratio codes.
  const sdrData = new Uint8Array(w * h * 4);
  const gainData = new Uint8Array(w * h * 4);

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const r = Math.max(0, toLin(src[o]));
    const g = Math.max(0, toLin(src[o + 1]));
    const b = Math.max(0, toLin(src[o + 2]));

    // Reinhard driven by luminance; scale chroma by the same factor so hue /
    // saturation survive tone mapping.
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const ySdr = y / (1 + y);
    const scale = y > 1e-6 ? ySdr / y : 0;

    const rgb = [r, g, b];
    for (let c = 0; c < 3; c++) {
      const hdr = rgb[c];
      const code = Math.round(
        linearToSrgb(Math.min(1, hdr * scale)) * 255
      );
      sdrData[o + c] = code;

      const sdrLinear = srgbToLinear(code / 255);
      const ratio = (hdr + OFFSET) / (sdrLinear + OFFSET);
      const logBoost = Math.log2(Math.max(1, ratio));
      const normalized = logMax > 0 ? Math.min(1, logBoost / logMax) : 0;
      gainData[o + c] = Math.round(normalized * 255);
    }
    sdrData[o + 3] = 255;
    gainData[o + 3] = 255;
  }

  const sdrPb = { data: sdrData, width: w, height: h, kind: 'u8', flipY };
  const gainPb = { data: gainData, width: w, height: h, kind: 'u8', flipY };

  const sdrTexture = textureFromU8(sdrPb, SRGBColorSpace);
  // Gain map is stored non-color (a multiplier map); keep it linear.
  const gainTexture = textureFromU8(gainPb, LinearSRGBColorSpace);

  // gainMeta in the viewer's expected shape. convert.ts config is in LINEAR
  // space; the viewer reads gainMapMin/Max and hdrCapacityMin/Max in LOG2
  // space (see parseGainMapMetadata), so convert here.
  const gainMeta = {
    gainMapMin: 0, // log2(minContentBoost=1)
    gainMapMax: logMax, // log2(maxContentBoost)
    gamma: 1,
    offsetSDR: OFFSET,
    offsetHDR: OFFSET,
    hdrCapacityMin: 0, // log2(1)
    hdrCapacityMax: logMax, // log2(maxContentBoost)
    baseRenditionIsHDR: false,
  };

  // Minimap preview = the SDR base (already display-ready 8-bit sRGB).
  const previewBitmap = await pixelBufferToPreview(sdrPb, null);

  return { sdrTexture, gainTexture, gainMeta, previewBitmap };
}

/** Decode an 8-bit sRGB value (0-1) to linear light. */
function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Encode linear light (0-1) to an 8-bit sRGB value (0-1). */
function linearToSrgb(v) {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/* ---------- Ultra HDR path ----------
 *
 * We decode Ultra HDR (gain-map JPEG) ourselves rather than via three's
 * UltraHDRLoader, for two reasons:
 *
 *  1. UltraHDRLoader's JPEG section scanner mis-parses real-world files that
 *     carry an ICC-profile APP2 before the MPF APP2 (e.g. @realsee/hdr-toolbox
 *     output), reading a bogus MPF offset -> "Invalid typed array length".
 *
 *  2. More importantly, UltraHDRLoader._applyGainmapToSDR hardcodes the target
 *     display boost to sqrt(1.8 ^ hdrCapacityMax), pinning it to about half the
 *     content's HDR capacity. That under-applies the gain map and yields a
 *     washed-out, low-contrast result. We instead implement the Android /
 *     ISO 21496-1 recovery with a configurable display boost (default: the
 *     content's full HDR capacity) so highlights reach their intended level.
 *
 * (@monogrid/gainmap-js is also unusable here: its decoder relies on
 *  WebGLRenderer.readRenderTargetPixels, which WebGPURenderer does not have.)
 */
async function loadUltraHDR(buffer) {
  return loadUltraHDRRobust(buffer);
}

/**
 * Robust path: parse JPEG segments correctly, extract primary + gain-map
 * images and XMP, then apply the gain map ourselves.
 *
 * We deliberately do NOT use three's `_applyGainmapToSDR`: it hardcodes
 *   maxDisplayBoost = sqrt(1.8 ^ hdrCapacityMax)
 * which pins the display boost to roughly half the content's HDR capacity, so
 * the recovered HDR is heavily under-boosted (washed out, low contrast). We
 * instead follow the Android / ISO 21496-1 recovery formula with a
 * configurable target display boost that defaults to the content's *full* HDR
 * capacity (2 ^ hdrCapacityMax), i.e. render the full HDR intent.
 */
async function loadUltraHDRRobust(buffer) {
  const parsed = parseUltraHDRJPEG(buffer);
  if (!parsed) {
    throw new Error(
      'Ultra HDR: could not parse a gain map from this file (missing MPF/XMP).'
    );
  }

  const gainMeta = parseGainMapMetadata(parsed.xmpPackets);

  // Decode base + gain JPEGs to ImageBitmaps, then to PixelBuffers so they go
  // through the same unified letterbox as every other format. (The gain map is
  // often lower-resolution; it's letterboxed independently but with the same
  // 2:1 target, so the content region stays aligned with the base.)
  const [sdrBitmap, gainBitmap] = await Promise.all([
    createImageBitmap(new Blob([parsed.primaryImage])),
    createImageBitmap(new Blob([parsed.gainmapImage])),
  ]);

  const width = sdrBitmap.width;
  const height = sdrBitmap.height;
  validateRatio(width, height);
  const letterboxed = width / height > RATIO + 1e-3;

  const sdrPb = letterboxPixelBuffer(bitmapToPixelBuffer(sdrBitmap));
  const gainPb = letterboxPixelBuffer(bitmapToPixelBuffer(gainBitmap));

  const sdrTexture = textureFromU8(sdrPb, SRGBColorSpace);
  // Gain map is stored non-color (a multiplier map); keep it linear.
  const gainTexture = textureFromU8(gainPb, LinearSRGBColorSpace);

  // Minimap preview: the (letterboxed) SDR base.
  const previewBitmap = await pixelBufferToPreview(sdrPb, null);

  return {
    // HDR panoramas provide the ingredients for GPU compositing instead of a
    // single baked texture.
    hdr: {
      sdrTexture,
      gainTexture,
      gainMeta,
    },
    texture: null,
    format: 'Ultra HDR (JPEG + gain map)',
    width: sdrPb.width,
    height: sdrPb.height,
    ratio: sdrPb.width / sdrPb.height,
    isHDR: true,
    letterboxed,
    previewBitmap,
    decoder: 'robust-gainmap-gpu',
  };
}

/**
 * Parse an Ultra HDR JPEG into { primaryImage, gainmapImage, xmpPackets }.
 *
 * Walks JPEG marker segments properly (honoring each segment's length), reads
 * the MPF (APP2 "MPF\0") Multi-Picture Format directory to locate the primary
 * and gain-map sub-images, and collects all APP1 XMP packets.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{primaryImage:Uint8Array, gainmapImage:Uint8Array, xmpPackets:string[]}|null}
 */
function parseUltraHDRJPEG(buffer) {
  const data = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const len = data.byteLength;
  if (data.getUint16(0) !== 0xffd8) return null; // not a JPEG

  const xmpPackets = [];
  let mpf = null; // { offset: byteOffset of MPF payload start }

  let i = 2;
  while (i < len - 1) {
    if (data.getUint8(i) !== 0xff) {
      i++;
      continue;
    }
    const marker = data.getUint8(i + 1);
    // Standalone markers without length.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    if (marker === 0xda) break; // SOS: start of scan, stop scanning headers.
    if (marker === 0xff) {
      i++;
      continue;
    }
    const segLen = data.getUint16(i + 2);
    const payloadStart = i + 4;
    const payloadEnd = i + 2 + segLen;

    if (marker === 0xe1) {
      // APP1 — could be XMP (identifier "http://ns.adobe.com/xap/1.0/\0").
      const text = latin1(u8.subarray(payloadStart, payloadEnd), payloadEnd - payloadStart);
      const xmlStart = text.indexOf('<x:xmpmeta');
      const altStart = text.indexOf('<?xpacket');
      const start = xmlStart >= 0 ? xmlStart : altStart;
      if (start >= 0) xmpPackets.push(text.substring(start));
    } else if (marker === 0xe2) {
      // APP2 — MPF segment starts with "MPF\0".
      if (
        data.getUint8(payloadStart) === 0x4d && // M
        data.getUint8(payloadStart + 1) === 0x50 && // P
        data.getUint8(payloadStart + 2) === 0x46 && // F
        data.getUint8(payloadStart + 3) === 0x00
      ) {
        mpf = { tiffStart: payloadStart + 4 };
      }
    }
    i = payloadEnd;
  }

  if (!mpf) return null;

  const images = parseMPF(data, mpf.tiffStart);
  if (!images || images.length < 2) return null;

  // Image 0 is the primary; image 1 is the gain map. MPF offsets for the
  // primary are relative to 0; for others relative to the MPF TIFF header
  // start (per the MPF spec, "individual image data offset" is from the
  // beginning of the APP2 field's TIFF header).
  const primary = images[0];
  const gain = images[1];

  const primaryImage = u8.subarray(
    primary.offset === 0 ? 0 : primary.offset,
    (primary.offset === 0 ? 0 : primary.offset) + primary.size
  );
  const gainmapImage = u8.subarray(gain.offset, gain.offset + gain.size);

  // The gain-map *descriptor* metadata (hdrgm:GainMapMax, Gamma, HDRCapacity…)
  // lives in the gain-map sub-image's own APP1 XMP, not in the outer file.
  // The outer scan above stops at the first SOS and never reaches it, so pull
  // it from the gain-map image explicitly.
  const gainXmp = extractFirstXMP(gainmapImage);
  if (gainXmp) xmpPackets.push(gainXmp);

  return { primaryImage, gainmapImage, xmpPackets };
}

/** Find the first <x:xmpmeta>…</x:xmpmeta> packet within a JPEG byte range. */
function extractFirstXMP(bytes) {
  // Scan the first 128KB (XMP lives in early APP1 segments).
  const limit = Math.min(bytes.length, 131072);
  const text = latin1(bytes, limit);
  const start = text.indexOf('<x:xmpmeta');
  if (start < 0) return null;
  const end = text.indexOf('</x:xmpmeta>', start);
  if (end < 0) return text.substring(start);
  return text.substring(start, end + '</x:xmpmeta>'.length);
}

/**
 * Parse the MPF (Multi-Picture Format) TIFF-structured directory.
 * Returns array of { size, offset } for each image.
 */
function parseMPF(data, tiffStart) {
  // Byte order: "II" (0x4949) little-endian or "MM" (0x4d4d) big-endian.
  const bo = data.getUint16(tiffStart);
  const le = bo === 0x4949;
  const u16 = (o) => data.getUint16(o, le);
  const u32 = (o) => data.getUint32(o, le);

  // 0x002A at tiffStart+2, then offset to first IFD at tiffStart+4.
  const ifdOffset = u32(tiffStart + 4);
  const ifdStart = tiffStart + ifdOffset;
  const count = u16(ifdStart);

  let mpEntryOffset = null;
  let numberOfImages = 0;
  for (let e = 0; e < count; e++) {
    const entry = ifdStart + 2 + e * 12;
    const tag = u16(entry);
    if (tag === 0xb001) {
      // Number of Images
      numberOfImages = u32(entry + 8);
    } else if (tag === 0xb002) {
      // MP Entry — value is an offset (relative to TIFF header) to the list.
      mpEntryOffset = tiffStart + u32(entry + 8);
    }
  }
  if (mpEntryOffset == null || numberOfImages === 0) return null;

  const images = [];
  for (let n = 0; n < numberOfImages; n++) {
    const base = mpEntryOffset + n * 16;
    // bytes: 4 (attr) | 4 (size) | 4 (offset) | 2 (dep1) | 2 (dep2)
    const size = u32(base + 4);
    let offset = u32(base + 8);
    // Offsets are relative to the TIFF header start, except the first image
    // (the primary) whose offset is 0 and means the start of the file.
    if (offset !== 0) offset += tiffStart;
    images.push({ size, offset });
  }
  return images;
}

/* ---------- Gain-map metadata (Android / ISO 21496-1) ---------- */

/** Read gain-map descriptor fields from the collected XMP packets. */
function parseGainMapMetadata(xmpPackets) {
  const get = (attr) => {
    for (const xmp of xmpPackets) {
      // Match hdrgm:Attr="..." (namespace prefix may vary but hdrgm is standard).
      const m = xmp.match(
        new RegExp(`hdrgm:${attr}\\s*=\\s*"([^"]*)"`, 'i')
      );
      if (m) return m[1];
    }
    return null;
  };
  const num = (attr, dflt) => {
    const v = get(attr);
    if (v == null) return dflt;
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : dflt;
  };
  const bool = (attr) => {
    const v = get(attr);
    return v != null && /^true$/i.test(v);
  };

  // Defaults per the Android HDR gain-map spec.
  return {
    gainMapMin: num('GainMapMin', 0.0), // log2 space
    gainMapMax: num('GainMapMax', 1.0), // log2 space
    gamma: num('Gamma', 1.0),
    offsetSDR: num('OffsetSDR', 1 / 64),
    offsetHDR: num('OffsetHDR', 1 / 64),
    hdrCapacityMin: num('HDRCapacityMin', 0.0), // log2 space
    hdrCapacityMax: num('HDRCapacityMax', 1.0), // log2 space
    baseRenditionIsHDR: bool('BaseRenditionIsHDR'),
  };
}

/* ---------- SDR path (jpg/png/avif) ---------- */
async function loadSDR(buffer, format) {
  const blob = new Blob([buffer]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(
      `Could not decode image (format: ${format}). This browser may not support it.`
    );
  }

  validateRatio(bitmap.width, bitmap.height);
  const letterboxed = bitmap.width / bitmap.height > RATIO + 1e-3;

  // Decode to a PixelBuffer -> unified letterbox -> DataTexture (sRGB). Note:
  // DataTexture doesn't carry auto-generated mipmaps, so SDR panoramas rely on
  // bilinear filtering only (acceptable; keeps every format on one code path).
  const pb = letterboxPixelBuffer(bitmapToPixelBuffer(bitmap));
  const texture = textureFromU8(pb, SRGBColorSpace);
  texture.mapping = EquirectangularReflectionMapping;

  const previewBitmap = await pixelBufferToPreview(pb, null);

  return {
    texture,
    format: prettyFormat(format),
    width: pb.width,
    height: pb.height,
    ratio: pb.width / pb.height,
    isHDR: false,
    letterboxed,
    previewBitmap,
  };
}

/* ---------- Helpers ---------- */
function validateRatio(width, height) {
  const ratio = width / height;
  if (ratio < RATIO - 1e-3) {
    throw new AspectRatioError(ratio, width, height);
  }
}

function prettyFormat(fmt) {
  switch (fmt) {
    case 'jpeg':
      return 'JPEG (SDR)';
    case 'png':
      return 'PNG';
    case 'avif':
      return 'AVIF';
    case 'heif':
      return 'HEIF';
    default:
      return fmt.toUpperCase();
  }
}
