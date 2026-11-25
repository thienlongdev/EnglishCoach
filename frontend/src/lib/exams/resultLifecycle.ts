// Submission completion and numeric-score eligibility are separate facts.
export const RESULT_WAIT_MS = 60_000;
export const RESULT_MAX_REQUESTS = 20;

export function resultPhase(value: { artifactId?: string; resultStatus?: string; isCompleted?: boolean; allCompleted?: boolean } | null | undefined): 'RESULT' | 'TERMINAL_WITHOUT_ARTIFACT' | 'PROCESSING' {
  if (value?.artifactId) return 'RESULT';
  if (value?.isCompleted || value?.allCompleted || value?.resultStatus === 'COMPLETED' || value?.resultStatus === 'FAILED' || value?.resultStatus === 'REVIEW_REQUIRED') return 'TERMINAL_WITHOUT_ARTIFACT';
  return 'PROCESSING';
}

export function retryableResultError(status?: number): boolean {
  return status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function resultWaitExpired(requests: number, elapsedMs: number): boolean {
  return requests >= RESULT_MAX_REQUESTS || elapsedMs >= RESULT_WAIT_MS;
}
