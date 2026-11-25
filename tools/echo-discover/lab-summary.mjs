import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2] || '.lighthouseci';
const measurements = {};
for (const file of (await readdir(dir)).filter(f => /^lhr-.*\.json$/.test(f))) {
  const report = JSON.parse(await readFile(join(dir, file), 'utf8'));
  if (report.runtimeError) throw Error('Incomplete report: ' + file);
  const { audits } = report;
  const route = new URL(report.finalDisplayedUrl || report.finalUrl).pathname;
  (measurements[route] ||= []).push({
    lcpMs: audits['largest-contentful-paint'].numericValue,
    tbtMs: audits['total-blocking-time'].numericValue,
    cls: audits['cumulative-layout-shift'].numericValue,
    scriptBytes: audits['resource-summary'].details.items.find(row => row.resourceType === 'script').transferSize,
    ttfbMs: audits['server-response-time']?.numericValue,
    lcpElement: audits['lcp-breakdown-insight']?.details?.items?.find(item=>item.type==='node')?.nodeLabel,
  });
}
console.log(JSON.stringify(measurements, null, 2));
