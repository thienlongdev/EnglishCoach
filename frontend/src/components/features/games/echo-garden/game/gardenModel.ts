/**
 * Echo Garden gameplay model: pure helpers shared by the React HUD and the Pixi scene (no React, no Pixi, no I/O).
 * The server is the only authority; these helpers only PRESENT its facts (projection between refreshes, copy).
 */
import type { GardenAnimals, GardenIslandAnimals } from "../../../../../types/garden";
import type { AnimalVisuals } from "../world/animalLayer";
import type {
  GardenCrop, GardenEcho, GardenFamily, GardenMilestone, GardenPlanting, GardenRequirement, GardenSeasonFit, GardenSkin,
  GardenSpecies, GardenState, GardenTheme, GardenTier, GardenWeather, GardenContributionEntry, GardenEffect,
  GardenBoost, GardenProtection, GardenShopCategory, GardenSoil, GardenSoilStatus, GardenSupplyEffect, GardenSupplyItem,
} from "../../../../../types/garden";

/** Server crop code → World v2 art species (stage sprites `crop_<art>_s1..4`). */
export const CROP_ART: Record<string, string> = {
  WHEAT: "wheat",
  TOMATO: "tomato",
  CORN: "corn",
  STRAWBERRY: "strawberry",
  ROSE: "rose",
  WATERMELON: "watermelon",
  PUMPKIN: "pumpkin",
  MOONFLOWER: "moonflower",
  FROST_LILY: "frost_lily",
  CRYSTAL_ORCHID: "crystal_orchid",
  QA_SPROUT: "wheat",
};

/**
 * Sprite key for a crop at a visual stage; an unknown species falls back to the wheat art. `skinArt` (Phase 3B): the
 * art key of the cosmetic skin the planting was planted with → `cskin_<art>_s<stage>`; the scene falls back to the base
 * crop sprite when that skin art is missing from the manifest (see `baseCropKey`).
 */
export function cropSpriteKey(cropCode: string, stage: number, skinArt?: string | null): string {
  const s = Math.max(1, Math.min(4, Math.round(stage)));
  if (skinArt && /^[a-z0-9_]+$/.test(skinArt)) return `cskin_${skinArt}_s${s}`;
  const art = CROP_ART[cropCode] ?? "wheat";
  return `crop_${art}_s${s}`;
}

/** The base crop sprite a skin sprite stands in for (missing-art fallback; wind sway family). */
export function baseCropKey(cropCode: string, key: string): string {
  return key.startsWith("cskin_") ? cropSpriteKey(cropCode, Number(key.slice(-1))) : key;
}

export function cropIconUrl(cropCode: string, skinArt?: string | null): string {
  return `/garden/world/${cropSpriteKey(cropCode, 4, skinArt)}.webp`;
}

/** What one bed shows in the world. `null` crop = an empty bed. */
export interface PlotVisual {
  slot: number;
  plotId: number;
  plantingId: number | null;
  cropCode: string | null;
  stage: number;
  ready: boolean;
  watered: boolean;
  fertilized: boolean;
  /** Phase 3B: art key of the planting's skin (null = base crop art). */
  skinArt?: string | null;
  /**
   * Phase 3C: damage stage of the Forgotten Pest on this crop — 1 warning (a caterpillar, nothing else), 2 nibbled
   * leaves, 3 wilting, 0 its word was reviewed (the crop recovers); null / undefined = no pest.
   */
  pestStage?: number | null;
  /** Phase 3D: sprite keys of what lies on / stands over this bed (soil condition, mulch, covers, nets, tags). */
  extras?: string[];
  /** Phase 3D: stressed soil that is slowing the crop right now (the crop sags a little and loses colour). */
  soilStress?: "DRY" | "WET" | null;
}

/** Server clock offset (GDD 03 §16): offset = serverNow − (receivedAt − rtt / 2). */
export function serverOffsetMs(serverNowIso: string, sentAtMs: number, receivedAtMs: number): number {
  const rtt = Math.max(0, receivedAtMs - sentAtMs);
  return Date.parse(serverNowIso) - (receivedAtMs - rtt / 2);
}

/**
 * Projects a growing planting's progress to the current server time (constant speed until the next refresh).
 * Never reports "ready": only the server decides readiness, the client refetches when the countdown ends.
 */
export function projectGrowth(p: GardenPlanting, thresholds: number[], serverNowMs: number, snapshotServerMs: number) {
  if (p.ready) return { stage: 4, progress: 1, remainingSeconds: 0 };
  const elapsed = Math.max(0, (serverNowMs - snapshotServerMs) / 1000);
  const required = Math.max(1, p.requiredSeconds);
  const progress = Math.min(0.999, p.progress + (elapsed * p.speed) / required);
  const stage = progress < thresholds[0] ? 1 : progress < thresholds[1] ? 2 : 3;
  const remainingSeconds = Math.max(0, p.remainingSeconds - elapsed);
  return { stage: Math.max(p.stage, stage), progress, remainingSeconds };
}

/** {@code snapshotFor(plotId)}: server time (ms) at which that plot's planting facts were received. */
export function plotVisuals(state: Pick<GardenState, "plots" | "stageThresholds">, serverNowMs: number, snapshotFor: (plotId: number) => number): PlotVisual[] {
  return state.plots.map((plot) => {
    const p = plot.planting;
    if (!p) {
      return { slot: plot.slot, plotId: plot.id, plantingId: null, cropCode: null, stage: 0, ready: false, watered: false, fertilized: false };
    }
    const g = projectGrowth(p, state.stageThresholds, serverNowMs, snapshotFor(plot.id));
    return {
      slot: plot.slot,
      plotId: plot.id,
      plantingId: p.id,
      cropCode: p.cropCode,
      stage: g.stage,
      ready: p.ready,
      watered: p.waterCount > 0,
      fertilized: p.fertilizer != null,
      skinArt: p.skinArt ?? null,
      pestStage: p.pestStage ?? null,
      extras: bedExtras(p, serverNowMs),
      soilStress: !p.ready && p.soil?.slowing && p.soil.status !== "OK" ? p.soil.status : null,
    };
  });
}

/** "1 giờ 15 phút", "12 phút 30 giây", "45 giây". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h} giờ ${m} phút` : `${h} giờ`;
  if (m > 0) return sec > 0 && m < 10 ? `${m} phút ${sec} giây` : `${m} phút`;
  return `${sec} giây`;
}

/** Local clock time in Vietnam for "Chín lúc 21:40". */
export function clockTime(epochMs: number): string {
  return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" }).format(epochMs);
}

export const THEME_LABEL: Record<GardenTheme, string> = {
  LU_HANH: "Tuần Lữ Hành",
  CONG_SO: "Tuần Công Sở",
  HOC_THUAT: "Tuần Học Thuật",
  THANH_NGU: "Tuần Thành Ngữ",
};

// ------------------------------------------------------------------ Phase 2: seasons, weather, memory

/** Season of the island = the theme week (global calendar). Summer is the approved base world. */
export type Season = "spring" | "summer" | "autumn" | "winter";

export const SEASON_OF_THEME: Record<GardenTheme, Season> = {
  LU_HANH: "spring",
  CONG_SO: "summer",
  HOC_THUAT: "autumn",
  THANH_NGU: "winter",
};

export const SEASON_LABEL: Record<Season, string> = { spring: "Xuân", summer: "Hạ", autumn: "Thu", winter: "Đông" };

/** "Xuân · Tuần Lữ Hành" */
export function seasonTitle(theme: GardenTheme): string {
  return `${SEASON_LABEL[SEASON_OF_THEME[theme]]} · ${THEME_LABEL[theme]}`;
}

export const SPECIES_SEASON: Record<GardenSpecies, Season> = { SPRING: "spring", SUMMER: "summer", AUTUMN: "autumn", WINTER: "winter" };

export const SPECIES_LABEL: Record<GardenSpecies, string> = {
  SPRING: "Anh đào ký ức",
  SUMMER: "Sồi lục ký ức",
  AUTUMN: "Phong vàng ký ức",
  WINTER: "Tùng tuyết ký ức",
};

/** Memory tree sprite (species = the season it was planted in, stage 1–4). */
export function treeSpriteKey(species: GardenSpecies, stage: number): string {
  return `mtree_${SPECIES_SEASON[species]}_s${Math.max(1, Math.min(4, Math.round(stage)))}`;
}

export const TREE_STAGE_LABEL: Record<number, string> = { 1: "Mầm ký ức", 2: "Cây non", 3: "Cây trẻ", 4: "Cây trưởng thành" };

export const HEALTH_LABEL: Record<string, string> = { HEALTHY: "Khỏe mạnh", THIRSTY: "Cần chăm sóc", WILTING: "Đang héo" };

/** Weather label; rain in the winter theme falls as snow (same rule, same effect). */
export function weatherLabel(w: Pick<GardenWeather, "kind" | "theme">): string {
  if (w.kind === "RAINBOW") return "Cầu vồng";
  if (w.kind === "RAIN") return w.theme === "THANH_NGU" ? "Tuyết rơi" : "Mưa";
  return "Nắng";
}

export function weatherEffect(w: Pick<GardenWeather, "kind" | "growthFactor">, rainbowMutation: number): string {
  if (w.kind === "RAIN") return `Cây lớn nhanh hơn ${Math.round((w.growthFactor - 1) * 100)}%`;
  if (w.kind === "RAINBOW") return `Thu hoạch lúc này: ${Math.round(rainbowMutation * 100)}% cơ hội đột biến`;
  return "Thời tiết bình thường";
}

/** Blockers of a graduation in plain Vietnamese. */
export const BLOCKER_LABEL: Record<string, string> = {
  AGE: "Cây cần đủ 14 ngày tuổi",
  STAGE: "Cây chưa trưởng thành",
  CARD_LOST: "Có từ đã bị xoá khỏi bộ thẻ",
  CARD_OVERDUE: "Có từ đang quá hạn ôn",
  CARD_NEW: "Có từ chưa được học lần nào",
  CARD_EVIDENCE: "Mỗi từ cần được ôn ít nhất 2 ngày khác nhau",
  PEST: "Một Sâu Lãng Quên đang bám trên cây",
  RETRY_WAIT: "Cây đang nghỉ trước lần thử lại",
};

export interface SeedAdvice {
  tone: "good" | "info" | "warn";
  text: string;
}

/**
 * Contextual advice for a seed right now — a few honest facts the player can weigh, never "the best crop". Pure: the
 * server already computed `growSecondsNow` with the season and the revealed forecast.
 */
export function seedAdvice(crop: GardenCrop, state: Pick<GardenState, "world">, serverNowMs: number): SeedAdvice[] {
  const out: SeedAdvice[] = [];
  const world = state.world;
  const endsMs = Date.parse(world.themeEndsAt);
  if (crop.season !== "ALL") {
    const season = SEASON_LABEL[SEASON_OF_THEME[crop.season as GardenTheme]];
    if (crop.seasonFitNow === "IN_SEASON") out.push({ tone: "good", text: `Đúng mùa ${season}: lớn nhanh, chất lượng cao` });
    else out.push({ tone: "warn", text: `Hợp mùa ${season}: bây giờ lớn chậm hơn` });
  }
  if (crop.growSecondsNow > 0) {
    const readyMs = serverNowMs + crop.growSecondsNow * 1000;
    if (crop.season !== "ALL" && crop.seasonFitNow === "IN_SEASON" && readyMs > endsMs) {
      out.push({ tone: "info", text: "Chín sau khi sang mùa mới, vẫn tính đúng mùa vì gieo trong mùa" });
    }
    const rainSoon = world.forecast.slice(1).some((w) => w.kind === "RAIN" && Date.parse(w.startsAt) < readyMs);
    if (world.weather.kind === "RAIN") out.push({ tone: "good", text: `${weatherLabel(world.weather)} đang giúp cây lớn nhanh` });
    else if (rainSoon) out.push({ tone: "info", text: "Sắp có mưa trong lúc cây lớn" });
    if (crop.growSecondsNow <= 2 * 3600) out.push({ tone: "info", text: "Chín nhanh, hợp lần ghé ngắn" });
    else if (crop.growSecondsNow >= 8 * 3600) out.push({ tone: "info", text: "Lâu chín, hợp khi bạn vắng nhà" });
  }
  return out.slice(0, 3);
}

export const SEASON_FIT_LABEL: Record<GardenSeasonFit, string | null> = {
  IN_SEASON: "Đúng mùa",
  OFF_SEASON: "Sai mùa",
  ALL_SEASON: null,
};

export const TIER_LABEL: Record<GardenTier, string> = { NORMAL: "Normal", GOOD: "Good", PERFECT: "Perfect", GOLDEN: "Golden" };

export const STAGE_LABEL: Record<number, string> = { 1: "Mầm vừa nhú", 2: "Cây non", 3: "Đang ra hoa, kết trái", 4: "Đã chín" };

export const FORM_LABEL: Record<string, string> = {
  NORMAL: "Normal", GOOD: "Good", PERFECT: "Perfect", GOLDEN: "Golden", MOONLIT: "Ánh trăng", MUTATED: "Đột biến",
  RAINBOW: "Cầu vồng",
};

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(Math.round(n));
}

/** Server error codes → Vietnamese sentences (GDD 03 §12): say what happened and how to fix it. */
export function errorMessage(code: string | undefined, details?: Record<string, unknown>): string {
  switch (code) {
    case "NOT_READY": return "Cây chưa chín.";
    case "ALREADY_HARVESTED": return "Ô này vừa được thu hoạch.";
    case "ALREADY_READY": return "Cây đã chín, hãy thu hoạch.";
    case "PLOT_OCCUPIED": return "Ô đất đang có cây.";
    case "PLOT_LOCKED": return "Ô đất chưa mở.";
    case "NO_SEED": return "Bạn chưa có hạt này.";
    case "NO_ITEM": return "Bạn đã hết vật phẩm này.";
    case "BOOST_LIMIT": return "Cây này đã được tưới hoặc bón tối đa.";
    case "CROP_LOCKED": return `Mở loại cây này ở Cấp ${details?.level ?? "cao hơn"}.`;
    case "CHALLENGE_EXPIRED": return "Câu hỏi đã hết hạn, thu hoạch lại để nhận câu mới.";
    case "CHALLENGE_DONE": return "Đợt thu hoạch này đã hoàn tất.";
    // Phase 3F: VND checkout, Echo Rewards, profile frames
    case "CHECKOUT_DISABLED": return "Thanh toán bằng chuyển khoản chưa mở. Bạn vẫn có thể mua bằng Đồng Echo.";
    case "CHECKOUT_UNAVAILABLE": return "Món này không bán bằng chuyển khoản.";
    case "CHECKOUT_PROVIDER_FAILED": return "Chưa tạo được mã thanh toán. Hãy thử lại sau ít phút.";
    case "ORDER_NOT_FOUND": return "Không tìm thấy đơn thanh toán này.";
    case "REFUND_NOT_PAID": return "Chỉ đơn đã thanh toán và đã giao mới có thể hoàn tiền.";
    case "REFUND_EXISTS": return "Đơn này đã có yêu cầu hoàn tiền.";
    case "REFUND_WINDOW_OVER": return "Đã quá thời hạn yêu cầu hoàn tiền của đơn này.";
    case "REFUND_ITEM_USED": return "Món này đã được dùng trên đảo nên không thể yêu cầu hoàn tiền.";
    case "REWARD_CLOSED": return "Phần thưởng này chưa mở. Bạn không bị trừ Đồng Echo.";
    case "REWARD_BUDGET_EXHAUSTED": return "Suất đổi thưởng của tháng này đã hết. Hãy quay lại vào tháng sau.";
    case "PREMIUM_ACTIVE": return "Bạn đang có Premium. Phần thưởng chỉ đổi được khi Premium hiện tại đã hết hạn.";
    case "REWARD_WINDOW_LIMIT": return `Bạn đã đổi đủ ${Number(details?.max ?? 3)} lần trong 365 ngày gần nhất.`;
    case "REWARD_COOLDOWN": return "Chưa đủ thời gian chờ kể từ khi phần thưởng trước hết hạn.";
    case "REWARD_LEARNING_DAYS": return `Cần ${Number(details?.need ?? 15)} ngày học trong 30 ngày gần nhất (bạn có ${Number(details?.have ?? 0)}).`;
    case "VOUCHER_CAP": return `Mỗi 30 ngày chỉ mua được tối đa ${Number(details?.cap ?? 10)} Phiếu AI (bạn đã mua ${Number(details?.bought ?? 0)}).`;
    case "VOUCHER_PACK_NOT_FOUND": return "Không có gói Phiếu AI này.";
    case "FRAME_OWNED": return "Bạn đã có khung này rồi.";
    case "FRAME_NOT_FOR_SALE": return "Khung này chỉ nhận được bằng thành tựu, không bán.";
    case "FRAME_NOT_FOUND": return "Không tìm thấy khung này.";
    case "INSUFFICIENT_FUNDS": return `Bạn còn thiếu ${formatNumber(Number(details?.missing ?? 0))} Đồng Echo. Bán nông sản trong Kho để có thêm.`;
    case "INSUFFICIENT_ESSENCE": return `Bạn còn thiếu ${formatNumber(Number(details?.missing ?? 0))} Tinh chất Ký Ức. Chăm Cây Ký Ức để thu thêm.`;
    case "TREE_NEEDS_FIVE_CARDS": return "Cây Ký Ức cần đúng 5 thẻ khác nhau.";
    case "SLOT_LOCKED": return `Chỗ trồng này mở ở Cấp ${details?.level ?? "cao hơn"}.`;
    case "SLOT_OCCUPIED": return "Chỗ trồng này đã có cây.";
    case "CARD_NOT_FOUND": return "Có thẻ không còn trong bộ thẻ của bạn.";
    case "CARD_BOUND": return "Có thẻ đang thuộc một Cây Ký Ức khác.";
    case "CARD_NO_MEANING": return "Có thẻ chưa có nghĩa tiếng Việt, hãy chọn thẻ khác.";
    case "TREE_NEEDS_CARE": return "Hãy ôn những từ cần chú ý trước, cây khỏe mới cho Tinh chất.";
    case "ESSENCE_NOT_READY": return "Cây chưa tích đủ 1 Tinh chất.";
    case "TREE_NOT_ACTIVE": return "Cây này không còn ở chỗ trồng.";
    case "TREE_NOT_FOUND": return "Không tìm thấy cây.";
    case "GRADUATION_NOT_READY": return "Cây chưa sẵn sàng tốt nghiệp.";
    case "CHALLENGE_UNAVAILABLE": return "Chưa tạo được câu hỏi, hãy thử lại sau ít phút.";
    case "PEST_NEEDS_REVIEW": return "Hãy ôn từ này trước, Sâu Lãng Quên chỉ rời đi khi bạn thật sự ôn lại.";
    case "PEST_GONE": return "Sâu Lãng Quên đã rời đi.";
    case "PEST_NOT_FOUND": return "Không tìm thấy Sâu Lãng Quên này.";
    case "OFFER_UNAVAILABLE": return "Quầy đã đổi hàng theo ngày mới. Hãy xem lại quầy hôm nay.";
    case "OFFER_LOCKED": return `Món này mở ở Cấp ${details?.level ?? "cao hơn"}.`;
    case "MARKET_CAP": return "Hôm nay bạn đã mua hết lượt cho món này. Quầy bổ sung hàng lúc 0 giờ.";
    case "ORDER_NOT_FOUND": return "Không tìm thấy đơn hàng này.";
    case "ORDER_DONE": return "Đơn này đã giao xong.";
    case "ORDER_EXPIRED": return "Đơn đã hết hạn. Nông sản của bạn vẫn còn nguyên trong Kho.";
    case "ORDER_LINES_MISMATCH": return "Số nông sản giao chưa khớp đơn. Hãy mở lại đơn để xem số mới nhất.";
    case "ORDER_TIER_TOO_LOW": return `Đơn này cần nông sản hạng ${details?.minTier === "GOOD" ? "Good" : String(details?.minTier ?? "")} trở lên.`;
    case "EXPANSION_LEVEL": return `Luống này mở ở Cấp ${details?.level ?? "cao hơn"}.`;
    case "EXPANSION_ORDER": return "Hãy mở luống trước đó trước.";
    case "EXPANSION_NOT_FOUND": return "Không có luống mở rộng ở ô này.";
    case "COMPOST_MISMATCH": return "Nông sản ủ đất chưa đủ hoặc chưa khớp. Hãy mở lại để xem số mới nhất.";
    case "PLOT_ALREADY_OPEN": return "Luống này đã mở.";
    case "BUILDING_NOT_FOUND": return "Không tìm thấy công trình này.";
    case "BUILDING_MAX": return "Công trình này đã ở cấp cao nhất.";
    case "BUILDING_ORDER": return "Công trình nâng từng cấp một. Hãy mở lại để xem cấp tiếp theo.";
    case "BUILDING_LEVEL": return `Cấp công trình này mở khi nông trại đạt Cấp ${details?.level ?? "cao hơn"}.`;
    case "MATERIALS_MISMATCH": return "Nông sản góp vào chưa đủ hoặc chưa khớp. Hãy mở lại để xem số mới nhất.";
    case "LAND_NOT_FOUND": return "Không có luống mở rộng ở ô này.";
    case "LAND_FULL": return "Nông trại đã dùng hết đất canh tác trên đảo.";
    case "LAND_REGION_LOCKED": return "Khu đất này chưa mở. Chạm vào ô đất để xem điều kiện còn thiếu.";
    case "COMPOST_LOCKED": return "Cần nâng cấp Kho Nông Trại để ủ loại phân này.";
    case "COMPOST_CAP": return "Thùng ủ hôm nay đã đầy. Mai có lượt mới lúc 0 giờ.";
    // Phase 3H: livestock and guardian pets
    case "ANIMALS_CLOSED": return "Chuồng trại chưa mở trên máy chủ này.";
    case "HOUSE_NOT_FOUND": case "ANIMAL_NOT_FOUND": case "PRODUCT_NOT_FOUND": return "Không tìm thấy mục này trong chuồng trại của bạn.";
    case "HOUSE_LEVEL": return `Chuồng này mở ở Cấp ${details?.minLevel ?? "cao hơn"}.`;
    case "HOUSE_BUILT": return "Bạn đã dựng chuồng này rồi.";
    case "HOUSE_NOT_BUILT": return "Hãy dựng chuồng trước đã.";
    case "HOUSE_FULL": return `Chuồng đã đủ ${details?.capacity ?? 3} con.`;
    case "ANIMAL_LEVEL": return `Bạn canh vườn này nhận nuôi được từ Cấp ${details?.minLevel ?? "cao hơn"}.`;
    case "GUARDIAN_OWNED": return "Bạn đã nuôi bạn canh vườn này rồi.";
    case "NO_ANIMALS": return "Chuồng chưa có con vật nào.";
    case "NO_FEED": return `Thiếu cám: cần ${details?.needed ?? ""} phần, bạn có ${details?.held ?? 0}. Xay nông sản thành cám trong mục Chuồng trại.`;
    case "NO_WATER": return "Hết nước giếng. Mua Nước giếng ở Quầy Chợ Echo để đổ đầy máng.";
    case "ANIMALS_FULL": return "Các con vật đều đang no, chưa cần cho ăn thêm.";
    case "TROUGH_FULL": return "Máng nước còn đầy, chưa cần đổ thêm.";
    case "NOTHING_READY": return "Chưa có sản phẩm nào để thu.";
    case "NOT_MILLABLE": return "Loại nông sản này không xay thành cám được.";
    case "NOT_SELLABLE": return "Sản phẩm này không bán được.";
    case "COMPOST_UNITS": return `Mỗi mẻ ủ cần đúng ${details?.units ?? ""} nông sản.`;
    case "COMPOST_TIER_TOO_LOW": return `Mẻ ủ này cần nông sản hạng ${details?.minTier === "GOOD" ? "Good" : String(details?.minTier ?? "")} trở lên.`;
    case "REWARDS_CLOSED": return "Quầy Quà Echo chưa mở. Điểm đóng góp của bạn vẫn được ghi lại đầy đủ.";
    case "REWARD_NOT_FOUND": return "Không tìm thấy món quà này.";
    case "REWARD_UNAVAILABLE": return "Món quà này chưa thể đổi.";
    case "REWARD_LOCKED": return details?.reason === "GARDEN_DAYS"
      ? `Quà này mở sau ${details?.need ?? ""} ngày kể từ khi bạn có vườn.`
      : `Quà này cần ${details?.need ?? ""} ngày học đã xác nhận.`;
    case "REWARD_LIMIT": return "Bạn đã đổi đủ số lượt cho món quà này.";
    case "REWARD_OWNED": return "Bạn đã có món quà này.";
    case "REWARD_SOLD_OUT": return "Món quà này đã hết lượt đổi.";
    case "INSUFFICIENT_CONTRIBUTION": return `Bạn còn thiếu ${formatNumber(Number(details?.missing ?? 0))} điểm đóng góp.`;
    case "COSMETICS_CLOSED": return "Cửa hàng trang trí chưa mở cho khu vườn này.";
    case "COSMETIC_NOT_FOUND": return "Không tìm thấy món trang trí này trong bộ sưu tập của bạn.";
    case "COSMETIC_OWNED": return "Bạn đã có đủ món này.";
    case "COSMETIC_LOCKED": return details?.reason === "LEARNING"
      ? `Món này mở khi bạn có ${details?.need ?? ""} ngày học đã xác nhận (hiện có ${details?.have ?? 0}).`
      : details?.reason === "HARVESTS"
        ? `Món này mở khi bạn đã thu hoạch ${formatNumber(Number(details?.need ?? 0))} lần (hiện có ${formatNumber(Number(details?.have ?? 0))}).`
        : `Món này mở khi bạn có ${details?.need ?? ""} Cây Ký Ức tốt nghiệp.`;
    case "COSMETIC_SLOT_MISMATCH": return "Món này không dùng được cho vị trí đó.";
    case "COSMETIC_NOT_PLACEABLE": return "Món này được mặc cho đảo, không đặt như vật trang trí.";
    case "DECOR_NOT_FOUND": return "Không tìm thấy vật trang trí này trên đảo.";
    case "DECOR_NONE_STORED": return "Mọi chiếc bạn có đều đang được bày. Hãy cất bớt một chiếc hoặc mua thêm.";
    case "DECOR_OUT_OF_BOUNDS": return "Chỗ này không đặt được. Hãy chọn một điểm trong vùng sáng.";
    case "DECOR_OVERLAP": return "Chỗ này sát một vật trang trí khác quá.";
    case "DECOR_OFF_GRID": return "Hãy chọn lại vị trí.";
    case "DECOR_LIMIT": return `Đảo chỉ bày được ${details?.max ?? ""} vật trang trí cùng lúc. Hãy cất bớt một món.`;
    case "CHECKOUT_DISABLED": return "Mua trực tiếp bằng tiền thật chưa mở.";
    case "CHECKOUT_UNAVAILABLE": return "Món này chưa bán trực tiếp.";
    case "SKIN_NOT_FOUND": return "Không tìm thấy giống cây này trong bộ sưu tập của bạn.";
    case "SKIN_OWNED": return "Bạn đã có giống cây này.";
    case "SKIN_LOCKED": return details?.reason === "REWARD" ? "Giống này chỉ có ở quầy Quà Echo."
      : details?.reason === "LEARNING"
      ? `Giống này mở khi bạn có ${details?.days ?? ""} ngày học đã xác nhận.`
      : `Giống này mở ở bậc thành thạo ${MASTERY_LABEL[Number(details?.tier ?? 0)] ?? ""}.`;
    case "SKIN_CROP_MISMATCH": return "Giống này thuộc loại cây khác.";
    case "CROP_NOT_FOUND": return "Không tìm thấy loại cây này.";
    case "FARMING_CLOSED": return "Vật tư chăm cây chưa mở cho khu vườn này.";
    case "ITEM_NOT_FOUND": return "Không tìm thấy vật tư này.";
    case "TREATMENT_NOT_NEEDED": return "Cây này được gieo theo luật cũ: không cần chăm đất, cứ để cây chín như thường.";
    case "TREATMENT_ACTIVE": return details?.expiresAt
      ? `Vật tư này vẫn đang có tác dụng đến ${clockTime(Date.parse(String(details.expiresAt)))}.`
      : "Vật tư này vẫn đang có tác dụng trên cây.";
    case "TREATMENT_USED": return "Mỗi vụ chỉ dùng vật tư này một lần cho một cây.";
    case "SOIL_TOO_WET": return "Đất đã đủ ẩm, tưới thêm cũng chảy đi hết. Hãy để dành cho lúc đất khô.";
    case "NO_PEST": return "Cây này không có Sâu Lãng Quên chưa ôn, không cần xịt.";
    // Phase 3G: social islands
    case "SOCIAL_CLOSED": return "Quần đảo bạn bè chưa mở cho khu vườn này.";
    case "ISLAND_NOT_FOUND": return "Đảo này không còn mở cửa đón khách.";
    case "OWN_ISLAND": return "Đây là đảo của chính bạn.";
    case "PLANTING_NOT_FOUND": return "Cây này không còn trên luống.";
    case "SEARCH_TOO_SHORT": return `Hãy nhập ít nhất ${Number(details?.min ?? 2)} ký tự để tìm.`;
    case "VISIT_FIRST": return "Hãy ghé thăm đảo trước khi để lại lời nhắn.";
    case "REACTION_COOLDOWN": return "Hôm nay bạn đã gửi lời nhắn cho đảo này rồi.";
    case "THIEF_PRIVATE": case "THIEF_NEW": case "THIEF_REOPENED": case "THIEF_LIMIT": case "PAIR_LIMIT":
    case "ISLAND_NEW": case "ISLAND_SHIELD": case "VICTIM_LIMIT": case "ISLAND_GUARDED":
    case "CROP_EXCLUDED": case "CROP_FRESH": case "CROP_TAKEN": case "NOT_ENOUGH_YIELD":
      return takeReasonText(code, typeof details?.availableAt === "string" ? details.availableAt : null);
    case "IDEMPOTENCY_KEY_REUSED": return "Yêu cầu không hợp lệ, hãy thử lại.";
    case "RATE_LIMITED": return "Bạn thao tác hơi nhanh, chờ một chút rồi thử lại.";
    case "GARDEN_BUSY": return "Đảo đang rất đông người chơi. Bạn chờ vài giây rồi thử lại nhé, vườn của bạn vẫn nguyên vẹn.";
    case "ADMIN_QA_FORBIDDEN": return "Chức năng thử nghiệm này chỉ dành cho quản trị viên chính thức.";
    case "ADMIN_QA_CLOSED": return "Chức năng thử nghiệm của quản trị viên chưa sẵn sàng trên máy chủ này.";
    case "ADMIN_QA_HOURS": return `Mỗi lần chỉ tua được từ 1 đến ${details?.max ?? 72} giờ chăm sóc.`;
    case "GARDEN_NOT_FOUND": return "Khu vườn chưa mở cho tài khoản này.";
    case "NETWORK": return "Mất kết nối tới máy chủ. Kiểm tra mạng rồi thử lại.";
    default: return "Máy chủ đang bận, hãy thử lại sau ít phút.";
  }
}

// ------------------------------------------------------------------ Phase 3G: social islands

/** "15:42" today, "15:42 · 12/10" on another day (the viewer's own time zone). */
export function momentText(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${time} · ${two(d.getDate())}/${two(d.getMonth() + 1)}`;
}

/**
 * Why a "take a little" is refused, in the player's words (the server names the rule; `availableAt` = when it ends).
 * Covers the taker's own standing, the island's protection and the crop.
 */
export function takeReasonText(reason: string | null | undefined, availableAt?: string | null): string {
  const until = availableAt ? ` Mở lại lúc ${momentText(availableAt)}.` : "";
  switch (reason) {
    case "THIEF_PRIVATE": return "Đảo của bạn đang đóng cửa, nên bạn cũng chưa thể lấy nông sản ở đảo khác.";
    case "THIEF_NEW": return `Đảo của bạn đang trong thời gian bảo vệ tân thủ, nên bạn cũng chưa thể lấy nông sản ở đảo khác.${until}`;
    case "THIEF_REOPENED": return `Bạn vừa mở cửa đảo trở lại, cần chờ một ngày trước khi lấy nông sản ở đảo khác.${until}`;
    case "THIEF_LIMIT": return `Hôm nay bạn đã lấy đủ số lần cho phép.${until}`;
    case "PAIR_LIMIT": return `Bạn đã lấy ở đảo này trong 24 giờ qua.${until}`;
    case "ISLAND_NEW": return `Đảo này mới gia nhập quần đảo và đang được bảo vệ.${until}`;
    case "ISLAND_SHIELD": return `Đảo này vừa bị lấy nông sản nên đang được bảo vệ.${until}`;
    case "VICTIM_LIMIT": return `Đảo này đã bị lấy đủ số lần trong 24 giờ và đang được bảo vệ.${until}`;
    case "ISLAND_GUARDED": return `Chó canh vườn của đảo này đang canh gác.${until}`;
    case "PRIVATE": return "Đảo đang đóng cửa: không ai tìm thấy, ghé thăm hay lấy nông sản.";
    case "CROP_EXCLUDED": return "Loại cây này được bảo vệ, không ai lấy được.";
    case "NOT_READY": return "Cây chưa chín.";
    case "CROP_FRESH": return `Cây vừa chín, chủ đảo được ưu tiên thu hoạch trước.${until}`;
    case "CROP_TAKEN": return "Cây này đã bị lấy một ít rồi, phần còn lại thuộc về chủ đảo.";
    case "NOT_ENOUGH_YIELD": return "Cây này không đủ để chia nhỏ.";
    case "ALREADY_HARVESTED": return "Chủ đảo vừa thu hoạch cây này.";
    default: return "Chưa thể lấy lúc này.";
  }
}

/** Preset reactions a visitor may leave (codes from the server; no free text exists). */
export const REACTION_LABEL: Record<string, string> = {
  GARDEN_BEAUTIFUL: "Khu vườn đẹp quá!",
  GOOD_HARVEST: "Chúc mùa màng bội thu!",
  GREAT_TREE: "Cây Tri Thức của bạn thật ấn tượng!",
};

/** "1/10 nông sản" — a harvest portion count against the portions of one produce unit. */
export function portionText(portions: number, unit: number): string {
  return `${portions} phần (${portions}/${unit} của một nông sản)`;
}

/** Item code → Vietnamese name (care items, seeds `SEED:<crop>`), for market offers and order rewards. */
export function itemLabel(code: string, crops: Pick<GardenCrop, "code" | "nameVi">[]): string {
  if (code === "WATER") return "Nước";
  if (code === "FERTILIZER") return "Phân bón";
  if (code === "FERTILIZER_PREMIUM") return "Phân bón Thượng hạng";
  if (SUPPLY_INFO[code]) return SUPPLY_INFO[code].title;
  if (code.startsWith("SEED:")) return `Hạt ${crops.find((c) => c.code === code.slice(5))?.nameVi ?? code.slice(5)}`;
  return code;
}

/** "còn 5 giờ 12 phút" until an instant (server time). */
export function timeLeft(untilIso: string, serverNowMs: number): string {
  return formatDuration(Math.max(0, (Date.parse(untilIso) - serverNowMs) / 1000));
}

/** Errors worth retrying with the SAME idempotency key (the action may or may not have been applied). */
export function retryable(status: number | undefined): boolean {
  return status === undefined || status === 0 || status >= 500;
}

// ------------------------------------------------------------------ Phase 3B: monument, mastery, skins, Echo

/** The monument's eras: design stages of ONE tree, never language levels. */
export const ERA_LABEL: Record<number, string> = {
  0: "Cây Tri Thức", 1: "Cây Thức Giấc", 2: "Cây Tỏa Bóng", 3: "Cây Ngàn Lá", 4: "Cổ Thụ Ký Ức",
};

export const ERA_NOTE: Record<number, string> = {
  0: "Dáng cây ban đầu của hòn đảo.",
  1: "Tán dày hơn, hoa ký ức nở, chữ thứ tư hiện trên thân.",
  2: "Thân to hơn, thêm hai cành lớn mang tán riêng.",
  3: "Thêm một tầng tán trên cao, dây hoa rủ và rễ vòm.",
  4: "Tán cổ thụ vươn cao, hoa pha lê và vòng chữ ký ức quanh thân.",
};

export interface FamilyInfo { label: string; ornament: string; activity: string; route: string; cta: string }

/** Skill branches: the ornament each grows and the REAL English Coach route that feeds it. */
export const FAMILY_INFO: Record<GardenFamily, FamilyInfo> = {
  VOCABULARY: { label: "Từ vựng", ornament: "Lá Sáng", activity: "ôn thẻ từ vựng", route: "/flashcards", cta: "Ôn thẻ" },
  LISTENING: { label: "Nghe", ornament: "Chuông Pha Lê", activity: "luyện chép chính tả", route: "/listening", cta: "Luyện nghe" },
  SPEAKING: { label: "Nói", ornament: "Hoa Ngân", activity: "luyện nói nhại câu", route: "/speaking", cta: "Luyện nói" },
  WRITING: { label: "Viết", ornament: "Lá Thư", activity: "hoàn thành bài viết", route: "/writing", cta: "Luyện viết" },
  EXAM: { label: "Luyện đề", ornament: "Ấn Ký Ức", activity: "nộp một bài luyện đề", route: "/exams", cta: "Luyện đề" },
};

export const MASTERY_LABEL: Record<number, string> = {
  0: "Chưa trồng", 1: "Vụ đầu", 2: "Quen tay", 3: "Thành thạo", 4: "Chuyên canh", 5: "Bậc thầy",
};

/** "Thu hoạch 12/30" — one requirement of a mastery tier or an era in plain Vietnamese. */
export function requirementText(r: GardenRequirement): string {
  const have = Math.min(r.have, r.need);
  switch (r.code) {
    case "DAYS": return `Ngày học đã xác nhận ${formatNumber(have)}/${formatNumber(r.need)}`;
    case "GRADUATIONS": return `Cây Ký Ức tốt nghiệp ${have}/${r.need}`;
    case "BRANCHES": return `Bậc nhánh kỹ năng ${have}/${r.need}`;
    case "HARVESTS": return `Thu hoạch ${formatNumber(have)}/${formatNumber(r.need)}`;
    case "QUALITY": return r.met ? "Đã có nông sản Perfect" : "Cần một lần thu đạt Perfect";
    case "SEASONS": return `Thu hoạch ở ${have}/${r.need} mùa khác nhau`;
    case "FORMS": return `Khám phá ${have}/${r.need} dạng`;
    default: return `${have}/${r.need}`;
  }
}

/** How a skin is obtained, in one honest sentence. */
export function skinRequirement(s: GardenSkin, cropName: string): string {
  if (s.unlockKind === "COIN") {
    return s.masteryTier > 0 && !s.masteryOk ? `Thu hoạch ${cropName} một lần để quầy bán giống này` : `Mua bằng ${formatNumber(s.coinPrice)} Đồng Echo`;
  }
  if (s.unlockKind === "LEARNING") return `Phần thưởng cho ${s.learningDays} ngày học đã xác nhận`;
  if (s.unlockKind === "REWARD") return "Đổi bằng điểm đóng góp ở quầy Quà Echo";
  return `Phần thưởng bậc ${MASTERY_LABEL[s.masteryTier]} của ${cropName}`;
}

export function milestoneText(m: Pick<GardenMilestone, "kind" | "code" | "tier">, cropName: (code: string) => string, skinName: (code: string) => string): string {
  switch (m.kind) {
    case "ERA": return `Cây Tri Thức bước sang kỷ ${m.tier}: ${ERA_LABEL[m.tier] ?? ""}`;
    case "BRANCH": {
      const f = FAMILY_INFO[m.code as GardenFamily];
      return f ? `Nhánh ${f.label} đạt bậc ${m.tier}: ${f.ornament} treo trên cây` : `Nhánh kỹ năng đạt bậc ${m.tier}`;
    }
    case "MEMORY": return `Đèn Ký Ức bậc ${m.tier}: những Cây Ký Ức đã tốt nghiệp thắp sáng tán cây`;
    case "RING": return `Vòng Ký Ức thứ ${m.tier} khắc vào thân cây`;
    case "MASTERY": return `${cropName(m.code)} đạt bậc ${MASTERY_LABEL[m.tier] ?? m.tier}`;
    case "SKIN": return `Có giống mới: ${skinName(m.code)}`;
    default: return "Cột mốc mới";
  }
}

/** What Echo's hint opens: a garden panel or a real English Coach route (never an action of its own). */
export type EchoAction =
  | { kind: "grove"; slot: number }
  | { kind: "pest"; id: number }
  | { kind: "harvest" }
  | { kind: "orders" }
  | { kind: "milestones" }
  | { kind: "codex"; skinCode: string }
  | { kind: "route"; route: string }
  | { kind: "monument" };

export interface EchoLine { text: string; cta: string | null; action: EchoAction | null }

/** Words Echo's hint (server code + facts). Unknown codes say nothing: Echo never invents a task. */
export function echoLine(echo: GardenEcho | undefined, skinName: (code: string) => string): EchoLine | null {
  if (!echo) return null;
  const p = echo.params ?? {};
  const n = (k: string) => Number(p[k] ?? 0);
  switch (echo.code) {
    case "GRADUATE":
      return { text: "Một Cây Ký Ức đã đủ điều kiện tốt nghiệp. Năm câu hỏi đang chờ bạn.", cta: "Tới cây", action: { kind: "grove", slot: n("slot") } };
    case "RESCUE": {
      // Phase 3C: the advice follows the damage stage (one calm sentence, never a countdown)
      const stage = n("stage");
      const text = stage >= 3 ? "Một luống đang héo vì Sâu Lãng Quên. Ôn lại từ đó, cây sẽ tươi lại ngay."
        : stage === 2 ? "Sâu Lãng Quên đang gặm lá một luống. Ôn lại từ đó để cây lớn bình thường trở lại."
          : n("count") > 1 ? `${n("count")} từ đang bị Sâu Lãng Quên bám. Ôn lại để chúng rời đi.` : "Một từ đang bị Sâu Lãng Quên bám. Ôn lại để nó rời đi.";
      return { text, cta: "Xem từ", action: { kind: "pest", id: n("pestId") } };
    }
    case "HARVEST":
      return { text: n("count") > 1 ? `${n("count")} luống đã chín, thu khi còn tươi nhé.` : "Một luống đã chín, thu khi còn tươi nhé.", cta: "Thu hoạch", action: { kind: "harvest" } };
    case "DELIVER":
      return { text: "Kho đã đủ nông sản cho một đơn trên bảng giao hàng.", cta: "Xem đơn", action: { kind: "orders" } };
    case "MILESTONE":
      return { text: n("count") > 1 ? `Bạn vừa đạt ${n("count")} cột mốc mới.` : "Bạn vừa đạt một cột mốc mới.", cta: "Xem", action: { kind: "milestones" } };
    case "CLAIM_SKIN": {
      const code = String(p.skinCode ?? "");
      return { text: `Bạn đã đủ điều kiện nhận giống ${skinName(code)}.`, cta: "Nhận", action: { kind: "codex", skinCode: code } };
    }
    case "REVIEW_DUE":
      return { text: `${formatNumber(n("due"))} thẻ đã đến hạn ôn. Ôn xong, nước và ngày học sẽ về vườn.`, cta: "Ôn thẻ", action: { kind: "route", route: "/flashcards" } };
    case "BRANCH": {
      const f = FAMILY_INFO[String(p.family) as GardenFamily];
      if (!f) return null;
      return { text: `Còn ${n("daysLeft")} ngày ${f.activity} để nhánh ${f.label} lên bậc ${n("tier")}.`, cta: f.cta, action: { kind: "route", route: f.route } };
    }
    case "IDLE":
      return { text: "Vườn đang yên. Chạm vào Cây Tri Thức để xem hành trình của bạn.", cta: "Xem cây", action: { kind: "monument" } };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ Phase 3C: buildings, land, pests, contribution

/** Vietnamese names of the pest damage stages (0 = the word was reviewed). */
export const PEST_STAGE_LABEL: Record<number, string> = { 0: "Đã ôn, cây đang hồi phục", 1: "Sâu vừa xuất hiện", 2: "Lá đang bị gặm", 3: "Cây đang héo" };

/** What a pest stage means for the crop, in one honest sentence (numbers are the seeded rules, shown by the server). */
export function pestStageNote(stage: number, ready: boolean): string {
  switch (stage) {
    case 1: return "Sâu mới chỉ bò quanh luống: cây chưa bị ảnh hưởng gì. Ôn từ này trước khi lá bị gặm.";
    case 2: return ready ? "Lá đã bị gặm: nếu thu hoạch lúc này, điểm “Không sâu” chỉ còn 10 thay vì 25."
      : "Lá đang bị gặm nên cây lớn chậm hơn một chút, và điểm “Không sâu” khi thu chỉ còn 10 thay vì 25.";
    case 3: return ready ? "Cây đang héo: nếu thu hoạch lúc này, điểm “Không sâu” bằng 0. Cây không chết và vẫn thu hoạch được."
      : "Cây đang héo nên lớn chậm thêm một thời gian ngắn, và điểm “Không sâu” khi thu bằng 0. Cây không chết.";
    default: return "Bạn đã ôn từ này: cây lớn bình thường và thu hoạch sạch sâu.";
  }
}

export interface BuildingInfo { title: string; kicker: string; note: string; levelNames: string[] }

/** Presentation copy of the three buildings (the server owns every number). */
export const BUILDING_INFO: Record<string, BuildingInfo> = {
  COTTAGE: {
    title: "Nhà Gỗ Ký Ức", kicker: "Mái ấm của hòn đảo",
    note: "Nhà gỗ giúp người bận rộn: nông sản chín giữ được độ tươi lâu hơn và lịch thời tiết nhìn xa hơn.",
    levelNames: ["Nhà gỗ mộc", "Hiên hoa và tủ lịch", "Gác xép sáng đèn", "Nhà gỗ trọn vẹn"],
  },
  WAREHOUSE: {
    title: "Kho Nông Trại", kicker: "Căn kho bên rìa nông trại",
    note: "Kho không bao giờ giới hạn số nông sản bạn giữ. Nâng cấp kho mở thùng ủ: biến nông sản dư thành phân bón.",
    levelNames: ["Kho dụng cụ", "Kho có thùng ủ", "Kho hai gian", "Kho lớn có gác"],
  },
  MARKET: {
    title: "Quầy Chợ Echo", kicker: "Góc hạt giống cạnh cổng nông trại",
    note: "Quầy lớn hơn bày thêm gói hạt đúng mùa và cho mua thêm vài lượt mỗi ngày. Giá không bao giờ đổi.",
    levelNames: ["Góc hạt giống", "Quầy có mái che", "Quầy có sạp cân", "Quầy chợ lớn"],
  },
};

/** One effect of a building level in plain Vietnamese. */
export function effectText(e: GardenEffect): string {
  const pct = Math.round(e.value * 100);
  switch (e.code) {
    case "freshBonus": return `Nông sản chín giữ độ tươi lâu hơn ${pct}%`;
    case "forecastExtra": return `Lịch thời tiết nhìn xa thêm ${e.value} khung thời tiết`;
    case "compostDaily": return `Thùng ủ: ${e.value} mẻ phân bón mỗi ngày`;
    case "premiumCompostDaily": return e.value > 0 ? `Thùng ủ thượng hạng: ${e.value} mẻ mỗi ngày` : "Chưa ủ được phân thượng hạng";
    case "featuredExtra": return `Quầy bày thêm ${e.value} gói hạt đúng mùa mỗi ngày`;
    case "stapleCapExtra": return e.value > 0 ? `Mua thêm ${e.value} lượt phân bón mỗi loại mỗi ngày` : "Số lượt mua phân bón như cũ";
    case "packCapExtra": return e.value > 0 ? `Mua thêm ${e.value} lượt mỗi gói hạt mỗi ngày` : "Số lượt mua gói hạt như cũ";
    default: return `${e.code}: ${e.value}`;
  }
}

export const REGION_NOTE: Record<string, string> = {
  WEST_TILLED: "Thửa đất đã cày quanh chú bù nhìn.",
  WEST_FALLOW: "Bãi cỏ nghỉ ở góc Tây Nam nông trại.",
  SOUTH_FIELD: "Cánh đồng cỏ rộng phía Nam các luống khởi đầu.",
};

/** A gate requirement of a farmland region ("Cấp nông trại 9/12"). */
export function gateText(r: GardenRequirement): string {
  const have = Math.min(r.have, r.need);
  switch (r.code) {
    case "LEVEL": return `Cấp nông trại ${have}/${r.need}`;
    case "PLOTS": return `Luống đã mở ${have}/${r.need}`;
    case "ORDERS": return `Đơn hàng đã giao ${formatNumber(have)}/${formatNumber(r.need)}`;
    case "HARVESTS": return `Lượt thu hoạch ${formatNumber(have)}/${formatNumber(r.need)}`;
    case "CONTRIBUTION": return `Điểm đóng góp ${formatNumber(have)}/${formatNumber(r.need)}`;
    case "LEARNING_DAYS": return `Ngày học đã xác nhận ${formatNumber(have)}/${formatNumber(r.need)}`;
    case "GARDEN_DAYS": return `Số ngày có vườn ${formatNumber(have)}/${formatNumber(r.need)}`;
    default: return `${have}/${r.need}`;
  }
}

/** Where a contribution entry came from, in plain Vietnamese (the server stores the fact; the client only words it). */
export function contributionText(e: Pick<GardenContributionEntry, "source" | "ref">, cropName: (code: string) => string): string {
  const [code, tier] = e.ref.split(":");
  switch (e.source) {
    case "LEARNING_DAY": return "Một ngày học đã xác nhận";
    case "BREADTH_DAY": return "Học từ hai kỹ năng trở lên trong ngày";
    case "GRADUATION": return "Một Cây Ký Ức tốt nghiệp với từ mới";
    case "WEEKLY_ORDER": return "Giao xong một đơn cả tuần";
    case "ERA": return `Cây Tri Thức bước sang kỷ ${tier ?? code}`;
    case "BRANCH": return `Nhánh ${FAMILY_INFO[code as GardenFamily]?.label ?? "kỹ năng"} đạt bậc ${tier ?? ""}`;
    case "MEMORY": return `Đèn Ký Ức bậc ${tier ?? ""}`;
    case "RING": return `Vòng Ký Ức thứ ${tier ?? ""}`;
    case "MASTERY": return `${cropName(code)} đạt bậc ${MASTERY_LABEL[Number(tier)] ?? tier ?? ""}`;
    case "LAND_REGION": return "Mở trọn một khu đất";
    case "BUILDING_MAX": return `${BUILDING_INFO[code]?.title ?? "Công trình"} đạt cấp cao nhất`;
    case "REDEEM": return "Đổi một món quà";
    case "REVERSAL": return "Hoàn điểm một món quà";
    default: return "Một cột mốc của khu vườn";
  }
}

export const REWARD_STATUS_LABEL: Record<string, string> = {
  OPEN: "Có thể đổi", LOCKED: "Chưa đủ điều kiện", OWNED: "Đã có", SOLD_OUT: "Đã hết lượt", CLOSED: "Quầy chưa mở", UNAVAILABLE: "Chưa mở",
};

/** Tutorial steps persisted as `onboarding_step` (GDD 01 §5, Phase 1 = steps 1–5 and 8). */
export const ONBOARDING_DONE = 8;

// ------------------------------------------------------------------ Phase 3D: Echo Coin, soil, supplies, shop

/** The garden's one currency. A display name only: balances, prices and the ledger are the numbers they always were. */
export const COIN_NAME = "Đồng Echo";

export function coinsText(n: number): string {
  return `${formatNumber(n)} ${COIN_NAME}`;
}

export const SOIL_LABEL: Record<GardenSoilStatus, string> = { OK: "Đất ẩm tốt", DRY: "Đất khô hạn", WET: "Đất úng nước" };

/** How fast a crop dries its soil, in words (server fact `thirst`, 1 = average). */
export function thirstLabel(thirst: number | undefined): string {
  if (thirst === undefined) return "";
  return thirst >= 1.25 ? "Háo nước" : thirst <= 0.85 ? "Chịu hạn" : "Uống vừa";
}

export interface SupplyInfo {
  title: string;
  /** when a player would reach for it (one short line) */
  when: string;
}

export const SUPPLY_INFO: Record<string, SupplyInfo> = {
  FERTILIZER: { title: "Phân bón", when: "Khi muốn cây chín kịp lần ghé tới." },
  FERTILIZER_PREMIUM: { title: "Phân bón Thượng hạng", when: "Cho những cây dài ngày, quý giá nhất." },
  MULCH: { title: "Rơm Phủ Gốc", when: "Rải lúc gieo cây dài ngày: đất giữ ẩm suốt vụ." },
  CROP_TONIC: { title: "Thuốc Dưỡng Cây", when: "Khi cây đã chịu hạn hoặc úng quá lâu và bạn muốn cứu chất lượng." },
  RAIN_COVER: { title: "Bạt Che Mưa", when: "Khi đất đã ẩm mà dự báo còn mưa tiếp." },
  SHADE_NET: { title: "Lưới Che Nắng", when: "Trước khi rời đảo lâu trong những ngày nắng." },
  DRAINAGE: { title: "Rãnh Thoát Nước", when: "Khi đất đang úng: rút nước ngay." },
  ORGANIC_SPRAY: { title: "Thuốc Xịt Hữu Cơ", when: "Khi cây bị Sâu Lãng Quên mà bạn chưa kịp ôn từ." },
  INSECT_NET: { title: "Lưới Chắn Côn Trùng", when: "Phủ lên cây quý để sâu mới không đậu vào." },
  WELL_WATER: { title: "Nước Giếng", when: "Khi đất khô mà bạn đã hết nước từ việc ôn thẻ." },
};

export function supplyArtUrl(code: string): string {
  return `/garden/ui/item_${code}.webp`;
}

const pctLess = (factor: number) => Math.round((1 - factor) * 100);
const hoursText = (h: number) => (Number.isInteger(h) ? String(h) : String(h).replace(".", ","));

/** What a supply does, worded from the server's own numbers (never a number invented on the client). */
export function supplyEffectText(item: Pick<GardenSupplyItem, "code" | "effect" | "hours" | "value">, boosts: GardenBoost[]): string {
  switch (item.effect) {
    case "BOOST": {
      const b = boosts.find((x) => x.code === item.code);
      return b ? `Rút ngắn ${Math.round(b.fraction * 100)}% thời gian lớn của một vụ (mỗi vụ một lần phân bón).` : "";
    }
    case "MOISTURE": return `Làm ẩm đất ngay (+${item.value} độ ẩm). Chỉ làm ẩm, không thúc cây lớn nhanh.`;
    case "MULCH": return `Đến lúc thu hoạch: đất khô chậm hơn ${pctLess(item.value)}% và mưa ngấm ít hơn ${pctLess(item.value)}%. Mỗi vụ một lần.`;
    case "RAIN_COVER": return `Trong ${hoursText(item.hours)} giờ: mưa không làm đất ướt thêm (cây cũng không được mưa thúc lớn).`;
    case "SHADE": return `Trong ${hoursText(item.hours)} giờ: đất khô chậm hơn ${pctLess(item.value)}%.`;
    case "DRAINAGE": return `Rút nước ngay về mức ẩm ${item.value} và giữ đất không úng trong ${hoursText(item.hours)} giờ.`;
    case "TONIC": return `Trong ${hoursText(item.hours)} giờ đất xấu không làm cây chậm lại; thời gian cây đã chịu hạn / úng được tính giảm ${pctLess(item.value)}% khi chấm chất lượng. Mỗi vụ một lần.`;
    case "PEST_SPRAY": return `Trong ${hoursText(item.hours)} giờ: Sâu Lãng Quên không làm cây chậm lại; thu hoạch lúc này được ít nhất ${item.value}/25 điểm sâu bệnh. Từ quá hạn vẫn chờ bạn ôn thật.`;
    case "PEST_NET": return `Trong ${hoursText(item.hours)} giờ: sâu mới không đậu được lên cây này.`;
    default: return "";
  }
}

export const SHOP_CATEGORIES: Array<{ id: GardenShopCategory; label: string; note: string }> = [
  { id: "SEEDS", label: "Hạt giống", note: "Gói hạt đúng mùa, rẻ hơn mua lẻ khi gieo." },
  { id: "CARE", label: "Phân và dưỡng", note: "Giúp cây lớn nhanh và khỏe suốt vụ." },
  { id: "WEATHER", label: "Thời tiết", note: "Che mưa, che nắng, thoát nước." },
  { id: "PEST", label: "Sâu bệnh", note: "Giảm thiệt hại trong lúc bạn chưa kịp ôn từ." },
  { id: "UTILITY", label: "Dụng cụ", note: "Vật dụng nhỏ giúp chăm vườn dễ hơn." },
];

/** Catalogue shelves that open in later phases: named so players know what is coming, never sold before they exist. */
export const SHOP_UPCOMING: string[] = ["Quà English Coach"];

// ------------------------------------------------------------------ Phase 3E: cosmetic shop copy and previews

export type CosmeticShelf = "FEATURED" | "SKINS" | "HOUSE" | "VEGETATION" | "MONUMENT" | "DECOR" | "FENCE_PATH" | "BED" | "OWNED" | "EARNED";

/** Shelves of the cosmetic shop (one shop, several shelves; every label is a word, never a colour alone). */
export const COSMETIC_SHELVES: Array<{ id: CosmeticShelf; label: string; note: string }> = [
  { id: "FEATURED", label: "Bộ sưu tập", note: "Mười bộ sưu tập theo mùa, lễ hội và truyền thuyết. Mỗi món mua riêng lẻ." },
  { id: "SKINS", label: "Giống cây", note: "Giống đẹp cho từng loại cây: chỉ đổi dáng vẻ, không đổi năng suất hay giá bán." },
  { id: "HOUSE", label: "Nhà Gỗ", note: "Kiểu nhà đổi dáng vẻ ở mọi cấp. Cấp nhà và quyền lợi của nhà giữ nguyên." },
  { id: "VEGETATION", label: "Cây cối", note: "Dáng mới cho cây cảnh, bụi cây và bụi hoa quanh đảo." },
  { id: "MONUMENT", label: "Cây Tri Thức", note: "Đồ trang hoàng quanh gốc và dưới tán. Không thay đổi thời đại hay thành tựu học tập của cây." },
  { id: "DECOR", label: "Vật trang trí", note: "Đèn, chậu hoa, ghế, biển và tượng để bày trong các vùng cỏ trống." },
  { id: "FENCE_PATH", label: "Rào và lối đi", note: "Kiểu hàng rào nông trại và mặt lát cho lối đi." },
  { id: "BED", label: "Khung luống", note: "Khung cho mọi luống trồng. Đất, cây và ô chạm giữ nguyên." },
  { id: "OWNED", label: "Của tôi", note: "Những món bạn đang có." },
  { id: "EARNED", label: "Thành tựu", note: "Món chỉ nhận được bằng việc học và làm vườn thật, không bán." },
];

export const COSMETIC_SLOT_LABEL: Record<string, string> = {
  HOUSE: "Nhà Gỗ", TREE: "Cây cảnh", SHRUB: "Bụi cây", FLOWER: "Bụi hoa", MONUMENT: "Cây Tri Thức", FENCE: "Hàng rào", PATH: "Lối đi",
  BED: "Khung luống", DECOR: "Vật trang trí",
};
export const DECOR_FAMILY_LABEL: Record<string, string> = { LANTERN: "Đèn", PLANTER: "Chậu hoa", BENCH: "Ghế và bàn", SIGN: "Biển và cờ", STATUE: "Tượng" };

/** The world sprite that shows a cosmetic in the shop (the very art the island draws; never a separate thumbnail). */
export function cosmeticArtUrl(category: string, artKey: string, houseLevel = 0): string {
  const key = category === "HOUSE" ? `house_${artKey}_l${Math.max(0, Math.min(3, houseLevel))}`
    : category === "TREE" ? `veg_tree_${artKey}_a`
      : category === "SHRUB" ? `veg_shrub_${artKey}_a`
        : category === "FLOWER" ? `veg_flower_${artKey}_a`
          : category === "MONUMENT" ? `kt_cos_${artKey}_base`
            : category === "FENCE" ? `fence_${artKey}_gate`
              : category === "PATH" ? `path_${artKey}_b`
                : category === "BED" ? `bedframe_${artKey}`
                  : `decor_${artKey}`;
  return `/garden/world/${key}.webp`;
}

/** What an earned item asks for, in the player's words. */
export function cosmeticRequirementText(kind: string, requirement: number): string {
  if (kind === "LEARNING") return `${requirement} ngày học đã xác nhận`;
  if (kind === "HARVESTS") return `${formatNumber(requirement)} lần thu hoạch`;
  if (kind === "GRADUATIONS") return `${requirement} Cây Ký Ức tốt nghiệp`;
  return "";
}

/** Where the camera looks while an appearance is tried on. */
export const COSMETIC_FOCUS: Record<string, string> = {
  HOUSE: "farmhouse", MONUMENT: "knowledge_tree", FENCE: "farm_zone", BED: "farm_zone", PATH: "prop_well", TREE: "orchard_zone",
  SHRUB: "farmhouse", FLOWER: "farmhouse",
};

const EXTRA_OF_EFFECT: Partial<Record<GardenSupplyEffect, string>> = {
  MULCH: "sup_mulch", RAIN_COVER: "sup_rain_cover", SHADE: "sup_shade_net", DRAINAGE: "sup_drainage",
  PEST_NET: "sup_insect_net", PEST_SPRAY: "sup_tag_spray", TONIC: "sup_tag_tonic",
};

/** Protections still working at `serverNowMs` (the client only hides one whose server end time has passed). */
export function activeProtections(p: GardenPlanting, serverNowMs: number): GardenProtection[] {
  return (p.protections ?? []).filter((x) => !x.expiresAt || Date.parse(x.expiresAt) > serverNowMs);
}

/** Sprite keys drawn on a bed for a planting's soil and supplies (growing crops only; a ripe crop keeps its covers). */
export function bedExtras(p: GardenPlanting, serverNowMs: number): string[] {
  const out: string[] = [];
  if (!p.ready && p.soil?.status === "DRY") out.push("soil_dry");
  if (!p.ready && p.soil?.status === "WET") out.push("soil_wet");
  for (const x of activeProtections(p, serverNowMs)) {
    const key = EXTRA_OF_EFFECT[x.effect];
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

export interface SoilNote {
  tone: "good" | "warn" | "info";
  text: string;
}

/** One plain diagnosis of a growing crop's soil, from server facts: what is wrong, what it costs, what fixes it. */
export function soilNote(p: GardenPlanting, serverNowMs: number, tierCapLabel: (code: string) => string): SoilNote | null {
  const s = p.soil;
  if (!s) return null;
  if (p.ready) {
    return s.tierCap
      ? { tone: "warn", text: `Cây đã chín, nhưng vụ này chịu hạn / úng quá lâu nên nông sản đạt tối đa hạng ${tierCapLabel(s.tierCap)}.` }
      : { tone: "good", text: "Cây đã chín: không cần tưới hay che chắn nữa." };
  }
  if (s.status === "DRY") {
    return { tone: "warn", text: s.slowing
      ? "Đất khô: cây đang héo và lớn chậm hơn. Tưới nước là cây tươi lại ngay."
      : "Đất khô: cây đang héo. Tưới nước là cây tươi lại ngay." };
  }
  if (s.status === "WET") {
    return { tone: "warn", text: s.slowing
      ? "Đất úng nước: lá rũ, cây lớn chậm hơn. Rãnh thoát nước rút nước ngay; nắng lên đất cũng tự ráo."
      : "Đất úng nước: lá đang rũ. Rãnh thoát nước rút nước ngay; nắng lên đất cũng tự ráo." };
  }
  if (s.nextStatus && s.nextChangeAt) {
    const left = (Date.parse(s.nextChangeAt) - serverNowMs) / 1000;
    if (left > 0 && left < 36 * 3600) {
      return s.nextStatus === "DRY"
        ? { tone: "info", text: `Theo dự báo, đất sẽ khô sau khoảng ${formatDuration(left)} (lúc ${clockTime(Date.parse(s.nextChangeAt))}). Tưới trước lúc đó để cây không héo.` }
        : { tone: "info", text: `Theo dự báo, mưa sẽ làm đất úng sau khoảng ${formatDuration(left)}. Che bạt hoặc để sẵn rãnh thoát nước.` };
    }
  }
  return { tone: "good", text: "Đất đang ẩm vừa đủ. Cây lớn đều." };
}

/** What the soil has cost this crop's quality so far (null while nothing is lost). */
export function soilQualityNote(s: GardenSoil, tierCapLabel: (code: string) => string): string | null {
  if (s.tierCap) return `Cây đã chịu hạn / úng ${Math.round(s.stressShare * 100)}% thời gian lớn: nếu không cải thiện, nông sản đạt tối đa hạng ${tierCapLabel(s.tierCap)}. Chăm đều từ giờ hoặc dùng Thuốc Dưỡng Cây.`;
  if (s.careFactor < 1) return `Cây đã chịu hạn / úng ${Math.round(s.stressShare * 100)}% thời gian lớn: điểm Chăm sóc đang bị giảm. Giữ đất ẩm tốt từ giờ, tỉ lệ này sẽ giảm dần.`;
  return null;
}

export function protectionText(x: GardenProtection, serverNowMs: number): string {
  const name = SUPPLY_INFO[x.itemCode]?.title ?? x.itemCode;
  if (!x.expiresAt) return `${name} · đến lúc thu hoạch`;
  return `${name} · còn ${formatDuration(Math.max(0, (Date.parse(x.expiresAt) - serverNowMs) / 1000))}`;
}

// ------------------------------------------------------------------ Phase 3H: livestock and guardian pets

/** Square UI art rendered from the Blender masters (`eg_animals.py` → `export_runtime.py --phase3h`). */
export const animalIconUrl = (species: string, baby = false) => `/garden/ui/animal_${species}${baby ? "_baby" : ""}.webp`;
export const animalHouseIconUrl = (code: string) => `/garden/ui/house_${code}.webp`;
export const productIconUrl = (code: string) => `/garden/ui/product_${code}.webp`;
export const FEED_ICON = "/garden/ui/item_FEED.webp";

export const ANIMAL_STAGE_LABEL: Record<string, string> = { BABY: "Còn nhỏ", YOUNG: "Đang lớn", ADULT: "Trưởng thành" };

/** What each guardian does, in one honest sentence built from the server's numbers. */
export function guardianEffectText(g: { species: string; cooldownHours: number; shieldHours: number; graceMinutes: number; pestCapReduction: number }): string {
  switch (g.species) {
    case "DOG": return `Mỗi ${g.cooldownHours} giờ, chó xua một vị khách định lấy nông sản rồi canh đảo thêm ${g.shieldHours} giờ.`;
    case "GOOSE": return `Ngỗng báo động sớm: bạn có thêm ${g.graceMinutes} phút ưu tiên thu hoạch khi cây vừa chín.`;
    case "CAT": return `Mèo giữ vườn sạch: số luống có thể bị Sâu Lãng Quên cùng lúc giảm ${g.pestCapReduction}. Từ cần ôn vẫn phải ôn.`;
    default: return "";
  }
}

/** The guardian's state right now, in words (never colour only). */
export function guardianStatusText(g: { status: string; until: string | null; minLevel: number }): string {
  switch (g.status) {
    case "LOCKED": return `Mở ở Cấp ${g.minLevel}`;
    case "AVAILABLE": return "Có thể nhận nuôi";
    case "HUNGRY": return "Đang đói nên nghỉ ngơi. Cho ăn để bạn ấy làm việc trở lại.";
    case "READY": return "Đang canh vườn, sẵn sàng xua khách lạ";
    case "GUARDING": return g.until ? `Vừa xua một vị khách, canh đảo đến ${momentText(g.until)}` : "Đang canh gác đảo";
    case "COOLDOWN": return g.until ? `Đang nghỉ sau ca canh, sẵn sàng lại lúc ${momentText(g.until)}` : "Đang nghỉ sau ca canh";
    case "ON_DUTY": return "Đang làm việc";
    default: return "";
  }
}

/** "còn 5 giờ" / "còn 2 ngày" until an instant; null when it has passed. */
export function untilText(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const left = Math.floor((new Date(iso).getTime() - nowMs) / 1000);
  return left > 0 ? `còn ${formatDuration(left)}` : null;
}

/** The owner's animal quarter as scene inputs (art only: every fact is the server's). */
export function animalVisuals(a: GardenAnimals | null | undefined): AnimalVisuals | null {
  if (!a) return null;
  return {
    houses: a.houses.map((h) => ({
      code: h.code,
      state: h.built ? "built" as const : "lot" as const,
      badge: !h.built || h.animals.length === 0 ? null
        : h.ready > 0 ? "ready" as const
          : h.animals.some((x) => !x.cared) ? "care" as const : null,
    })),
    animals: [
      ...a.houses.flatMap((h) => h.animals.map((x) => ({
        id: `a${x.id}`, species: x.species, kind: "LIVESTOCK" as const, stage: x.stage, house: h.code, place: x.place,
        woolly: x.ready > 0, mood: !x.cared ? "rest" as const : x.ready > 0 ? "ready" as const : "ok" as const,
      }))),
      ...a.guardians.filter((g) => g.owned).map((g) => ({
        id: `g${g.species}`, species: g.species, kind: "GUARDIAN" as const, stage: "ADULT" as const, house: null, place: null,
        woolly: false, mood: g.status === "HUNGRY" ? "rest" as const : g.status === "GUARDING" ? "alert" as const : "ok" as const,
      })),
    ],
  };
}

/** A visited island's animals: which houses stand and who lives there — no lot markers, no care marks. */
export function islandAnimalVisuals(a: GardenIslandAnimals | null | undefined): AnimalVisuals | null {
  if (!a) return null;
  return {
    houses: a.houses.map((code) => ({ code, state: "built" as const, badge: null })),
    animals: a.animals.map((x, i) => ({
      id: `v${i}-${x.species}-${x.place ?? 0}`, species: x.species, kind: x.kind, stage: x.stage,
      house: x.kind === "LIVESTOCK" ? LIVESTOCK_HOUSE[x.species] ?? null : null, place: x.place, woolly: x.woolly, mood: "ok" as const,
    })),
  };
}

const LIVESTOCK_HOUSE: Record<string, string> = { CHICKEN: "COOP", DUCK: "DUCK_POND", PIG: "PIG_PEN", SHEEP: "SHEEP_BARN" };
