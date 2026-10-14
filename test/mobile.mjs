// Mobile layout + FOV zoom verification.
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:4323/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-sandbox'],
  });
  const page = await browser.newPage();
  // iPhone-ish viewport
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  const out = {};
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));

  // Load a valid pano.
  const input = await page.$('#fileInput');
  await input.uploadFile(resolve(__dirname, 'fixtures/pano_2to1.jpg'));
  await page.evaluate(() =>
    document
      .getElementById('fileInput')
      .dispatchEvent(new Event('change', { bubbles: true }))
  );
  await new Promise((r) => setTimeout(r, 2500));

  // mapToggle button should be visible on mobile.
  out.mapToggleVisible = await page.$eval('#mapToggle', (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && !el.hidden;
  });

  // Panel starts closed (not .open) on mobile.
  out.panelClosedInitially = await page.$eval(
    '#panel',
    (el) => !el.classList.contains('open')
  );

  // Tap the toggle -> panel opens as modal.
  await page.click('#mapToggle');
  await new Promise((r) => setTimeout(r, 400));
  out.panelOpensAsModal = await page.$eval('#panel', (el) =>
    el.classList.contains('open')
  );
  out.bodyPanelOpen = await page.evaluate(() =>
    document.body.classList.contains('panel-open')
  );
  await page.screenshot({ path: resolve(__dirname, 'shot_mobile_modal.png') });

  // Close by tapping toggle again.
  await page.click('#mapToggle');
  await new Promise((r) => setTimeout(r, 400));
  out.panelClosesAgain = await page.$eval(
    '#panel',
    (el) => !el.classList.contains('open')
  );

  // FOV zoom via wheel.
  const fovBefore = await page.evaluate(() => window.__view().fov);
  const box = await (await page.$('#view')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel({ deltaY: -300 }); // zoom in -> smaller fov
  await new Promise((r) => setTimeout(r, 200));
  const fovAfter = await page.evaluate(() => window.__view().fov);
  out.fovBefore = fovBefore;
  out.fovAfter = fovAfter;
  out.zoomChangedFov = fovBefore !== fovAfter;

  out.pageErrors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
