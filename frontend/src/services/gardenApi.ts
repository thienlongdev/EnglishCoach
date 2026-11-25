import { apiClient } from '@/services/api-client';
import type {
  GardenAccess, GardenAck, GardenBoostResult, GardenBuildingReceipt, GardenCandidates, GardenCompostReceipt, GardenContributionPage,
  GardenCosmeticEquipResult, GardenCosmeticOrder, GardenCosmeticOrders, GardenCosmeticReceipt, GardenCosmeticShop, GardenCosmeticSlot, GardenDecorResult,
  GardenEchoRewards, GardenFrameReceipt, GardenPremiumRewardReceipt, GardenVoucherReceipt,
  GardenEssenceResult, GardenExpansionReceipt, GardenForestPage, GardenLandReceipt, GardenRewardReceipt,
  GardenGraduationChallenge, GardenGraduationResult, GardenHarvestChallenge, GardenHarvestResult, GardenKnowledgeResult,
  GardenMarketReceipt, GardenMilestonesPage, GardenOrderReceipt, GardenPlantResult, GardenRecords, GardenSellLine, GardenSellResult,
  GardenSkinEquipResult, GardenSkinReceipt, GardenSprayResult, GardenState, GardenSupply, GardenTreatResult,
  GardenActivityPage, GardenDiscoverPage, GardenIsland, GardenReactionReceipt, GardenSocialMe, GardenTakeReceipt, GardenVisibility,
  GardenAnimalReceipt, GardenShareSellResult, GardenTier,
  GardenAdminQaAnimalsReceipt, GardenAdminQaCosmeticsReceipt, GardenAdminQaStatus,
  GardenGuideAck, GardenGuideAction,
} from '@/types/garden';

/**
 * Echo Garden REST client. Every state-changing call carries an `Idempotency-Key` UUID: the caller creates ONE key per
 * player action and passes the same key again when retrying, so a lost response can never execute an action twice
 * (backend `GardenContext#command`).
 */
export const newGardenKey = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const post = <T>(path: string, body: unknown, key: string) =>
  apiClient.post<T>(path, body, { headers: { 'Idempotency-Key': key } }).then(r => r.data);

export const gardenApi = {
  access: () => apiClient.get<GardenAccess>('/garden/access').then(r => r.data),
  state: () => apiClient.get<GardenState>('/garden/state').then(r => r.data),
  // Phase 4: the official administrator's QA access on their own garden (403 for every other account)
  adminQaStatus: () => apiClient.get<GardenAdminQaStatus>('/admin/garden/qa').then(r => r.data),
  adminQaUnlock: (key: string) => post<GardenAdminQaCosmeticsReceipt>('/admin/garden/qa/cosmetics/unlock', {}, key),
  adminQaRevoke: (key: string) => post<GardenAdminQaCosmeticsReceipt>('/admin/garden/qa/cosmetics/revoke', {}, key),
  adminQaProvision: (key: string) => post<GardenAdminQaAnimalsReceipt>('/admin/garden/qa/animals/provision', {}, key),
  adminQaAdvance: (hours: number, key: string) => post<GardenAdminQaAnimalsReceipt>('/admin/garden/qa/animals/advance', { hours }, key),
  onboarding: (step: number, key: string) => post<GardenAck>('/garden/onboarding', { step }, key),
  rewardsSeen: (key: string) => post<GardenAck>('/garden/rewards/seen', {}, key),
  // the voluntary Echo guide: the caller's own decision or progress (version 1 is the only guide)
  guide: (action: GardenGuideAction, step: number, key: string) => post<GardenGuideAck>('/garden/guide', { version: 1, action, step }, key),
  plant: (plotId: number, cropCode: string, key: string) => post<GardenPlantResult>(`/garden/plots/${plotId}/plant`, { cropCode }, key),
  boost: (plantingId: number, itemCode: string, key: string) =>
    post<GardenBoostResult>(`/garden/plantings/${plantingId}/boost`, { itemCode }, key),
  harvestStart: (plantingIds: number[], key: string) => post<GardenHarvestChallenge>('/garden/harvest/start', { plantingIds }, key),
  harvestComplete: (challengeId: string, answers: Array<number | null>, skip: boolean, key: string) =>
    post<GardenHarvestResult>('/garden/harvest/complete', { challengeId, answers, skip }, key),
  sell: (lines: GardenSellLine[], key: string) => post<GardenSellResult>('/garden/sell', { lines }, key),
  // Phase 2: Knowledge Trees, Memory Forest, Forgotten Pests
  candidates: (deckId: number | null, q: string) =>
    apiClient.get<GardenCandidates>('/garden/knowledge/candidates', { params: { deckId: deckId ?? undefined, q: q || undefined } }).then(r => r.data),
  plantTree: (slot: number, flashcardIds: number[], key: string) =>
    post<GardenKnowledgeResult>('/garden/knowledge/plant', { slot, flashcardIds }, key),
  claimEssence: (treeId: number, key: string) => post<GardenEssenceResult>(`/garden/knowledge/${treeId}/essence`, {}, key),
  releaseTree: (treeId: number, key: string) => post<GardenKnowledgeResult>(`/garden/knowledge/${treeId}/release`, {}, key),
  graduationStart: (treeId: number, key: string) =>
    post<GardenGraduationChallenge>(`/garden/knowledge/${treeId}/graduation/start`, {}, key),
  graduationComplete: (challengeId: string, answers: Array<number | null>, key: string) =>
    post<GardenGraduationResult>('/garden/knowledge/graduation/complete', { challengeId, answers }, key),
  forest: (before: number | null) =>
    apiClient.get<GardenForestPage>('/garden/forest', { params: { before: before ?? undefined } }).then(r => r.data),
  spray: (pestId: number, key: string) => post<GardenSprayResult>(`/garden/pests/${pestId}/spray`, {}, key),
  // Phase 3A: market stall, delivery board, bed expansion (the server prices, checks caps and consumes stock)
  marketBuy: (offerCode: string, units: number, key: string) =>
    post<GardenMarketReceipt>('/garden/market/buy', { offerCode, units }, key),
  fillOrder: (orderId: number, lines: GardenSupply[], key: string) =>
    post<GardenOrderReceipt>(`/garden/orders/${orderId}/fill`, { lines }, key),
  expand: (slot: number, compost: GardenSupply[], key: string) =>
    post<GardenExpansionReceipt>('/garden/plots/expand', { slot, compost }, key),
  // Phase 3B: crop skins (the server decides earned vs bought, the price and ownership) and milestone history
  acquireSkin: (skinCode: string, key: string) => post<GardenSkinReceipt>('/garden/skins/acquire', { skinCode }, key),
  equipSkin: (cropCode: string, skinCode: string | null, key: string) =>
    post<GardenSkinEquipResult>('/garden/skins/equip', { cropCode, skinCode }, key),
  milestones: (before: number | null) =>
    apiClient.get<GardenMilestonesPage>('/garden/milestones', { params: { before: before ?? undefined } }).then(r => r.data),
  milestonesSeen: (ids: number[], key: string) => post<{ marked: number }>('/garden/milestones/seen', { ids }, key),
  // Phase 3C: buildings, farmland regions, the compost bin and Echo Rewards (the server owns prices, gates, caps and delivery)
  upgradeBuilding: (code: string, level: number, materials: GardenSupply[], key: string) =>
    post<GardenBuildingReceipt>(`/garden/buildings/${code}/upgrade`, { level, materials }, key),
  buyLand: (slot: number, materials: GardenSupply[], key: string) =>
    post<GardenLandReceipt>('/garden/land/buy', { slot, materials }, key),
  compost: (recipe: string, lines: GardenSupply[], key: string) =>
    post<GardenCompostReceipt>('/garden/warehouse/compost', { recipe, lines }, key),
  redeemReward: (code: string, key: string) => post<GardenRewardReceipt>(`/garden/rewards/${code}/redeem`, {}, key),
  contributionHistory: (before: number | null) =>
    apiClient.get<GardenContributionPage>('/garden/contribution/history', { params: { before: before ?? undefined } }).then(r => r.data),
  // Phase 3D: one farming supply from the storehouse onto a growing crop; lifetime farm records (read only)
  treat: (plantingId: number, itemCode: string, key: string) =>
    post<GardenTreatResult>(`/garden/plantings/${plantingId}/treat`, { itemCode }, key),
  records: () => apiClient.get<GardenRecords>('/garden/records').then(r => r.data),
  // Phase 3E: the cosmetic shop (the server owns the catalogue, prices, earned paths, ownership and every position)
  cosmetics: () => apiClient.get<GardenCosmeticShop>('/garden/cosmetics').then(r => r.data),
  buyCosmetic: (code: string, key: string) => post<GardenCosmeticReceipt>('/garden/cosmetics/buy', { code }, key),
  equipCosmetic: (slot: GardenCosmeticSlot, code: string | null, key: string) =>
    post<GardenCosmeticEquipResult>('/garden/cosmetics/equip', { slot, code }, key),
  placeDecor: (code: string, gx: number, gy: number, key: string) => post<GardenDecorResult>('/garden/decor/place', { code, gx, gy }, key),
  moveDecor: (id: number, gx: number, gy: number, key: string) => post<GardenDecorResult>(`/garden/decor/${id}/move`, { gx, gy }, key),
  storeDecor: (id: number, key: string) => post<GardenDecorResult>(`/garden/decor/${id}/store`, {}, key),
  // Phase 3F: a cosmetic for VND through the existing SePay bank-transfer path. The server owns the price, the transfer
  // reference, the payment window and the delivery; the client only names the item and polls its own order.
  checkoutCosmetic: (kind: 'COSMETIC' | 'SKIN', code: string, key: string) =>
    post<GardenCosmeticOrder>('/garden/cosmetics/checkout', { kind, code }, key),
  cosmeticOrder: (orderId: number) => apiClient.get<GardenCosmeticOrder>(`/garden/cosmetics/orders/${orderId}`).then(r => r.data),
  cosmeticOrders: () => apiClient.get<GardenCosmeticOrders>('/garden/cosmetics/orders').then(r => r.data),
  cancelCosmeticOrder: (orderId: number, key: string) => post<GardenCosmeticOrder>(`/garden/cosmetics/orders/${orderId}/cancel`, {}, key),
  refundCosmeticOrder: (orderId: number, reason: string, key: string) =>
    post<GardenCosmeticOrder>(`/garden/cosmetics/orders/${orderId}/refund`, { reason }, key),
  // Phase 3F: Echo Rewards for Echo Coins (the server owns every rule, cap, budget and the delivery by the owning module)
  echoRewards: () => apiClient.get<GardenEchoRewards>('/garden/rewards/echo').then(r => r.data),
  redeemPremiumReward: (key: string) => post<GardenPremiumRewardReceipt>('/garden/rewards/premium/redeem', {}, key),
  buyVouchers: (pack: string, key: string) => post<GardenVoucherReceipt>('/garden/rewards/vouchers/buy', { pack }, key),
  buyFrame: (slug: string, key: string) => post<GardenFrameReceipt>(`/garden/frames/${slug}/buy`, {}, key),
  // Phase 3G: social islands. Another island is named only by its public handle; the server decides who is listed,
  // what a visitor sees and whether (and how much) may be taken from a ripe crop.
  socialMe: () => apiClient.get<GardenSocialMe>('/garden/social/me').then(r => r.data),
  socialVisibility: (visibility: GardenVisibility, key: string) => post<GardenSocialMe>('/garden/social/visibility', { visibility }, key),
  socialIslands: (cursor: string | null, q: string) =>
    apiClient.get<GardenDiscoverPage>('/garden/social/islands', { params: { cursor: cursor ?? undefined, q: q || undefined } }).then(r => r.data),
  socialVisited: () => apiClient.get<GardenDiscoverPage>('/garden/social/visited').then(r => r.data),
  socialIsland: (handle: string) => apiClient.get<GardenIsland>(`/garden/social/islands/${handle}`).then(r => r.data),
  socialTake: (handle: string, plantingId: number, key: string) =>
    post<GardenTakeReceipt>(`/garden/social/islands/${handle}/take`, { plantingId }, key),
  socialReact: (handle: string, code: string, key: string) =>
    post<GardenReactionReceipt>(`/garden/social/islands/${handle}/react`, { code }, key),
  socialActivity: (before: number | null) =>
    apiClient.get<GardenActivityPage>('/garden/social/activity', { params: { before: before ?? undefined } }).then(r => r.data),
  socialActivitySeen: (key: string) => post<{ ok: boolean; unread: number }>('/garden/social/activity/seen', {}, key),
  // Phase 3H: livestock and guardian pets. Every command acts on the caller's own garden; the server owns time,
  // prices, capacity, growth, production and what a ration or a refill costs.
  animalBuildHouse: (code: string, key: string) => post<GardenAnimalReceipt>(`/garden/animals/houses/${code}/build`, {}, key),
  animalFeedHouse: (code: string, key: string) => post<GardenAnimalReceipt>(`/garden/animals/houses/${code}/feed`, {}, key),
  animalWaterHouse: (code: string, key: string) => post<GardenAnimalReceipt>(`/garden/animals/houses/${code}/water`, {}, key),
  animalCollect: (code: string, key: string) => post<GardenAnimalReceipt>(`/garden/animals/houses/${code}/collect`, {}, key),
  animalBuy: (species: string, key: string) => post<GardenAnimalReceipt>('/garden/animals/buy', { species }, key),
  animalFeedGuardian: (species: string, key: string) => post<GardenAnimalReceipt>(`/garden/animals/guardians/${species}/feed`, {}, key),
  animalMill: (cropCode: string, tier: GardenTier, qty: number, key: string) =>
    post<GardenAnimalReceipt>('/garden/animals/feed/mill', { cropCode, tier, qty }, key),
  animalSellProduct: (code: string, qty: number, key: string) =>
    post<GardenAnimalReceipt>('/garden/animals/products/sell', { code, qty }, key),
  animalCompost: (batches: number, key: string) => post<GardenAnimalReceipt>('/garden/animals/compost', { batches }, key),
  // Phase 3H: harvest portions (fragments of a unit) sold at their proportional value
  sellShares: (lines: Array<{ cropCode: string; tier: GardenTier; portions: number }>, key: string) =>
    post<GardenShareSellResult>('/garden/sell/shares', { lines }, key),
};

/**
 * Rescue review (Phase 2): the EXISTING Flashcard review endpoint, exactly as the Flashcards screen calls it (three
 * ratings). Garden never grades a card itself; it only reads the review the Flashcard module records.
 */
export const reviewFlashcard = (flashcardId: number, quality: 'hard' | 'good' | 'easy') =>
  apiClient.put(`/flashcards/${flashcardId}/review`, null, { params: { quality } }).then(r => r.data);
