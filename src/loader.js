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
  ClampToEdgeWrapping,
  DataTexture,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  RepeatWrapping,
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

/* ---------- Ultra HDR path ----------
 *
 * three.js's UltraHDRLoader does the gain-map math correctly in
 * `_applyGainmapToSDR`, but its JPEG section scanner mis-parses real-world
 * files that carry an ICC-profile APP2 before the MPF APP2 (e.g. produced by
 * @realsee/hdr-toolbox), reading a bogus MPF offset -> "Invalid typed array
 * length". @monogrid/gainmap-js is not an option here because its decoder
 * relies on WebGLRenderer.readRenderTargetPixels, which WebGPURenderer lacks.
 *
 * So: try the built-in loader first; if it throws, parse the JPEG ourselves
 * (proper APP1/APP2 + MPF handling) to extract the primary + gain-map images
 * and both XMP packets, then reuse the loader's own `_applyGainmapToSDR` to
 * produce the half-float HDR DataTexture.
 */
async function loadUltraHDR(buffer, renderer) {
  try {
    return await loadUltraHDRBuiltin(buffer);
  } catch (builtinErr) {
    // The built-in UltraHDRLoader fails on some valid real-world files
    // (e.g. ICC-APP2-before-MPF layout). This is an expected, handled case —
    // we transparently fall back to our own robust parser.
    console.info(
      '[loader] built-in UltraHDRLoader could not parse this file ' +
        `(${builtinErr.message}); using robust MPF parser.`
    );
    return await loadUltraHDRRobust(buffer);
  }
}

async function loadUltraHDRBuiltin(buffer) {
  const loader = new UltraHDRLoader();
  // HalfFloat keeps HDR headroom; renderer must support it (WebGPU does).

  const { texture, texData } = await new Promise((resolve, reject) => {
    try {
      loader.parse(buffer, (data) => {
        const tex = new DataTexture(data.data, data.width, data.height);
        tex.type = loader.type;
        tex.format = RGBAFormat;
        tex.needsUpdate = true;
        resolve({ texture: tex, texData: data });
      });
    } catch (e) {
      reject(e);
    }
  });

  return finishHDR(texture, texData, buffer, 'three/UltraHDRLoader');
}

/**
 * Robust path: parse JPEG segments correctly, extract primary + gain-map
 * images and XMP, then drive three's `_applyGainmapToSDR` directly.
 */
async function loadUltraHDRRobust(buffer) {
  const parsed = parseUltraHDRJPEG(buffer);
  if (!parsed) {
    throw new Error(
      'THREE.UltraHDRLoader: 无法从该 Ultra HDR 文件中解析出 gain map。'
    );
  }

  const loader = new UltraHDRLoader();

  // Reuse the loader's XMP parser for metadata (populated from the gain-map
  // descriptor XMP, which carries hdrgm:Version etc.).
  const xmpMetadata = {
    version: null,
    baseRenditionIsHDR: null,
    gainMapMin: null,
    gainMapMax: null,
    gamma: null,
    offsetSDR: null,
    offsetHDR: null,
    hdrCapacityMin: null,
    hdrCapacityMax: null,
  };
  for (const xmp of parsed.xmpPackets) {
    loader._parseXMPMetadata(xmp, xmpMetadata);
  }
  if (!xmpMetadata.version) {
    // Some files only expose version in the primary container; default to 1.0
    xmpMetadata.version = '1.0';
  }

  const texData = await new Promise((resolve, reject) => {
    loader._applyGainmapToSDR(
      xmpMetadata,
      parsed.primaryImage,
      parsed.gainmapImage,
      (hdrBuffer, width, height) =>
        resolve({
          data: hdrBuffer,
          width,
          height,
          format: RGBAFormat,
          type: loader.type,
        }),
      (error) => reject(new Error(error))
    );
  });

  const texture = new DataTexture(
    texData.data,
    texData.width,
    texData.height,
    RGBAFormat,
    loader.type
  );
  texture.colorSpace = LinearSRGBColorSpace;
  texture.needsUpdate = true;

  return finishHDR(texture, texData, buffer, 'robust-mpf-parser');
}

/** Common post-processing for both HDR decode paths. */
async function finishHDR(texture, texData, buffer, decoder) {
  const width = texData.width;
  const height = texData.height;
  validateRatio(width, height);

  // Configure for equirectangular background use. HDR data is linear light,
  // so use LinearSRGBColorSpace. Avoid mipmaps on the very large half-float
  // texture (they can fail to generate for float textures in WebGPU and are
  // unnecessary for a full-screen background).
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;

  // Minimap preview: the primary (base) image inside an Ultra HDR JPEG is a
  // valid SDR JPEG, so decode it directly (fast, correct colors). Fall back
  // to tone-mapping the half-float data if that fails.
  let previewBitmap;
  try {
    previewBitmap = await createImageBitmap(new Blob([buffer]));
  } catch {
    previewBitmap = await hdrDataToBitmap(texData);
  }

  return {
    texture,
    format: 'Ultra HDR (JPEG + gain map)',
    width,
    height,
    ratio: width / height,
    isHDR: true,
    letterboxed: width / height > RATIO + 1e-3,
    previewBitmap,
    decoder,
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
