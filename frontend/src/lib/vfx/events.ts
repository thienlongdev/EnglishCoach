/** A decorative event carries no learner data. The visible existing renderer gets first refusal. */
const consumers = new Set<() => boolean>();
export function registerCelebration(consume: () => boolean) {
  consumers.add(consume);
  return () => { consumers.delete(consume); };
}
export function celebrateInWorld(): boolean {
  for (const consume of [...consumers].reverse()) if (consume()) return true;
  return false;
}
