// Renders page 1 of a PDF to PNG with pdf.js in Chromium, for visual review of PDF layout.
//   node scripts/render-pdf.mjs <in.pdf> <out.png>
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [input, output] = process.argv.slice(2);
const pdf = readFileSync(input).toString('base64');
const lib = resolve('node_modules/pdfjs-dist/build');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
await page.route('http://render.local/**', (r) => {
  const name = new URL(r.request().url()).pathname.slice(1);
  if (name === '') return r.fulfill({ contentType: 'text/html', body: '<canvas id="c"></canvas>' });
  return r.fulfill({ contentType: 'text/javascript', body: readFileSync(`${lib}/${name}`) });
});
await page.goto('http://render.local/');
await page.evaluate(async (b64) => {
  const pdfjs = await import('http://render.local/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'http://render.local/pdf.worker.mjs';
  const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const doc = await pdfjs.getDocument({ data }).promise;
  const p = await doc.getPage(1);
  const vp = p.getViewport({ scale: 1.4 });
  const c = document.getElementById('c');
  c.width = vp.width; c.height = vp.height;
  await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
}, pdf);
await page.locator('#c').screenshot({ path: output });
await browser.close();
console.log('rendered', output);
