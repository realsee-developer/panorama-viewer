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
  EquirectangularReflectionMapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from 'three';

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
async function loadUltraHDR(buffer /*, renderer */) {
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
      'Ultra HDR: 无法从该文件中解析出 gain map（MPF/XMP 缺失）。'
    );
  }

  const gainMeta = parseGainMapMetadata(parsed.xmpPackets);

  // Decode the SDR base image and the gain map as ImageBitmaps and upload them
  // as plain textures. The HDR recovery is done on the GPU in a background
  // node (see viewer.js), so the user can adjust maxDisplayBoost live without
  // re-decoding. (The gain map is often lower-resolution; the GPU samples it
  // with bilinear filtering, matching the spec's "scale to SDR resolution".)
  const [sdrBitmap, gainBitmap] = await Promise.all([
    createImageBitmap(new Blob([parsed.primaryImage])),
    createImageBitmap(new Blob([parsed.gainmapImage])),
  ]);

  const width = sdrBitmap.width;
  const height = sdrBitmap.height;
  validateRatio(width, height);

  const sdrTexture = new Texture(sdrBitmap);
  sdrTexture.colorSpace = SRGBColorSpace;
  sdrTexture.wrapS = RepeatWrapping;
  sdrTexture.wrapT = ClampToEdgeWrapping;
  sdrTexture.minFilter = LinearFilter;
  sdrTexture.magFilter = LinearFilter;
  sdrTexture.generateMipmaps = false;
  sdrTexture.flipY = true;
  sdrTexture.needsUpdate = true;

  const gainTexture = new Texture(gainBitmap);
  // Gain map is stored non-color (it's a multiplier map), keep it linear-ish;
  // we read raw channel values in the shader.
  gainTexture.colorSpace = LinearSRGBColorSpace;
  gainTexture.wrapS = RepeatWrapping;
  gainTexture.wrapT = ClampToEdgeWrapping;
  gainTexture.minFilter = LinearFilter;
  gainTexture.magFilter = LinearFilter;
  gainTexture.generateMipmaps = false;
  gainTexture.flipY = true;
  gainTexture.needsUpdate = true;

  // Minimap preview: the SDR base image.
  const previewBitmap = await createImageBitmap(new Blob([parsed.primaryImage]));

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
    width,
    height,
    ratio: width / height,
    isHDR: true,
    letterboxed: width / height > RATIO + 1e-3,
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
