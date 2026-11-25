import { chromium, request } from 'playwright';
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';

export const canonical = 'https://englishcoach.io.vn';
export const publicPaths = ['/', '/echo-anywhere', '/huong-dan', '/huong-dan/nghe-chep-chinh-ta', '/huong-dan/hoc-tu-trong-ngu-canh'];
export async function inspect(base, host = 'englishcoach.io.vn') {
  if (!['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('Use a loopback frontend.');
  const http = await request.newContext({ baseURL: base, extraHTTPHeaders: { Host: host }, maxRedirects: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  try {
    const parser = await browser.newPage();
    await parser.route('**/*', route => route.abort());
    const pending = new Set(['/', '/echo-anywhere', '/sitemap.xml', '/robots.txt', '/?tab=reading', '/discover-probe-missing']);
    const rows = [];
    for (const path of pending) {
      const response = await http.get(path, { maxRedirects: 0 });
      const row = { path, status: response.status() };
      const body = await response.text();
      if (response.headers().location) row.redirect = new URL(response.headers().location, base).pathname;
      if (path === '/robots.txt') row.rules = body;
      if (path === '/sitemap.xml' && response.ok()) {
        row.urls = await parser.evaluate(xml => {
          const doc = new DOMParser().parseFromString(xml, 'application/xml');
          if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'urlset') throw Error('Invalid sitemap');
          return Array.from(doc.querySelectorAll('url > loc'), n => n.textContent);
        }, body);
        for (const url of row.urls) if (new URL(url).origin === canonical) pending.add(new URL(url).pathname);
      }
      if (response.headers()['content-type']?.includes('text/html')) {
        Object.assign(row, await parser.evaluate(html => {
          const doc = new DOMParser().parseFromString(html,'text/html');
          const meta = name => doc.querySelector('meta[name="'+name+'"]')?.content;
          return {
            lang: doc.documentElement.lang, title: doc.title, description: meta('description'),
            robots: meta('robots'), canonicals: Array.from(doc.querySelectorAll('link[rel=canonical]'), el => el.getAttribute('href')),
            og: doc.querySelector('meta[property="og:url"]')?.content, image: doc.querySelector('meta[property="og:image"]')?.content,
            twitter: meta('twitter:card'), alternates: doc.querySelectorAll('link[hreflang]').length,
            h1: Array.from(doc.querySelectorAll('h1'), h => h.textContent.trim()),
            schemas: Array.from(doc.querySelectorAll('script[type="application/ld+json"]'), s => JSON.parse(s.textContent)),
            crumbs: Array.from(doc.querySelectorAll('nav[aria-label="Đường dẫn"] li'), li => {
              const label = li.querySelector('a, [aria-current="page"]');
              return {name:label?.textContent.trim(), href:label?.getAttribute('href')};
            }),
            links: Array.from(new Set(Array.from(doc.querySelectorAll('a[href]'), a => a.getAttribute('href')).filter(a => a.startsWith('/') && !a.startsWith('//')))),
          };
        }, body));
        // Traverse editorial pages. Probe linked product entry points without following account actions or enumerating IDs.
        if (publicPaths.includes(path)) for (const href of row.links) {
          const target = new URL(href, canonical);
          if (!target.pathname.startsWith('/api/')) pending.add(target.pathname);
        }
      }
      rows.push(row);
      await response.dispose();
    }
    return rows;
  } finally { await http.dispose(); await browser.close(); }
}
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({options:{out:{type:'string'}}});
  const rows = await inspect(process.env.DISCOVER_BASE || 'http://127.0.0.1:18492');
  const json = JSON.stringify(rows,null,2)+'\n';
  if (values.out) await writeFile(values.out,json); else console.log(json);
}
