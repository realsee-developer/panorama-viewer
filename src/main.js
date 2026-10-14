/**
 * main.js — Wires UI, viewer, loader, minimap and HDR detection together.
 */

import { PanoramaViewer } from './viewer.js';
import { Minimap } from './minimap.js';
import { loadPanorama, AspectRatioError } from './loader.js';
import { detectDisplayHDR } from './hdr.js';

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const canvas = $('view');
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const pickBtn = $('pickBtn');
const panel = $('panel');
const metaFormat = $('metaFormat');
const metaRes = $('metaRes');
const metaRatio = $('metaRatio');
const metaHdr = $('metaHdr');
const minimapCanvas = $('minimap');
const hdrBadge = $('hdrBadge');
const hdrBadgeVal = $('hdrBadgeVal');
const mapToggle = $('mapToggle');
const toast = $('toast');
const loader = $('loader');

let viewer;
let minimap;
let displayHDR;

// ---------- bootstrap ----------
init().catch((err) => {
  console.error(err);
  showToast(err.message || String(err), 8000);
});

async function init() {
  // HDR display detection (independent of whether an image is loaded).
  displayHDR = detectDisplayHDR();
  hdrBadge.hidden = false;
  renderHDRBadge();
  if (displayHDR.mql && displayHDR.mql.addEventListener) {
    displayHDR.mql.addEventListener('change', (e) => {
      displayHDR.supported = e.matches;
      renderHDRBadge();
    });
  }

  viewer = new PanoramaViewer(canvas);
  await viewer.init();

  minimap = new Minimap(minimapCanvas);
  minimap.onPick = (lon, lat) => {
    viewer.setView(lon, lat);
  };

  // Push live view state into the minimap.
  viewer.onViewChange = (lon, lat, fov) => {
    minimap.update(lon, lat, fov);
  };

  // Debug/test hook: read current view state.
  window.__view = () => viewer.getView();

  bindUI();
}

// ---------- UI wiring ----------
function bindUI() {
  // File picker
  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  // Drag & drop (whole window)
  ['dragenter', 'dragover'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && e.relatedTarget) return;
      dropzone.classList.remove('dragover');
    })
  );
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  // Mobile minimap modal toggle
  mapToggle.addEventListener('click', () => {
    panel.classList.toggle('open');
    document.body.classList.toggle(
      'panel-open',
      panel.classList.contains('open')
    );
    if (panel.classList.contains('open')) minimap.resize();
  });
  // Tap backdrop to close (mobile)
  document.addEventListener('click', (e) => {
    if (
      panel.classList.contains('open') &&
      !panel.contains(e.target) &&
      e.target !== mapToggle
    ) {
      panel.classList.remove('open');
      document.body.classList.remove('panel-open');
    }
  });

  window.addEventListener('resize', () => minimap && minimap.resize());
}

// ---------- file handling ----------
async function handleFile(file) {
  showLoader(true);
  hideToast();
  try {
    const result = await loadPanorama(file, viewer.renderer);

    // Apply to the sphere.
    viewer.setPanorama(result.texture);

    // Try to enable true HDR output when the content is HDR *and* the display
    // reports HDR capability. We still attempt configure on HDR content even
    // if media query is false, because some browsers mis-report.
    let hdrResult = { ok: false };
    if (result.isHDR) {
      hdrResult = viewer.enableHDR();
    }

    // Fill meta panel.
    panel.hidden = false;
    metaFormat.textContent = result.format;
    metaRes.textContent = `${result.width} × ${result.height}`;
    metaRatio.textContent =
      result.ratio.toFixed(3) + ' : 1' + (result.letterboxed ? ' (上下留黑边)' : '');
    setHdrMeta(result.isHDR, hdrResult);

    // Minimap.
    minimap.setViewportAspect(canvas.clientWidth / canvas.clientHeight);
    minimap.setImage(result.previewBitmap);

    // Reveal viewer.
    dropzone.classList.add('hidden-fade');
    mapToggle.hidden = false;
    renderHDRBadge(hdrResult);

    if (result.letterboxed) {
      showToast('图片宽高比大于 2:1，已自动上下留黑边。', 4000);
    }
  } catch (err) {
    console.error(err);
    if (err instanceof AspectRatioError) {
      showToast(err.message, 9000);
    } else {
      showToast(err.message || '加载失败', 8000);
    }
  } finally {
    showLoader(false);
  }
}

// ---------- HDR status rendering ----------
function renderHDRBadge(hdrResult) {
  if (displayHDR.supported) {
    hdrBadgeVal.textContent = '支持 (dynamic-range: high)';
    hdrBadgeVal.className = 'hdrBadge__val ok';
  } else {
    hdrBadgeVal.textContent = '不支持 / SDR 显示器';
    hdrBadgeVal.className = 'hdrBadge__val no';
  }
  // If we actually activated HDR output on the canvas, note it.
  if (hdrResult && hdrResult.ok) {
    hdrBadgeVal.textContent = `HDR 输出中 · ${hdrResult.colorSpace} / ${hdrResult.toneMapping}`;
    hdrBadgeVal.className = 'hdrBadge__val ok';
  }
}

function setHdrMeta(isHDR, hdrResult) {
  if (!isHDR) {
    metaHdr.textContent = 'SDR';
    metaHdr.className = '';
    return;
  }
  if (hdrResult.ok) {
    metaHdr.textContent = `真 HDR · ${hdrResult.format}`;
    metaHdr.className = 'on';
  } else {
    metaHdr.textContent = 'HDR 内容 (画布回退 SDR)';
    metaHdr.className = 'on';
  }
}

// ---------- toast / loader ----------
let toastTimer;
function showToast(msg, ms = 5000) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  toast.hidden = true;
}
function showLoader(on) {
  loader.hidden = !on;
}
