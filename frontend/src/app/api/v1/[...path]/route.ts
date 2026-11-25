import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * There is ONE path from the browser to the API: Nginx sends /api/v1/* straight to the backend
 * (deploy/nginx/default.conf, `location ^~ /api/`), which authenticates the browser by its HttpOnly session cookie
 * and checks the CSRF token itself. The API proxy that used to live here (a second, token-forwarding path that was
 * never on the production route) is removed: this server holds no application token to forward any more. A request
 * that reaches this file was misrouted and gets 404, whatever the environment.
 */
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
