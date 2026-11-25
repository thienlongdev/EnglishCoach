import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 8 * 1024;

/** Origin (scheme + host) of a URL-ish value, or a CSP keyword such as "inline" / "eval"; never a path or query. */
function originOf(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  if (/^(inline|eval|wasm-eval|self|data|blob|trusted-types-policy|trusted-types-sink)$/i.test(value)) return value.toLowerCase();
  try {
    const url = new URL(value);
    return url.protocol === 'data:' || url.protocol === 'blob:' ? url.protocol.slice(0, -1) : url.origin;
  } catch {
    return 'other';
  }
}

function pathOf(value: unknown): string {
  if (typeof value !== 'string') return '-';
  try {
    return new URL(value).pathname.slice(0, 120);
  } catch {
    return '-';
  }
}

function word(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^a-z0-9-]/gi, '').slice(0, 40) || '-' : '-';
}

/**
 * Content-Security-Policy violation reports (report-uri of src/proxy.ts). A bounded, privacy-preserving log sink: at
 * most 8 KB per report, Nginx rate-limits the path, and only the directive, the blocked ORIGIN (never a path, a
 * query or a script sample) and the page PATH are written as one log line. Nothing is stored, nothing is answered.
 */
export async function POST(request: NextRequest) {
  const length = Number(request.headers.get('content-length') || '0');
  if (length > MAX_BYTES) return new NextResponse(null, { status: 413 });
  let text = '';
  try {
    text = await request.text();
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (text.length > MAX_BYTES) return new NextResponse(null, { status: 413 });
  try {
    const parsed = JSON.parse(text);
    const reports = Array.isArray(parsed) ? parsed.slice(0, 5).map((r) => r?.body ?? r) : [parsed?.['csp-report'] ?? parsed];
    for (const r of reports) {
      if (!r || typeof r !== 'object') continue;
      const directive = word(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive']);
      const blocked = originOf(r['blocked-uri'] ?? r.blockedURL);
      const page = pathOf(r['document-uri'] ?? r.documentURL);
      const disposition = word(r.disposition ?? 'enforce');
      console.warn(`[CSP] ${disposition} directive=${directive} blocked=${blocked} page=${page}`);
    }
  } catch {
    // not a report: ignored
  }
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
