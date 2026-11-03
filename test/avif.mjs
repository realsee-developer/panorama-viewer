// Load AVIF panoramas (8-bit SDR, 10-bit PQ HDR, gain map) through the full app
// and report decode + render results. Uses ?nohdr so the HDR path renders
// through the SDR-tonemapped output (a headless rgba16float canvas reads back
// near-black otherwise).
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE_URL || 'http://localhost:4330/') + '?nohdr';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CASES = [
  { name: '8-bit SDR', file: 'fixtures/avif_8bit.avif', hdr: false },
  { name: '10-bit PQ HDR', file: 'fixtures/avif_10bit_pq.avif', hdr: true },
  { name: 'gain map', file: 'fixtures/avif_gainmap.avif', hdr: true },
];

async function loadAndInspect(page, filePath) {
  // Reset to a clean app state for each case.
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 500));

  const input = await page.$('#fileInput');
  await input.uploadFile(filePath);
  await page.evaluate(() =>
    document
      .getElementById('fileInput')
      .dispatchEvent(new Event('change', { bubbles: true }))
  );
  await new Promise((r) => setTimeout(r, 5000));

  const out = {};
  out.loaderHidden = await page.$eval('#loader', (el) => el.hasAttribute('hidden'));
  out.format = await page.$eval('#metaFormat', (el) => el.textContent.trim());
  out.res = await page.$eval('#metaRes', (el) => el.textContent.trim());
  out.hdrMeta = await page.$eval('#metaHdr', (el) => el.textContent.trim());

  const view = await page.$('#view');
  const buf = await view.screenshot({ encoding: 'binary' });
  const b64 = buf.toString('base64');
  out.canvas = await page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = 'data:image/png;base64,' + data;
    });
    const off = document.createElement('canvas');
    off.width = 32;
    off.height = 32;
    const ctx = off.getContext('2d');
    ctx.drawImage(img, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return { avg: Math.round(sum / (32 * 32 * 3)) };
  }, b64);
  return out;
}

(async () => {
  const errors = [];
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  const results = {};
  let allPass = true;
  for (const c of CASES) {
    const file = resolve(__dirname, c.file);
    const r = await loadAndInspect(page, file);
    const isHDR = /HDR|gain map/i.test(r.hdrMeta);
    const pass =
      r.loaderHidden &&
      /AVIF/i.test(r.format) &&
      r.res.startsWith('1024') &&
      isHDR === c.hdr &&
      r.canvas.avg > 5; // canvas drew something non-black
    allPass = allPass && pass;
    results[c.name] = { ...r, expectedHDR: c.hdr, pass };
  }

  results.errors = errors;
  results.allPass = allPass && errors.length === 0;
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(results.allPass ? 0 : 1);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
