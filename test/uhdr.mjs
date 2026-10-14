// Load the real Ultra HDR panorama through the full app and report results.
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:4330/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FILE = resolve(__dirname, '../public/equirect.uhdr.jpg');

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

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));

  const out = {};
  out.webgpu = await page.evaluate(() => !!navigator.gpu);

  const input = await page.$('#fileInput');
  await input.uploadFile(FILE);
  await page.evaluate(() =>
    document
      .getElementById('fileInput')
      .dispatchEvent(new Event('change', { bubbles: true }))
  );

  // Ultra HDR + 8K decode can take a while.
  await new Promise((r) => setTimeout(r, 8000));

  out.loaderHidden = await page.$eval('#loader', (el) =>
    el.hasAttribute('hidden')
  );
  out.panelVisible = await page.$eval(
    '#panel',
    (el) => !el.hasAttribute('hidden')
  );
  out.format = await page.$eval('#metaFormat', (el) => el.textContent.trim());
  out.res = await page.$eval('#metaRes', (el) => el.textContent.trim());
  out.ratio = await page.$eval('#metaRatio', (el) => el.textContent.trim());
  out.hdrMeta = await page.$eval('#metaHdr', (el) => el.textContent.trim());
  out.hdrBadge = await page.evaluate(() => ({
    display: document.getElementById('statDisplay').textContent.trim(),
    image: document.getElementById('statImage').textContent.trim(),
    canvas: document.getElementById('statCanvas').textContent.trim(),
  }));

  // The HDR boost control should be visible with a sensible range.
  out.hdrControl = await page.evaluate(() => ({
    visible: !document.getElementById('hdrControl').hidden,
    max: document.getElementById('hdrBoost').max,
    value: document.getElementById('hdrBoost').value,
  }));

  // Confirm the canvas actually drew something (screenshot brightness).
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

  await page.screenshot({ path: resolve(__dirname, 'shot_uhdr.png') });

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
