export const ALL_TRANSLATION_DIFFICULTIES_LABEL = 'Tất cả trình độ';

const CANONICAL_DIFFICULTY_LABELS: Record<string, string> = {
  ALL: ALL_TRANSLATION_DIFFICULTIES_LABEL,
  FOUNDATION: 'Cơ bản',
  CORE: 'Nâng cao',
  CHALLENGE: 'Thử thách',
};

function normalizeDisplayOrLegacyLabel(raw?: string | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';

  const upper = trimmed.toUpperCase();
  if (CANONICAL_DIFFICULTY_LABELS[upper]) {
    return CANONICAL_DIFFICULTY_LABELS[upper];
  }

  const lower = trimmed.toLocaleLowerCase('vi-VN');
  if (lower === 'cốt lõi' || lower === 'nâng cao') {
    return 'Nâng cao';
  }
  if (lower === 'cơ bản') {
    return 'Cơ bản';
  }
  if (lower === 'tất cả trình độ') {
    return ALL_TRANSLATION_DIFFICULTIES_LABEL;
  }

  return trimmed;
}

/**
 * Formats user-facing Vietnamese difficulty labels for Writing Translation
 * while keeping internal difficulty codes ('FOUNDATION', 'CORE', 'ALL') intact.
 */
export function formatTranslationDifficultyLabel(
  codeOrBucket?: string | null,
  fallbackDisplayName?: string | null
): string {
  const primary = (codeOrBucket ?? '').trim();
  if (primary) {
    const upper = primary.toUpperCase();
    if (CANONICAL_DIFFICULTY_LABELS[upper]) {
      return CANONICAL_DIFFICULTY_LABELS[upper];
    }
    const normalizedPrimary = normalizeDisplayOrLegacyLabel(primary);
    if (normalizedPrimary !== primary) {
      return normalizedPrimary;
    }
  }

  const fallback = normalizeDisplayOrLegacyLabel(fallbackDisplayName);
  if (fallback) {
    return fallback;
  }

  return primary;
}
