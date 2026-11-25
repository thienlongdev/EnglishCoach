/**
 * Non-secret backend origin candidates for server-side fetches (Server Components and API routes).
 * Keep all credentialed or signing helpers isolated in internal-auth.ts.
 */
export function backendCandidates(): string[] {
    return Array.from(
        new Set(
            [process.env.BACKEND_INTERNAL_URL, "http://backend:8080", "http://localhost:8080"].filter(
                Boolean
            ) as string[]
        )
    );
}
