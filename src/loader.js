/**
 * loader.js — Decode dropped files into equirectangular textures.
 *
 * Supported inputs:
 *   - Ultra HDR JPG (gain-map): decoded via three.js UltraHDRLoader to a
 *     half-float HDR DataTexture.
 *   - Plain JPG / PNG / AVIF (SDR): decoded via createImageBitmap.
 *
 * Aspect-ratio policy (equirectangular panoramas are 2:1):
 *   - ratio < 2:1  -> reject (not a panorama / too tall).
 *   - ratio == 2:1 -> use as-is.
 *   - ratio > 2:1  -> too wide/short; letterbox onto a 2:1 canvas (black bars
 *     top & bottom) so the sphere mapping stays correct.
 */

import {
  DataTexture,
  EquirectangularReflectionMapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
} from 'three';
import { UltraHDRLoader } from 'three/examples/jsm/loaders/UltraHDRLoader.js';

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
      `图片宽高比为 ${ratio.toFixed(3)}:1（${width}×${height}），` +
        `全景图要求宽高比 ≥ 2:1。请使用等距圆柱（equirectangular）全景图。`
    );
    this.name = 'AspectRatioError';
    this.ratio = ratio;
  }
}

/**
 * Load and decode a File into a result:
 *   { texture, format, width, height, ratio, isHDR, previewBitmap }
 *
 * `texture` is ready to assign to scene.background with equirectangular mapping.
 * `previewBitmap` is an ImageBitmap (SDR) used for the minimap thumbnail.
 */
export async function loadPanorama(file, renderer) {
  const buffer = await file.arrayBuffer();
  const format = sniffFormat(buffer);
  const hdr = format === 'jpeg' && isUltraHDR(buffer);

  if (hdr) {
    return loadUltraHDR(buffer, renderer);
  }
  return loadSDR(buffer, format);
}

/* ---------- Ultra HDR path ---------- */
async function loadUltraHDR(buffer, renderer) {
  const loader = new UltraHDRLoader();
  // HalfFloat keeps HDR headroom; renderer must support it (WebGPU does).

  const { texture, texData } = await new Promise((resolve, reject) => {
    try {
      loader.parse(buffer, (data) => {
        const tex = new DataTexture(
          data.data,
          data.width,
          data.height
        );
        tex.type = loader.type;
        tex.format = RGBAFormat;
        tex.needsUpdate = true;
        resolve({ texture: tex, texData: data });
      });
    } catch (e) {
      reject(e);
    }
  });

  const width = texData.width;
  const height = texData.height;
  validateRatio(width, height);

  texture.mapping = EquirectangularReflectionMapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = true;
  texture.needsUpdate = true;

  // Build an SDR preview bitmap for the minimap by tone-mapping is overkill;
  // we draw the half-float data to a canvas at reduced size.
  const previewBitmap = await hdrDataToBitmap(texData);

  return {
    texture,
    format: 'Ultra HDR (JPEG + gain map)',
    width,
    height,
    ratio: width / height,
    isHDR: true,
    letterboxed: width / height > RATIO + 1e-3,
    previewBitmap,
  };
}

/* ---------- SDR path (jpg/png/avif) ---------- */
async function loadSDR(buffer, format) {
  const blob = new Blob([buffer]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new Error(
      `无法解码图片（格式：${format}）。该浏览器可能不支持此格式。`
    );
  }

  const width = bitmap.width;
  const height = bitmap.height;
  validateRatio(width, height);

  const ratio = width / height;
  const letterboxed = ratio > RATIO + 1e-3;

  // If wider than 2:1, letterbox onto a 2:1 canvas (black bars top/bottom).
  let sourceBitmap = bitmap;
  if (letterboxed) {
    sourceBitmap = await letterbox(bitmap);
  }

  const texture = new Texture(sourceBitmap);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  return {
    texture,
    format: prettyFormat(format),
    width,
    height,
    ratio,
    isHDR: false,
    letterboxed,
    previewBitmap: bitmap,
  };
}

/* ---------- Helpers ---------- */
function validateRatio(width, height) {
  const ratio = width / height;
  if (ratio < RATIO - 1e-3) {
    throw new AspectRatioError(ratio, width, height);
  }
}

/** Draw a (too-wide) bitmap centered on a 2:1 black canvas. */
async function letterbox(bitmap) {
  const w = bitmap.width;
  const targetH = Math.round(w / RATIO); // taller than source
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, targetH);
  const y = Math.round((targetH - bitmap.height) / 2);
  ctx.drawImage(bitmap, 0, y);
  return createImageBitmap(canvas);
}

/**
 * Convert the HDR half-float DataTexture payload into an SDR ImageBitmap for
 * the minimap. We clamp to [0,1] after a simple exposure so the thumbnail is
 * viewable even on SDR panels. Downscaled for performance.
 */
async function hdrDataToBitmap(texData) {
  const { width, height, data } = texData;
  // Downscale target
  const maxW = 1024;
  const scale = width > maxW ? maxW / width : 1;
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));

  // Read half-float (Uint16) or float32.
  const isHalf = data instanceof Uint16Array;
  const src = data;

  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const si = (sy * width + sx) * 4;
      const di = (y * dw + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = isHalf ? fromHalf(src[si + c]) : src[si + c];
        // Reinhard-ish tone map for preview + gamma to sRGB.
        v = v / (1 + v);
        v = Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2);
        out[di + c] = v * 255;
      }
      out[di + 3] = 255;
    }
  }
  const imgData = new ImageData(out, dw, dh);
  return createImageBitmap(imgData);
}

/** Decode an IEEE 754 half-precision float stored in a Uint16. */
function fromHalf(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  let val;
  if (e === 0) {
    val = (f / 1024) * Math.pow(2, -14);
  } else if (e === 0x1f) {
    val = f ? NaN : Infinity;
  } else {
    val = (1 + f / 1024) * Math.pow(2, e - 15);
  }
  return s ? -val : val;
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
