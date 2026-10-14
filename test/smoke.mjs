// Headless smoke test: loads the app, drops each fixture, checks behavior.
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:4317/';
const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const fixtures = {
  tooTall: resolve(__dirname, 'fixtures/pano_1.75to1.jpg'), // <2:1 -> reject
  exact: resolve(__dirname, 'fixtures/pano_2to1.jpg'), // ==2:1 -> ok
  wide: resolve(__dirname, 'fixtures/pano_3to1.jpg'), // >2:1 -> letterbox
};

async function dropFile(page, filePath) {
  // Set the hidden input, then dispatch a synthetic drop with the file.
  const input = await page.$('#fileInput');
  await input.uploadFile(filePath);
  await page.evaluate(() => {
    const i = document.getElementById('fileInput');
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function readText(page, id) {
  return page.$eval(`#${id}`, (el) => el.textContent.trim());
}

async function isHidden(page, id) {
  return page.$eval(`#${id}`, (el) => el.hasAttribute('hidden'));
}

// Sample brightness from a Puppeteer screenshot of the canvas region
// (reliable, unlike reading back a WebGPU canvas after present).
async function canvasHasContent(page) {
  const view = await page.$('#view');
  const buf = await view.screenshot({ encoding: 'binary' });
  // Decode PNG average luma via a quick in-page draw.
  const b64 = buf.toString('base64');
  return page.evaluate(async (data) => {
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
    const avg = sum / (32 * 32 * 3);
    return { avg: Math.round(avg), nonBlack: avg > 8 };
  }, b64);
}

(async () => {
  const consoleErrors = [];
  const pageErrors = [];

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=metal',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const results = {};

  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1500));

  // WebGPU availability inside this Chrome
  results.webgpu = await page.evaluate(() => !!navigator.gpu);
  results.hdrBadge = await readText(page, 'hdrBadgeVal');

  // --- Case 1: too-tall image should be rejected (toast shown, panel hidden)
  await dropFile(page, fixtures.tooTall);
  await new Promise((r) => setTimeout(r, 1200));
  results.tooTall_toast = await readText(page, 'toast').catch(() => '');
  results.tooTall_panelHidden = await isHidden(page, 'panel');

  // --- Case 2: exact 2:1 should load (panel visible, meta filled)
  await dropFile(page, fixtures.exact);
  await new Promise((r) => setTimeout(r, 2500));
  results.exact_panelHidden = await isHidden(page, 'panel');
  results.exact_loaderHidden = await isHidden(page, 'loader');
  results.exact_format = await readText(page, 'metaFormat');
  results.exact_res = await readText(page, 'metaRes');
  results.exact_ratio = await readText(page, 'metaRatio');
  results.exact_canvas = await canvasHasContent(page);
  await page.screenshot({ path: resolve(__dirname, 'shot_exact.png') });

  // --- Case 3: wide 3:1 should load with letterbox note
  await dropFile(page, fixtures.wide);
  await new Promise((r) => setTimeout(r, 2000));
  results.wide_ratio = await readText(page, 'metaRatio');
  await page.screenshot({ path: resolve(__dirname, 'shot_wide.png') });

  // --- Case 4: drag should change lon/lat; minimap click should set view.
  const getView = () =>
    page.evaluate(() => {
      // viewer is module-scoped; expose via a global hook for the test.
      return window.__view ? window.__view() : null;
    });

  // Drag across the canvas.
  const box = await (await page.$('#view')).boundingBox();
  const beforeDrag = await getView();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  const afterDrag = await getView();
  results.dragChangedLon =
    beforeDrag && afterDrag ? beforeDrag.lon !== afterDrag.lon : 'no-hook';

  // Click minimap far left -> lon should jump.
  const mm = await (await page.$('#minimap')).boundingBox();
  await page.mouse.click(mm.x + mm.width * 0.1, mm.y + mm.height * 0.5);
  await new Promise((r) => setTimeout(r, 300));
  const afterClick = await getView();
  results.minimapClickChangedLon =
    afterDrag && afterClick ? afterDrag.lon !== afterClick.lon : 'no-hook';

  results.consoleErrors = consoleErrors;
  results.pageErrors = pageErrors;

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})().catch((e) => {
  console.error('TEST_DRIVER_ERROR:', e.message);
  process.exit(1);
});
