import { NextRequest, NextResponse } from "next/server";
import { generateCsrfToken, readCsrfCookie, CSRF_COOKIE_NAME, CSRF_COOKIE_NAME_SECURE } from "@/lib/server/bff-csrf";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    // Reuse existing cookie or generate new one
    let token = readCsrfCookie(request);
    if (!token) {
        token = generateCsrfToken();
    }

    const response = NextResponse.json({
        csrfToken: token,
        headerName: "X-CSRF-Token"
    });

    const isSecure = request.nextUrl.protocol === "https:" || (process.env.NEXTAUTH_URL || "").startsWith("https://");
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(isSecure ? CSRF_COOKIE_NAME_SECURE : CSRF_COOKIE_NAME, token, {
        path: "/",
        httpOnly: false, // Accessible to client JS for double-submit header attachment
        sameSite: "lax",
        secure: isSecure,
        maxAge: 86400 // 24 hours
    });

    return response;
}
