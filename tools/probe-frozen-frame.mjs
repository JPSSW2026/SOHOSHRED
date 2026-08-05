/** Re-render one frozen frame repeatedly, dt=0, no sim advance. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createHash } from 'crypto';
const server = await createServer({ root: process.cwd(), server: { port: 6247 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto('http://127.0.0.1:6247/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 240000 });
const md5 = b => createHash('md5').update(b).digest('hex').slice(0, 12);
await page.evaluate(() => {
  const S = window.__SOHO;
  S.engine.manualTime = true;
  S.shot('chase-carve');           // pose once
});
const hashes = [];
for (let i = 0; i < 4; i++) {
  // dt = 0: nothing in the sim can advance. Only the render path runs.
  await page.evaluate(() => window.__SOHO.engine.tick(0, true));
  hashes.push(md5(await page.screenshot()));
}
console.log('frozen re-renders:', JSON.stringify(hashes));
console.log('all identical:', new Set(hashes).size === 1);
await browser.close(); await server.close();
