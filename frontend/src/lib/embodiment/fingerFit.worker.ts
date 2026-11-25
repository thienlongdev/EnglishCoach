import { runFingerFit, type FingerFitJob } from './fingerFitJob';

let generation = 0;
self.onmessage = (event: MessageEvent<{ id: number; job?: FingerFitJob }>) => {
  const current = ++generation, { id, job } = event.data;
  if (!job) return;
  void runFingerFit(job, () => current !== generation).then(result => {
    if (current === generation) self.postMessage({ id, result });
  }).catch(() => { if (current === generation) self.postMessage({ id, result: null }); });
};
