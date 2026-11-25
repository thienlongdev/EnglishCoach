/**
 * Step-up for sensitive administrator actions. The backend answers such an action with 403 `STEP_UP_REQUIRED`
 * when the session's second-factor proof is older than its freshness window; the API client then asks the
 * registered prompt (the dialog mounted by the admin layout) and, once the administrator has confirmed the factor,
 * repeats the request. Without a mounted prompt the refusal simply reaches the caller.
 */
type StepUpPrompt = () => Promise<boolean>;

let prompt: StepUpPrompt | null = null;
let pending: Promise<boolean> | null = null;

export function registerStepUpPrompt(next: StepUpPrompt | null) {
  prompt = next;
}

/** True when the administrator confirmed the factor; one dialog however many requests wait for it. */
export function requestStepUp(): Promise<boolean> {
  if (!prompt) return Promise.resolve(false);
  pending = pending || prompt().catch(() => false).finally(() => { pending = null; });
  return pending;
}
