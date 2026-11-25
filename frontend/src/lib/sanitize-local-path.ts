const SENTINEL_ORIGIN = 'https://englishcoach.invalid';

/**
 * Rejects backslashes, ASCII control characters, and percent-encoded backslashes or control characters
 * (`%00`-`%1f`, `%5c`, `%7f`), which browsers and proxies can normalize into protocol-relative or external redirects
 * (for example `/\evil.com` or `/%09/evil.com`).
 */
const UNSAFE_RAW_CHARS = /\\|[\x00-\x1f\x7f]/;
const UNSAFE_PERCENT_ENCODED = /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i;

/**
 * Validates and normalizes an internal application path. Returns `null` when the input is missing,
 * malformed, protocol-relative, cross-origin, or contains unsafe characters/encodings.
 */
export function sanitizeOptionalLocalPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (!candidate) return null;
  if (UNSAFE_RAW_CHARS.test(candidate) || UNSAFE_PERCENT_ENCODED.test(candidate)) return null;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;

  try {
    const parsed = new URL(candidate, SENTINEL_ORIGIN);
    if (parsed.origin !== SENTINEL_ORIGIN) return null;
    if (!parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) return null;
    if (UNSAFE_RAW_CHARS.test(parsed.pathname)) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/**
 * Strictly validates that `raw` is a safe same-origin relative path, returning `fallback` otherwise.
 */
export function sanitizeLocalPath(raw: string | null | undefined, fallback = '/'): string {
  return sanitizeOptionalLocalPath(raw) ?? fallback;
}
