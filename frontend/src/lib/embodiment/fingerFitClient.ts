import type { FingerFitJob, FingerFitResult } from './fingerFitJob';

/** One worker per active hand, created on demand and owned by the rig. Latest
 * contact wins; dispose/release/regrip cancels results from the old contact. */
export class FingerFitClient {
  private worker: Worker | null = null;
  private id = 0;
  private resolve: ((result: FingerFitResult | null) => void) | null = null;
  request(job: FingerFitJob) {
    this.cancel();
    return new Promise<FingerFitResult | null>(resolve => {
      try {
        if (!this.worker) {
          this.worker = new Worker(new URL('./fingerFit.worker.ts', import.meta.url), { type: 'module' });
          this.worker.onmessage = (event: MessageEvent<{ id: number; result: FingerFitResult | null }>) => {
            if (event.data.id !== this.id) return;
            const finish = this.resolve; this.resolve = null; finish?.(event.data.result);
          };
          this.worker.onerror = () => this.dispose();
        }
        this.resolve = resolve;
        this.worker.postMessage({ id: this.id, job });
      } catch { resolve(null); this.dispose(); }
    });
  }
  cancel() {
    this.id++; this.resolve?.(null); this.resolve = null;
    this.worker?.postMessage({ id: this.id });
  }
  dispose() {
    this.id++; this.resolve?.(null); this.resolve = null;
    this.worker?.terminate(); this.worker = null;
  }
}
