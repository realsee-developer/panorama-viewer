/**
 * avif.js — AVIF container parsing and WASM decoding for the panorama loader.
 *
 * The browser's `createImageBitmap` decodes any AVIF to an 8-bit SDR image: it
 * drops the extra bit depth of 10/12-bit HDR and ignores an embedded ISO
 * 21496-1 gain map. This module covers the cases that need more, and leaves
 * plain / 8-bit SDR AVIF to the browser decoder (see loadAVIF in loader.js):
 *
 *   - inspectAVIF()        classifies a file (gain map or plain) from its
 *                          ISOBMFF `meta` box and locates the image items.
 *   - decodeAVIFItem()     decodes one `av01` image item at a given bit depth
 *                          with libavif compiled to WebAssembly (`@jsquash/avif`).
 *   - parseTmapMetadata()  reads the ISO 21496-1 `tmap` gain-map metadata item
 *                          into the loader's log2-space gainMeta.
 *   - itemBitDepth() / itemColorInfo()  read an item's `pixi` / `colr` (CICP).
 *
 * The libavif bundled in @jsquash/avif is v1.0.1, which predates the gain-map
 * API, so the container walk and `tmap` parsing are done here, and each image
 * item is repackaged as a standalone AVIF around its raw AV1 payload before it
 * is handed to the decoder. Only plain `av01` items are decodable this way;
 * `grid` (tiled) and other derived items are not supported.
 *
 * The decoder WASM is lazy-loaded (≈340 KB gzipped) the first time it is needed.
 */

/* ============================================================================
 * Lazy decoder init
 * ========================================================================== */

let _decodePromise = null;

/**
 * Lazily import and initialise the @jsquash/avif decoder. The WASM is fetched
 * and compiled on first use, then reused. Returns the module's default `decode`
 * function: decode(ArrayBuffer, { bitDepth }) -> { data, width, height }.
 */
async function getDecoder() {
  if (!_decodePromise) {
    _decodePromise = (async () => {
      // Resolve the decoder WASM as a real, hashed Vite asset URL (works under
      // dev, production builds and GitHub Pages subpaths), fetch + compile it,
      // and hand the module to init(). This avoids relying on the emscripten
      // glue's own URL resolution, which doesn't map onto Vite's asset layout.
      const [mod, wasmUrl] = await Promise.all([
        import('@jsquash/avif/decode.js'),
        import('@jsquash/avif/codec/dec/avif_dec.wasm?url').then((m) => m.default),
      ]);
      const resp = await fetch(wasmUrl);
      const wasmModule = await WebAssembly.compileStreaming(resp.clone()).catch(
        async () => WebAssembly.compile(await resp.arrayBuffer())
      );
      await mod.init(wasmModule);
      return mod.default;
    })();
    // A failed load (offline, blocked, ...) must not be cached, or every later
    // AVIF would fail until the page is reloaded. Clear it so the next call retries.
    _decodePromise.catch(() => {
      _decodePromise = null;
    });
  }
  return _decodePromise;
}

/* ============================================================================
 * ISOBMFF / HEIF box parsing
 *
 * An AVIF is an ISOBMFF file: a tree of length-prefixed "boxes". Image data
 * lives in `mdat`; the `meta` box describes items (`iinf`), their byte ranges
 * (`iloc`), their relationships (`iref`), their properties (`iprp` -> `ipco` +
 * `ipma`) and the primary item (`pitm`).
 *
 * We only parse the subset needed to (a) find the primary/base and gain-map
 * image items, (b) read their raw AV1 payloads, (c) read each item's `av1C` /
 * `ispe` / `pixi` / `colr` properties so we can repackage an item as a
 * standalone AVIF, and (d) parse the `tmap` gain-map metadata item.
 * ========================================================================== */

/** Read the list of boxes in [start, end) as {type, start, headerSize, size}. */
function readBoxes(view, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = view.getUint32(i);
    const type = String.fromCharCode(
      view.getUint8(i + 4),
      view.getUint8(i + 5),
      view.getUint8(i + 6),
      view.getUint8(i + 7)
    );
    let headerSize = 8;
    if (size === 1) {
      // 64-bit largesize.
      const hi = view.getUint32(i + 8);
      const lo = view.getUint32(i + 12);
      size = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - i; // extends to end of container
    }
    if (size < headerSize || i + size > end) break; // malformed; stop
    out.push({ type, start: i, headerSize, size });
    i += size;
  }
  return out;
}

/**
 * Parse an AVIF's `meta` box into a structured description.
 * @returns {{
 *   items: Map<number,{type:string, props:number[]}>,
 *   iloc: Map<number, Array<[number,number]>>,  // item -> [ [offset,length], ... ]
 *   properties: Array<{type:string, start:number, headerSize:number, size:number}>, // 1-indexed in ipma
 *   primaryItem: number|null,
 *   dimg: Map<number, number[]>,  // derived item -> input item ids
 * }|null}
 */
function parseMeta(view) {
  const top = readBoxes(view, 0, view.byteLength);
  const meta = top.find((b) => b.type === 'meta');
  if (!meta) return null;

  // `meta` is a FullBox: 4 bytes version/flags after the header.
  const metaInner = meta.start + meta.headerSize + 4;
  const metaEnd = meta.start + meta.size;
  const boxes = readBoxes(view, metaInner, metaEnd);

  const result = {
    items: new Map(),
    iloc: new Map(),
    properties: [],
    propAssoc: new Map(),
    primaryItem: null,
    dimg: new Map(),
  };

  for (const b of boxes) {
    switch (b.type) {
      case 'pitm':
        result.primaryItem = parsePitm(view, b);
        break;
      case 'iinf':
        parseIinf(view, b, result.items);
        break;
      case 'iloc':
        parseIloc(view, b, result.iloc);
        break;
      case 'iref':
        parseIref(view, b, result.dimg);
        break;
      case 'iprp':
        parseIprp(view, b, result);
        break;
      default:
        break;
    }
  }

  // Merge property associations into items.
  for (const [itemId, props] of result.propAssoc) {
    const it = result.items.get(itemId);
    if (it) it.props = props;
  }
  return result;
}

function parsePitm(view, box) {
  const i = box.start + box.headerSize;
  const version = view.getUint8(i);
  const p = i + 4; // skip version/flags
  return version === 0 ? view.getUint16(p) : view.getUint32(p);
}

function parseIinf(view, box, items) {
  let i = box.start + box.headerSize;
  const version = view.getUint8(i);
  i += 4;
  i += version === 0 ? 2 : 4; // entry_count (the infe boxes below are authoritative)
  const inner = readBoxes(view, i, box.start + box.size);
  for (const infe of inner) {
    if (infe.type !== 'infe') continue;
    let j = infe.start + infe.headerSize;
    const v = view.getUint8(j);
    j += 4;
    // infe v0/v1 have no item_type field (they predate typed items); v2 uses a
    // 16-bit item_ID and v3 a 32-bit one. AVIF/HEIF images use v2 or v3.
    if (v < 2) continue;
    const itemId = v === 2 ? view.getUint16(j) : view.getUint32(j);
    j += v === 2 ? 2 : 4;
    j += 2; // protection index
    const itemType = String.fromCharCode(
      view.getUint8(j),
      view.getUint8(j + 1),
      view.getUint8(j + 2),
      view.getUint8(j + 3)
    );
    items.set(itemId, { type: itemType, props: [] });
  }
}

function parseIloc(view, box, iloc) {
  let i = box.start + box.headerSize;
  const version = view.getUint8(i);
  i += 4;
  const b0 = view.getUint8(i);
  i += 1;
  const offsetSize = (b0 >> 4) & 0xf;
  const lengthSize = b0 & 0xf;
  const b1 = view.getUint8(i);
  i += 1;
  const baseOffsetSize = (b1 >> 4) & 0xf;
  const indexSize = b1 & 0xf;
  const itemCount = version < 2 ? view.getUint16(i) : view.getUint32(i);
  i += version < 2 ? 2 : 4;

  const readN = (n) => {
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + view.getUint8(i++);
    return v;
  };

  for (let e = 0; e < itemCount; e++) {
    const itemId = version < 2 ? view.getUint16(i) : view.getUint32(i);
    i += version < 2 ? 2 : 4;
    if (version === 1 || version === 2) i += 2; // construction method
    i += 2; // data reference index
    const baseOffset = readN(baseOffsetSize);
    const extentCount = view.getUint16(i);
    i += 2;
    const extents = [];
    for (let x = 0; x < extentCount; x++) {
      if (indexSize) readN(indexSize);
      const extOffset = readN(offsetSize);
      const extLength = readN(lengthSize);
      extents.push([baseOffset + extOffset, extLength]);
    }
    iloc.set(itemId, extents);
  }
}

function parseIref(view, box, dimg) {
  let i = box.start + box.headerSize;
  const version = view.getUint8(i);
  i += 4; // version/flags
  // iref v0 stores item ids as 16-bit values, v1 as 32-bit.
  const idSize = version === 0 ? 2 : 4;
  const readId = (at) => (idSize === 2 ? view.getUint16(at) : view.getUint32(at));
  const inner = readBoxes(view, i, box.start + box.size);
  for (const ref of inner) {
    let j = ref.start + ref.headerSize;
    const fromId = readId(j);
    j += idSize;
    const count = view.getUint16(j);
    j += 2;
    const toIds = [];
    for (let k = 0; k < count; k++) {
      toIds.push(readId(j));
      j += idSize;
    }
    if (ref.type === 'dimg') dimg.set(fromId, toIds);
  }
}

function parseIprp(view, box, result) {
  const inner = readBoxes(view, box.start + box.headerSize, box.start + box.size);
  const ipco = inner.find((b) => b.type === 'ipco');
  const ipma = inner.find((b) => b.type === 'ipma');
  if (ipco) {
    result.properties = readBoxes(
      view,
      ipco.start + ipco.headerSize,
      ipco.start + ipco.size
    );
  }
  if (ipma) parseIpma(view, ipma, result.propAssoc);
}

function parseIpma(view, box, propAssoc) {
  let i = box.start + box.headerSize;
  const version = view.getUint8(i);
  const flags = view.getUint32(i) & 0xffffff;
  i += 4;
  const entryCount = view.getUint32(i);
  i += 4;
  for (let e = 0; e < entryCount; e++) {
    const itemId = version < 1 ? view.getUint16(i) : view.getUint32(i);
    i += version < 1 ? 2 : 4;
    const assocCount = view.getUint8(i);
    i += 1;
    const props = [];
    for (let a = 0; a < assocCount; a++) {
      if (flags & 1) {
        const v = view.getUint16(i);
        i += 2;
        props.push({ index: v & 0x7fff, essential: (v >> 15) & 1 });
      } else {
        const v = view.getUint8(i);
        i += 1;
        props.push({ index: v & 0x7f, essential: (v >> 7) & 1 });
      }
    }
    propAssoc.set(itemId, props);
  }
}

/* ============================================================================
 * Standalone AVIF repackaging
 *
 * An image item's bytes in `mdat` are a bare AV1 OBU stream — not a full AVIF
 * file, so @jsquash/avif can't decode it directly. We wrap it in the smallest
 * valid AVIF: ftyp + meta{hdlr,pitm,iinf/infe,iprp{ipco,ipma},iloc} + mdat,
 * reusing the item's original `av1C`, `ispe` and `pixi` property boxes verbatim
 * so the decoder sees the exact codec configuration and dimensions. Verified
 * bit-exact against libavif's native decode of the same payload.
 * ========================================================================== */

function u32(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function u16(n) {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}
function str(s) {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}
function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function box(type, body) {
  return concat([u32(8 + body.length), str(type), body]);
}
function fullbox(type, version, flags, body) {
  return box(type, concat([u32((version << 24) | flags), body]));
}

/**
 * Repackage a raw AV1 image item into a standalone, minimal AVIF ArrayBuffer.
 *
 * @param {Uint8Array} payload  raw AV1 OBU bytes for the item
 * @param {Uint8Array[]} propBoxes  the item's property boxes (av1C, ispe, pixi,
 *                                  colr …), copied verbatim from the source ipco
 * @returns {ArrayBuffer}
 */
function repackItemToAVIF(payload, propBoxes) {
  const ITEM = 1;

  const ftyp = box('ftyp', concat([str('avif'), u32(0), str('avifmif1miaf')]));
  const hdlr = fullbox(
    'hdlr',
    0,
    0,
    concat([u32(0), str('pict'), new Uint8Array(12), str('libavif'), new Uint8Array([0])])
  );
  const pitm = fullbox('pitm', 0, 0, u16(ITEM));
  const infe = fullbox(
    'infe',
    2,
    0,
    concat([u16(ITEM), u16(0), str('av01'), new Uint8Array([0])])
  );
  const iinf = fullbox('iinf', 0, 0, concat([u16(1), infe]));

  const ipco = box('ipco', concat(propBoxes));
  // Associate all properties with the item (1-indexed). av1C is essential.
  const assocEntries = [];
  for (let k = 0; k < propBoxes.length; k++) {
    const type = String.fromCharCode(propBoxes[k][4], propBoxes[k][5], propBoxes[k][6], propBoxes[k][7]);
    const essential = type === 'av1C' ? 0x80 : 0x00;
    assocEntries.push(essential | (k + 1));
  }
  const ipma = fullbox(
    'ipma',
    0,
    0,
    concat([u32(1), u16(ITEM), new Uint8Array([propBoxes.length, ...assocEntries])])
  );
  const iprp = box('iprp', concat([ipco, ipma]));

  const buildMeta = (payloadOffset) => {
    const ilocBody = concat([
      new Uint8Array([0x44, 0x00]), // offsetSize=4, lengthSize=4, baseOffsetSize=0, indexSize=0
      u16(1), // item count
      u16(ITEM),
      u16(0), // data reference index
      u16(1), // extent count
      u32(payloadOffset),
      u32(payload.length),
    ]);
    const iloc = fullbox('iloc', 0, 0, ilocBody);
    return fullbox('meta', 0, 0, concat([hdlr, pitm, iinf, iprp, iloc]));
  };

  // The mdat payload offset depends on the meta size, which is constant here,
  // so one pass to size it then one pass to write the real offset.
  let meta = buildMeta(0);
  const payloadOffset = ftyp.length + meta.length + 8; // + mdat header
  meta = buildMeta(payloadOffset);
  const mdat = box('mdat', payload);

  const out = concat([ftyp, meta, mdat]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/** Collect an item's property boxes (as raw bytes) from the parsed meta. */
function itemPropertyBoxes(view, meta, itemId, keepTypes) {
  const it = meta.items.get(itemId);
  if (!it) return [];
  const boxes = [];
  for (const assoc of it.props) {
    const prop = meta.properties[assoc.index - 1];
    if (!prop) continue;
    if (keepTypes && !keepTypes.includes(prop.type)) continue;
    boxes.push(new Uint8Array(view.buffer, prop.start, prop.size));
  }
  return boxes;
}

/* ============================================================================
 * tmap (ISO 21496-1) gain-map metadata
 * ========================================================================== */

/**
 * Parse the ISO 21496-1 tone-map metadata payload (the `tmap` item's bytes)
 * into the loader's log2-space gainMeta shape. Multi-channel metadata is
 * collapsed to a single representative channel (the gain-map compositor samples
 * the gain map per channel but applies scalar min/max; using channel 0 matches
 * the common single-channel authoring and libavif's own summary).
 *
 * Layout (big-endian), per ISO 21496-1:
 *   u8   version
 *   u16  minimum_version
 *   u16  writer_version
 *   u8   flags  (bit7 = is_multichannel, bit6 = use_base_colour_space)
 *   s32/u32  base_hdr_headroom  (num/den)
 *   s32/u32  alternate_hdr_headroom  (num/den)
 *   per channel (1 or 3):
 *     s32/u32 gain_map_min (num/den)
 *     s32/u32 gain_map_max (num/den)
 *     u32/u32 gamma (num/den)
 *     s32/u32 base_offset (num/den)
 *     s32/u32 alternate_offset (num/den)
 */
export function parseTmapMetadata(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  const u8r = () => v.getUint8(i++);
  const s32 = () => {
    const n = v.getInt32(i);
    i += 4;
    return n;
  };
  const u32r = () => {
    const n = v.getUint32(i);
    i += 4;
    return n;
  };
  const frac = (signed) => {
    const num = signed ? s32() : u32r();
    const den = u32r();
    return den === 0 ? 0 : num / den;
  };

  u8r(); // version
  v.getUint16(i); i += 2; // minimum_version
  v.getUint16(i); i += 2; // writer_version
  const flags = u8r();
  const isMultichannel = (flags & 0x80) !== 0;
  const channels = isMultichannel ? 3 : 1;

  const baseHeadroom = frac(true); // log2
  const altHeadroom = frac(true); // log2

  // Read channel 0; skip the rest (we use scalar gain-map params).
  const ch = [];
  for (let c = 0; c < channels; c++) {
    const gainMapMin = frac(true); // log2
    const gainMapMax = frac(true); // log2
    const gamma = frac(false);
    const baseOffset = frac(true);
    const altOffset = frac(true);
    ch.push({ gainMapMin, gainMapMax, gamma, baseOffset, altOffset });
  }
  const c0 = ch[0];

  // Map ISO fields -> loader gainMeta (log2 space). HDR capacity bounds come
  // from the base/alternate headroom (the display range the gain map spans).
  const hdrCapacityMin = Math.min(baseHeadroom, altHeadroom);
  const hdrCapacityMax = Math.max(baseHeadroom, altHeadroom);
  return {
    gainMapMin: c0.gainMapMin,
    gainMapMax: c0.gainMapMax,
    gamma: c0.gamma || 1,
    offsetSDR: c0.baseOffset,
    offsetHDR: c0.altOffset,
    hdrCapacityMin,
    // When headroom metadata is absent (both 0), fall back to the gain-map's
    // own max so the compositor still has a meaningful range.
    hdrCapacityMax:
      hdrCapacityMax > hdrCapacityMin ? hdrCapacityMax : Math.max(c0.gainMapMax, 1e-3),
    // ISO 21496-1 puts the HDR rendition on whichever side has more headroom.
    // The gain-map compositor only supports an SDR base, so callers must check.
    baseRenditionIsHDR: baseHeadroom > altHeadroom,
  };
}

/* ============================================================================
 * Public API
 * ========================================================================== */

/**
 * Inspect an AVIF buffer and classify it.
 * @param {ArrayBuffer} buffer
 * @returns {{ kind:'gainmap'|'plain', ... }}
 */
export function inspectAVIF(buffer) {
  const view = new DataView(buffer);
  const meta = parseMeta(view);
  if (!meta) return { kind: 'plain', meta: null };

  // Gain map: a `tmap` item grouped (altr) with — or derived (dimg) from — the
  // base and gain-map image items.
  const tmapId = [...meta.items.entries()].find(([, it]) => it.type === 'tmap')?.[0];
  if (tmapId != null && meta.dimg.has(tmapId)) {
    const inputs = meta.dimg.get(tmapId); // [baseItemId, gainItemId]
    if (inputs.length >= 2) {
      return {
        kind: 'gainmap',
        meta,
        tmapId,
        baseItemId: inputs[0],
        gainItemId: inputs[1],
      };
    }
  }
  return { kind: 'plain', meta };
}

/**
 * Decode a single AVIF image item (by id) to a PixelBuffer. Repackages the
 * item as a standalone AVIF, decodes it at the requested bit depth, and returns
 * raw pixels. For 8-bit the data is sRGB-coded u8; for >8-bit it's the decoder's
 * normalized code values in a Uint16Array (0..(2^depth-1)), still in the file's
 * transfer function and primaries — color conversion is the caller's job.
 *
 * @returns {{ data:Uint8Array|Uint16Array, width:number, height:number, depth:number }}
 */
export async function decodeAVIFItem(view, meta, itemId, buffer, { depth = 8 } = {}) {
  const extents = meta.iloc.get(itemId);
  if (!extents || !extents.length) {
    throw new Error(`AVIF item ${itemId} has no data location`);
  }
  // Concatenate extents (usually one) into the raw AV1 payload.
  const u8 = new Uint8Array(buffer);
  let payload;
  if (extents.length === 1) {
    const [off, len] = extents[0];
    payload = u8.subarray(off, off + len);
  } else {
    let total = 0;
    for (const [, len] of extents) total += len;
    payload = new Uint8Array(total);
    let o = 0;
    for (const [off, len] of extents) {
      payload.set(u8.subarray(off, off + len), o);
      o += len;
    }
  }

  const props = itemPropertyBoxes(view, meta, itemId, ['av1C', 'ispe', 'pixi']);
  const standalone = repackItemToAVIF(payload, props);

  const decode = await getDecoder();
  const result = await decode(standalone, { bitDepth: depth });
  if (!result) throw new Error(`AVIF item ${itemId} decode failed`);
  return {
    data: result.data,
    width: result.width,
    height: result.height,
    depth,
  };
}

/** Read the depth (bits per channel) an AVIF item declares via its `pixi`. */
export function itemBitDepth(view, meta, itemId) {
  const it = meta.items.get(itemId);
  if (!it) return 8;
  for (const assoc of it.props) {
    const prop = meta.properties[assoc.index - 1];
    if (prop && prop.type === 'pixi') {
      // pixi: fullbox header (4) + num_channels (1) + per-channel bit depth.
      const depth = view.getUint8(prop.start + prop.headerSize + 5);
      return depth || 8;
    }
  }
  return 8;
}

/**
 * Read an AVIF item's CICP colour info from its `colr` (nclx) property.
 * @returns {{ primaries:number, transfer:number, matrix:number, fullRange:boolean }|null}
 */
export function itemColorInfo(view, meta, itemId) {
  const it = meta.items.get(itemId);
  if (!it) return null;
  for (const assoc of it.props) {
    const prop = meta.properties[assoc.index - 1];
    if (prop && prop.type === 'colr') {
      const p = prop.start + prop.headerSize;
      const colourType = String.fromCharCode(
        view.getUint8(p),
        view.getUint8(p + 1),
        view.getUint8(p + 2),
        view.getUint8(p + 3)
      );
      if (colourType !== 'nclx') return null;
      return {
        primaries: view.getUint16(p + 4),
        transfer: view.getUint16(p + 6),
        matrix: view.getUint16(p + 8),
        fullRange: (view.getUint8(p + 10) & 0x80) !== 0,
      };
    }
  }
  return null;
}
