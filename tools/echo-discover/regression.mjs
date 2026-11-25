import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, request } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { canonical, inspect, publicPaths } from './crawl.mjs';

const base = process.env.DISCOVER_BASE || 'http://127.0.0.1:18492';
const baseline = process.argv.includes('--baseline');
const rows = await inspect(base);
const byPath = new Map(rows.map(row => [row.path, row]));
const http = await request.newContext({ baseURL: base, extraHTTPHeaders: { Host: 'englishcoach.io.vn' } });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const accessibility = [];
try {
  if (!baseline) {
    const sitemap = byPath.get('/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.deepEqual(sitemap.urls.sort(), publicPaths.map(path => new URL(path, canonical).href).sort());
    assert.doesNotMatch(await (await http.get('/sitemap.xml')).text(), /<lastmod>/);
    assert.match(byPath.get('/robots.txt').rules, /Sitemap: https:\/\/englishcoach\.io\.vn\/sitemap.xml/);
    assert.doesNotMatch(byPath.get('/robots.txt').rules, /^Disallow: \/$/m);
    for (const path of publicPaths) {
      const row = byPath.get(path);
      const url = new URL(path, canonical).href;
      assert.equal(row.status, 200, path);
      assert.equal(row.lang, 'vi', path);
      assert.equal(row.h1.length, 1, path);
      assert.ok(row.title && row.description, path);
      assert.deepEqual(row.canonicals.map(value => new URL(value).href), [url], path);
      assert.equal(new URL(row.og).href, url, path);
      assert.equal(row.twitter, 'summary');
      const image = await http.get(new URL(row.image).pathname);
      assert.equal(image.status(), 200);
      assert.match(image.headers()['content-type'], /image\/png/);
      const png = await image.body();
      assert.equal(png.subarray(1,4).toString(), 'PNG');
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [512,512]);
      await image.dispose();
      assert.equal(row.alternates, 0);
      assert.match(row.robots, /\bindex\b/);
      assert.ok(rows.some(source => source.path !== path && publicPaths.includes(source.path) && source.links?.includes(path)), 'orphan '+path);
      if (path === '/') {
        assert.equal(row.schemas[0]['@type'], 'WebSite');
        assert.equal(row.schemas[0].name, 'Echo English Coach');
        assert.ok(row.schemas[0].alternateName.includes('English Coach'));
        assert.ok(publicPaths.filter(p => p.startsWith('/huong-dan/')).every(p => row.links.includes(p)));
      }
      if (path.startsWith('/huong-dan')) {
        const crumbs = row.schemas[0].itemListElement;
        assert.equal(row.schemas[0]['@type'], 'BreadcrumbList');
        assert.equal(crumbs.at(-1).item, url);
        assert.deepEqual(crumbs.map(c => c.position), crumbs.map((_, i) => i+1));
        assert.equal(crumbs.at(-1).name, row.h1[0]);
        assert.deepEqual(crumbs.map(c => [c.name,c.item]), row.crumbs.map(c => [c.name,new URL(c.href ?? path,canonical).href]));
      }
      const preview = await http.get(path, { headers: { Host: 'preview.invalid' } });
      assert.match(await preview.text(), /name="robots" content="noindex, nofollow"/);
      const page = await http.get(path+'?utm_source=local-test');
      assert.ok((await page.text()).includes('rel="canonical" href="'+row.canonicals[0]+'"'));
      assert.match(page.headers()['cache-control'] || '', /no-store|private/);
    }
    for (const key of ['title','description']) assert.equal(new Set(publicPaths.map(p => byPath.get(p)[key])).size, publicPaths.length);
    for (const row of rows.filter(r => r.h1 && r.status === 200 && !publicPaths.includes(r.path))) assert.match(row.robots, /noindex/, row.path);
    const matrix = await readFile(new URL('../../docs/echo-discover/ROUTES.md', import.meta.url), 'utf8');
    for (const [, template, policy] of matrix.matchAll(/^\| `(\/[^\s`]*)` \| ([^|]+?) \| `/gm)) {
      if (policy === 'API' || policy === 'Public') continue;
      const path = template.replace('[[...panel]]', 'overview').replace('[family]', 'toeic')
        .replace(/\[(?:id|slug|formId|attemptId)\]/g, '999999');
      const response = await http.get(path, {maxRedirects:0});
      assert.ok([200, 301, 302, 307, 308, 401, 403, 404].includes(response.status()), template + ' ' + response.status());
      if (response.status() === 200) {
        const body = await response.text();
        assert.match(body, /name="robots" content="noindex/, template);
        assert.doesNotMatch(body, /rel="canonical"/, template);
      }
      await response.dispose();
    }
    assert.equal(byPath.get('/discover-probe-missing').status, 404);
    assert.equal(byPath.get('/?tab=reading').status, 307);
    assert.equal(byPath.get('/?tab=reading').redirect, '/reading');
    assert.equal((await http.get('/huong-dan/bai-khong-ton-tai')).status(),404);
    assert.doesNotMatch(await (await http.get('/sitemap.xml',{ headers:{Host:'preview.invalid'} })).text(), /<loc>/);
    assert.match(await (await http.get('/robots.txt',{ headers:{Host:'preview.invalid'} })).text(), /^Disallow: \/$/m);
    for (const path of ['/profile','/admin/security','/exams/toeic/attempts/123','/games/king-of-english','/echo-anywhere/connect','/?tab=made-up']) {
      const res = await http.get(path,{headers:{'User-Agent':'Googlebot','x-ec-path':'/','x-forwarded-host':'englishcoach.io.vn'}});
      assert.match(await res.text(), /name="robots" content="noindex/, path);
    }
    const a = (await http.get('/')).headers()['content-security-policy'];
    const b = (await http.get('/')).headers()['content-security-policy'];
    assert.match(a,/nonce-/); assert.notEqual(a,b);
    const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width:390, height:844 } });
    try {
      const page = await noScript.newPage();
      for (const path of publicPaths) {
        await page.goto(base+path);
        await page.getByRole('heading', { level:1 }).waitFor();
        assert.ok(await page.locator('h1').isVisible(), path+' must be visible with scripts disabled');
      }
      await page.goto(base);
      await page.getByRole('link',{name:'Hướng dẫn tự học',exact:true}).click();
      await page.getByRole('link',{name:/Thử bài nghe/}).click();
      await page.locator('summary').focus();
      await page.keyboard.press('Enter');
      assert.ok(await page.getByText('I left the books on the table by the window.',{exact:true}).isVisible());
    } finally { await noScript.close(); }
  }
  for (const path of baseline ? publicPaths.slice(0,2) : publicPaths) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(base+path, { waitUntil:'load' });
    await page.locator('h1').first().waitFor();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    for (const v of results.violations) accessibility.push({path,id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)});
    if (path.includes('/huong-dan/')) {
      const summary = page.locator('summary');
      await summary.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('details').getAttribute('open'), '');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile overflow');
      if (path.endsWith('ta')) {
        await page.locator('audio').evaluate(async a => { a.muted = true; await a.play(); a.pause(); });
      }
    }
    await context.close();
  }
  console.log(JSON.stringify({ routes: rows.length, accessibility },null,2));
  if (process.env.DISCOVER_A11Y_OUT) await writeFile(process.env.DISCOVER_A11Y_OUT,JSON.stringify(accessibility,null,2));
  if (!baseline) {
    assert.deepEqual(accessibility.filter(v => ['critical','serious'].includes(v.impact)), []);
  }
} finally { await browser.close(); await http.dispose(); }
