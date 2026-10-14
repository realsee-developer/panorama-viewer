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
const hdrControl = $('hdrControl');
const hdrBoost = $('hdrBoost');
const hdrBoostVal = $('hdrBoostVal');
const hdrBoostMax = $('hdrBoostMax');
const minimapCanvas = $('minimap');
const hdrBadge = $('hdrBadge');
const statDisplay = $('statDisplay');
const statCanvas = $('statCanvas');
const mapToggle = $('mapToggle');
const toast = $('toast');
const loader = $('loader');

let viewer;
let minimap;
let displayHDR;

// Persistent status so the bottom-left badge shows the same rows before and
// after loading (display capability / canvas output format).
const status = {
  canvas: null, // hdrResult when HDR output active, else null
};

// ---------- bootstrap ----------
init().catch((err) => {
  console.error(err);
  showToast(err.message || String(err), 8000);
});

async function init() {
  // HDR display detection (independent of whether an image is loaded). The
  // badge itself stays hidden until an image is loaded.
  displayHDR = detectDisplayHDR();
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
  window.__setView = (lon, lat) => viewer.setView(lon, lat);

  bindUI();
}

// ---------- UI wiring ----------
function bindUI() {
  // File picker
  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  // Load the bundled demo panorama (Ultra HDR).
  const demoBtn = document.getElementById('demoBtn');
  if (demoBtn) {
    demoBtn.addEventListener('click', async () => {
      showLoader(true);
      try {
        // `import.meta.env.BASE_URL` resolves correctly under GitHub Pages
        // project subpaths.
        const base = import.meta.env.BASE_URL || '/';
        const url = base.replace(/\/$/, '') + '/equirect.uhdr.jpg';
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Failed to load sample (' + resp.status + ')');
        const blob = await resp.blob();
        const file = new File([blob], 'equirect.uhdr.jpg', {
          type: 'image/jpeg',
        });
        await handleFile(file);
      } catch (e) {
        showToast(e.message || 'Failed to load sample', 6000);
        showLoader(false);
      }
    });
  }

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

    // Apply the panorama (SDR texture or HDR gain-map descriptor).
    viewer.setPanorama(result.isHDR ? result.hdr : result.texture);

    // Try to enable true HDR output when the content is HDR *and* the display
    // reports HDR capability. We still attempt configure on HDR content even
    // if media query is false, because some browsers mis-report.
    let hdrResult = { ok: false };
    if (result.isHDR && !new URLSearchParams(location.search).has('nohdr')) {
      hdrResult = viewer.enableHDR();
    }

    // HDR boost control: show for Ultra HDR, hide otherwise.
    setupHDRControl(result.isHDR);

    // Fill meta panel.
    panel.hidden = false;
    metaFormat.textContent = result.format;
    metaRes.textContent = `${result.width} × ${result.height}`;
    metaRatio.textContent =
      formatAspect(result.width, result.height) +
      (result.letterboxed ? ' · letterboxed' : '');
    setHdrMeta(result.isHDR, hdrResult);

    // Minimap.
    minimap.setViewportAspect(canvas.clientWidth / canvas.clientHeight);
    minimap.setImage(result.previewBitmap);

    // Reveal viewer.
    dropzone.classList.add('hidden-fade');
    mapToggle.hidden = false;
    hdrBadge.hidden = false;
    renderHDRBadge(hdrResult);

    if (result.letterboxed) {
      showToast('Aspect ratio exceeds 2:1 — letterboxed (black bars top & bottom).', 4000);
    }
  } catch (err) {
    console.error(err);
    if (err instanceof AspectRatioError) {
      showToast(err.message, 9000);
    } else {
      showToast(err.message || 'Failed to load image', 8000);
    }
  } finally {
    showLoader(false);
  }
}

// ---------- HDR boost control ----------
let hdrBoostBound = false;

function setupHDRControl(isHDR) {
  if (!isHDR) {
    hdrControl.hidden = true;
    return;
  }
  const info = viewer.getHDRInfo();
  if (!info) {
    hdrControl.hidden = true;
    return;
  }

  // Slider range reflects realistic *display* HDR headroom, not the content's
  // raw capacity. HDR headroom is measured in stops (log2):
  //   SDR = 0 stops (1×), typical HDR displays ≈ 1.5–3 stops (≈3–8×),
  //   a great HDR display (e.g. modern MacBook Pro) ≈ 4 stops (16×).
  // So we cap the slider at 4 stops (16×) regardless of the (often huge)
  // HDRCapacityMax the file declares, and default to a strong-but-sane 3 stops
  // (8×). The slider never exceeds the content's own capacity either.
  const MAX_STOPS = 4; // 16×
  const DEFAULT_STOPS = 3; // 8×
  const contentMaxLinear = Math.max(1.01, info.hdrCapacityMaxLinear);
  const maxLinear = Math.min(Math.pow(2, MAX_STOPS), contentMaxLinear);
  const defaultLinear = Math.min(Math.pow(2, DEFAULT_STOPS), maxLinear);

  hdrBoost.min = '1';
  hdrBoost.max = maxLinear.toFixed(2);
  hdrBoost.step = Math.max(0.01, (maxLinear - 1) / 200).toFixed(3);
  hdrBoost.value = defaultLinear.toFixed(2);
  hdrBoostMax.textContent = `${maxLinear.toFixed(1)}× (${MAX_STOPS} stops)`;
  updateBoostLabel(defaultLinear);

  // Apply the initial boost.
  viewer.setMaxDisplayBoost(defaultLinear);

  if (!hdrBoostBound) {
    hdrBoost.addEventListener('input', () => {
      const v = parseFloat(hdrBoost.value);
      viewer.setMaxDisplayBoost(v);
      updateBoostLabel(v);
    });
    hdrBoostBound = true;
  }

  hdrControl.hidden = false;
}

function updateBoostLabel(linear) {
  hdrBoostVal.textContent = `${linear.toFixed(2)}×`;
}

/**
 * Format an aspect ratio for display. Prefers a clean reduced integer ratio
 * (e.g. 8192×4096 → "2:1", 1920×1080 → "16:9"); falls back to a decimal
 * "N.NN:1" when the reduced ratio would be unwieldy.
 */
function formatAspect(w, h) {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h) || 1;
  const rw = w / g;
  const rh = h / g;
  const decimal = `${(w / h).toFixed(2)}:1`;
  // Use the reduced ratio only when both terms are small and tidy.
  if (rw <= 64 && rh <= 64) return `${rw}:${rh}`;
  return decimal;
}

// ---------- HDR status rendering ----------
function renderHDRBadge(hdrResult) {
  if (hdrResult !== undefined) status.canvas = hdrResult;

  // Row 1 — display capability (always known from matchMedia).
  if (displayHDR.supported) {
    statDisplay.textContent = 'Supported';
    statDisplay.className = 'hdrBadge__val ok';
  } else {
    statDisplay.textContent = 'Not supported';
    statDisplay.className = 'hdrBadge__val no';
  }

  // Row 2 — actual canvas output format.
  if (status.canvas && status.canvas.ok) {
    const cs = status.canvas.colorSpace === 'display-p3' ? 'P3' : status.canvas.colorSpace;
    statCanvas.textContent = `HDR ${status.canvas.format} · ${cs}`;
    statCanvas.className = 'hdrBadge__val ok';
  } else {
    statCanvas.textContent = 'SDR (8-bit)';
    statCanvas.className = 'hdrBadge__val no';
  }
}

function setHdrMeta(isHDR, hdrResult) {
  if (!isHDR) {
    metaHdr.textContent = 'SDR';
    metaHdr.className = '';
    return;
  }
  if (hdrResult.ok) {
    metaHdr.textContent = `True HDR · ${hdrResult.format}`;
    metaHdr.className = 'on';
  } else {
    metaHdr.textContent = 'HDR content (canvas fell back to SDR)';
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
