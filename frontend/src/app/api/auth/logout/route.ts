import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { validateBffCsrf } from '@/lib/server/bff-csrf';
import { backendCandidates, clientIpOf } from '@/lib/server/internal-auth';
import { clearNextAuthSessionCookies, clearSessionCookies } from '@/lib/server/session-cookies';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const csrf = validateBffCsrf(request);
  if (!csrf.valid) return NextResponse.json({ revoked: false }, { status: csrf.status });
  let token;
  try { token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET }); }
  catch { token = null; }
  // Nothing to revoke without a grant (no session, or a cookie that never held one).
  let revoked = !token?.sessionGrant;
  try {
    if (token?.sessionGrant) {
      // The grant authenticates its own revocation; no bearer token is involved.
      const clientIp = clientIpOf(request);
      const response = await fetch(`${backendCandidates()[0]}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(clientIp ? { 'X-Real-IP': clientIp } : {}) },
        body: JSON.stringify({ sessionGrant: token.sessionGrant }),
        signal: AbortSignal.timeout(8000),
      });
      revoked = response.ok;
      if (!revoked) console.warn(`[Logout] Backend revoke HTTP ${response.status}`);
    }
  } catch { /* Cookie termination is independent of backend availability. */ }
  const response = NextResponse.json({ revoked }, { headers: { 'Cache-Control': 'no-store' } });
  // Terminate locally even if server revocation failed: the NextAuth cookie (all chunks) and the API session.
  clearNextAuthSessionCookies(request, response);
  clearSessionCookies(response);
  return response;
}
