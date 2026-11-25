/**
 * Pure function to estimate flashcard review minutes based on due card count.
 * Formula: Math.max(1, Math.ceil(dueCount / 5))
 * Expected mappings:
 *   0 -> 1
 *   1 -> 1
 *   5 -> 1
 *   6 -> 2
 *  15 -> 3
 */
export function estimateReviewMinutes(dueCount: number): number {
  return Math.max(1, Math.ceil(dueCount / 5));
}
