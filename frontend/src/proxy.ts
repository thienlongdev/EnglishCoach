import { NextResponse, type NextRequest } from 'next/server';
import { canonicalHref } from '@/lib/navigation/routes';

/**
 * Per-request script policy (security closure 2026-10). Every page response gets a fresh, unpredictable nonce and a
 * Content-Security-Policy whose script rule is
 *
 *   script-src 'nonce-<n>' 'strict-dynamic' 'self' https: 'unsafe-inline'
 *
 * In every current browser this means: only scripts carrying this response's nonce (Next.js puts it on its own
 * bootstrap scripts, chunks and inline RSC payloads) and the scripts THEY load run; an injected inline script, an
 * injected <script src>, an inline event handler and eval / new Function are refused. ('self' https: 'unsafe-inline'
 * are ignored by such browsers and only keep very old ones working.)
 *
 * Nginx adds a second, origin allow-list policy (deploy/nginx/default.conf). A browser enforces both, so a script
 * must satisfy each: the nonce rule here and the host list there. Next.js reads the nonce from this request header
 * while rendering; that is why every page is rendered per request (`connection()` in the root layout).
 */
export function buildPagePolicy(nonce: string): string {
  return [
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'self' https: 'unsafe-inline'`,
    "object-src 'none'",
    "base-uri 'self'",
    'report-uri /api/csp-report',
  ].join('; ');
}

export function proxy(request: NextRequest) {
  // `/?tab=reading&materialId=4` is the old address of `/reading?materialId=4`. Every old link and stored notification keeps working.
  if (request.nextUrl.pathname === '/' && request.nextUrl.searchParams.has('tab')) {
    const target = canonicalHref(`/${request.nextUrl.search}`);
    if (!target.startsWith('/?')) return NextResponse.redirect(new URL(target, request.nextUrl), 307);
  }

  const nonce = btoa(crypto.randomUUID() + crypto.randomUUID()).replace(/=+$/, '');
  const policy = process.env.NODE_ENV === 'production'
    ? buildPagePolicy(nonce)
    // development: React and the dev overlay use eval
    : buildPagePolicy(nonce).replace("'strict-dynamic'", "'strict-dynamic' 'unsafe-eval'");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // The page's tab title is resolved on the server from this (app/layout.tsx). Always overwritten here; only a key into a fixed table.
  requestHeaders.set('x-ec-path', request.nextUrl.pathname);
  requestHeaders.set('x-ec-tab', request.nextUrl.searchParams.get('tab') ?? '');
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    // pages only: not API routes, not build assets, not public files (anything with a file extension).
    // Prefetch requests are intentionally NOT skipped so every HTML response carries a fresh nonce CSP.
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)',
  ],
};
