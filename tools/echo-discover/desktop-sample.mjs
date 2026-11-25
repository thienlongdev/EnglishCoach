import { chromium } from 'playwright';
import { publicPaths } from './crawl.mjs';

const base = new URL(process.env.DISCOVER_BASE || 'http://127.0.0.1:18492');
if (!['localhost','127.0.0.1'].includes(base.hostname)) throw Error('Use a loopback frontend.');
const paths = process.env.DISCOVER_PATHS?.split(',') || publicPaths;
const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined});
const results = [];
try {
  for (const path of paths) {
    for (let run = 1; run <= 3; run++) {
      const context = await browser.newContext({ viewport: {width:1440, height:900}, deviceScaleFactor:1 });
      try {
        await context.addInitScript(() => {
          window.discoverPaint = { lcp: null, element: null };
          new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              window.discoverPaint = { lcp: entry.startTime, element: entry.element?.tagName || null };
            }
          }).observe({type:'largest-contentful-paint',buffered:true});
        });
        const page = await context.newPage();
        const response = await page.goto(new URL(path,base).href, {waitUntil:'load'});
        if (response.status() !== 200) throw Error(path+' '+response.status());
        await page.getByRole('heading',{level:1}).waitFor();
        // Fixed observation window on a visible page; no user input or field telemetry.
        await page.waitForTimeout(2500);
        const sample = await page.evaluate(() => ({
          ...window.discoverPaint, responseStart: performance.getEntriesByType('navigation')[0].responseStart,
        }));
        results.push({path,run,...sample});
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }
console.log(JSON.stringify(results,null,2));
