/**
 * color.js — HDR transfer functions and colour-gamut conversion.
 *
 * Used by the AVIF path to turn >8-bit AVIF code values (PQ/HLG, BT.2020) into
 * the scene-linear, sRGB-primary half-float the loader's gain-map builder
 * (hdrToGainMap) expects. SDR sRGB content doesn't need any of this.
 *
 * CICP transfer characteristics we handle (ITU-T H.273):
 *   1 / 6 / 13 / 14 / 15  — BT.709 / BT.601 / sRGB / BT.2020 (≈ gamma 2.2/2.4)
 *   16                    — SMPTE ST 2084 (PQ), absolute luminance
 *   18                    — ARIB STD-B67 (HLG), scene-referred + BT.2100 OOTF
 *
 * CICP colour primaries:
 *   1   — BT.709 / sRGB
 *   9   — BT.2020
 */

/** SDR white level in nits used to normalise absolute-luminance PQ (BT.2408). */
const PQ_REFERENCE_WHITE_NITS = 203;

/* ---------- PQ (SMPTE ST 2084) ---------- */
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

/** PQ EOTF: normalized code [0,1] -> display luminance in nits [0,10000]. */
function pqToNits(e) {
  const ep = Math.pow(Math.max(e, 0), 1 / PQ_M2);
  const num = Math.max(ep - PQ_C1, 0);
  const den = PQ_C2 - PQ_C3 * ep;
  return 10000 * Math.pow(den > 0 ? num / den : 0, 1 / PQ_M1);
}

/* ---------- HLG (ARIB STD-B67 / BT.2100) ---------- */
const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A; // 0.28466892
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A); // 0.55991073

/** HLG inverse OETF: signal [0,1] -> scene-linear [0,1] (per channel). */
function hlgToScene(x) {
  if (x <= 0.5) return (x * x) / 3;
  return (Math.exp((x - HLG_C) / HLG_A) + HLG_B) / 12;
}

/* ---------- sRGB / gamma transfer ---------- */
function srgbToLinearChannel(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/* ---------- Gamut matrices (linear, D65) ---------- */
// Linear BT.2020 -> linear sRGB (Rec.709) primaries, D65 white, no CAT needed.
const BT2020_TO_SRGB = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];

/** HLG nominal display peak (nits) and system gamma for the BT.2100 OOTF. */
const HLG_PEAK_NITS = 1000;
const HLG_SYSTEM_GAMMA = 1.2;

/**
 * Per-channel decode function: normalized code [0,1] -> linear value in the
 * file's own primaries, scaled so SDR diffuse white = 1.0.
 *
 * - PQ (16): absolute nits / 203 (BT.2408 reference white).
 * - HLG (18): scene-linear in [0,1] only. The display-referred scaling needs
 *   the pixel's luminance (BT.2100 OOTF), so it is applied per pixel in
 *   hdrCodesToLinearHalf, not here.
 * - everything else: sRGB-ish EOTF (BT.709/601/2020 OETFs are close enough).
 */
function transferDecoder(transfer) {
  switch (transfer) {
    case 16:
      return (e) => pqToNits(e) / PQ_REFERENCE_WHITE_NITS;
    case 18:
      return hlgToScene;
    default:
      return srgbToLinearChannel;
  }
}

/**
 * Lookup table with one entry per integer code value. A 10-bit image has only
 * 1024 distinct values, so evaluating the transfer function (several pow()
 * calls) per pixel is wasteful: tables cut the conversion from seconds to
 * well under a second on an 8K panorama.
 */
const _lutCache = new Map();
function transferLut(transfer, depth) {
  const key = transfer + ':' + depth;
  let lut = _lutCache.get(key);
  if (!lut) {
    const size = 1 << depth;
    const max = size - 1;
    const fn = transferDecoder(transfer);
    lut = new Float32Array(size);
    for (let c = 0; c < size; c++) lut[c] = fn(c / max);
    _lutCache.set(key, lut);
  }
  return lut;
}

/**
 * Convert a decoded HDR AVIF (integer code values, Uint16) into a linear,
 * sRGB-primary half-float RGBA buffer suitable for hdrToGainMap. SDR diffuse
 * white maps to 1.0; highlights stay above 1.0.
 *
 * @param {{data:Uint16Array,width:number,height:number,depth:number}} decoded
 * @param {{primaries:number, transfer:number, matrix:number, fullRange:boolean}|null} color
 * @param {(h:number)=>number} toHalf  DataUtils.toHalfFloat
 * @param {boolean} flipY  passed through to the PixelBuffer. The AVIF decoder
 *        yields top-origin rows (same as createImageBitmap), so the caller sets
 *        this true to match the SDR / gain-map AVIF upload orientation.
 * @returns {{data:Uint16Array, width:number, height:number, kind:'half', flipY:boolean}}
 */
export function hdrCodesToLinearHalf(decoded, color, toHalf, flipY = true) {
  const { data, width, height, depth } = decoded;
  const transfer = color?.transfer ?? 13;
  const primaries = color?.primaries ?? 1;
  const lut = transferLut(transfer, depth);
  const isHLG = transfer === 18;
  const bt2020 = primaries === 9;

  // Luminance weights in the file's primaries (used by the HLG OOTF).
  const [kr, kg, kb] = bt2020
    ? [0.2627, 0.678, 0.0593]
    : [0.2126, 0.7152, 0.0722];
  // HLG OOTF: Fd = peak * Ys^(gamma-1) * Fs, then / 203 so diffuse white = 1.
  const hlgScale = HLG_PEAK_NITS / PQ_REFERENCE_WHITE_NITS;
  const hlgExp = HLG_SYSTEM_GAMMA - 1;

  const m = BT2020_TO_SRGB;
  const out = new Uint16Array(width * height * 4);
  const one = toHalf(1);
  const n = width * height;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let r = lut[data[o]];
    let g = lut[data[o + 1]];
    let b = lut[data[o + 2]];

    if (isHLG) {
      const ys = kr * r + kg * g + kb * b;
      const k = ys > 0 ? hlgScale * Math.pow(ys, hlgExp) : 0;
      r *= k;
      g *= k;
      b *= k;
    }

    if (bt2020) {
      // Gamut-convert, clip negative out-of-gamut values, keep highlights > 1.
      const r2 = m[0][0] * r + m[0][1] * g + m[0][2] * b;
      const g2 = m[1][0] * r + m[1][1] * g + m[1][2] * b;
      const b2 = m[2][0] * r + m[2][1] * g + m[2][2] * b;
      r = r2 > 0 ? r2 : 0;
      g = g2 > 0 ? g2 : 0;
      b = b2 > 0 ? b2 : 0;
    }

    out[o] = toHalf(r);
    out[o + 1] = toHalf(g);
    out[o + 2] = toHalf(b);
    out[o + 3] = one;
  }

  return { data: out, width, height, kind: 'half', flipY };
}

/**
 * Is this CICP transfer characteristic an HDR one (PQ or HLG)?
 */
export function isHDRTransfer(transfer) {
  return transfer === 16 || transfer === 18;
}
