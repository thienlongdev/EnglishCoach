export interface CarSpec {
  model: string; name: string; instanceId: string; maxSpeed: number; reverseSpeed: number;
  acceleration: number; braking: number; handling: number; maxSteerRad: number;
  wheelRadius: number; collisionRadius: number; paintHex: string | null;
}
export function getOwnedDrivableCars(state: Pick<import('../game-core/index.mjs').V3State,'progression'>):
  import('../game-core/index.mjs').V3OwnedObject[];
export function getActiveCarSpec(state: {
  progression: { ownedObjects: { instanceId: string; selectedVariantId: string; category: string; customAppearance?: { primaryColor?: string } }[] };
  worldV3: { car: { instanceId?: string }; openRoadPermit: boolean };
}): CarSpec | null;
