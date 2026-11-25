import { apiClient } from "./api-client";
import type {
  CardTier,
  ForgeMode,
  ForgeResult,
  FusionCandidate,
  FusionResult,
  MemoryOverview,
  StudioLevel,
  StudioResult,
} from "@/types/flashcardMemory";

/**
 * Echo Memory Tides 2.0 client. Reads are the signed-in learner's own data. The three AI calls (Studio, Forge, Fusion
 * check) run only from an explicit button (AGENTS §17) and go through the existing AI quota; nothing here saves a card —
 * approved Studio drafts are saved through the existing POST /flashcards (`saveStudioCard`).
 */

export async function fetchMemoryOverview(signal?: AbortSignal): Promise<MemoryOverview> {
  const { data } = await apiClient.get<MemoryOverview>("/flashcards/memory/overview", { signal, timeout: 25000 });
  return data;
}

export async function fetchCardTiers(ids: number[], signal?: AbortSignal): Promise<CardTier[]> {
  const clean = Array.from(new Set(ids.filter((n) => Number.isInteger(n) && n > 0))).slice(0, 100);
  if (!clean.length) return [];
  const { data } = await apiClient.get<CardTier[]>("/flashcards/memory/tiers", { params: { ids: clean.join(",") }, signal, timeout: 15000 });
  return Array.isArray(data) ? data : [];
}

export async function fetchFusionCandidates(limit = 6, signal?: AbortSignal): Promise<FusionCandidate[]> {
  const { data } = await apiClient.get<FusionCandidate[]>("/flashcards/memory/fusion/candidates", { params: { limit }, signal, timeout: 15000 });
  return Array.isArray(data) ? data : [];
}

export async function checkFusion(firstCardId: number, secondCardId: number, sentence: string, signal?: AbortSignal): Promise<FusionResult> {
  const { data } = await apiClient.post<FusionResult>("/flashcards/memory/fusion/check",
    { firstCardId, secondCardId, sentence: sentence.slice(0, 400) }, { signal, timeout: 90000 });
  return data;
}

export async function forgeMemory(flashcardId: number, mode: ForgeMode, interest?: string, signal?: AbortSignal): Promise<ForgeResult> {
  const { data } = await apiClient.post<ForgeResult>("/flashcards/memory/forge",
    { flashcardId, mode, interest: interest?.slice(0, 120) || undefined }, { signal, timeout: 90000 });
  return data;
}

export interface StudioRequest {
  text: string;
  level: StudioLevel;
  count: number;
  exclude?: string[];
  /** Regenerate one draft: exactly this term of the passage. */
  only?: string;
}

export async function generateStudioDrafts(req: StudioRequest, signal?: AbortSignal): Promise<StudioResult> {
  const { data } = await apiClient.post<StudioResult>("/flashcards/studio/drafts", {
    text: req.text.slice(0, 6000),
    level: req.level,
    count: req.count,
    exclude: req.exclude?.slice(0, 60),
    only: req.only,
  }, { signal, timeout: 95000 });
  return { cards: Array.isArray(data?.cards) ? data.cards : [], dropped: data?.dropped ?? 0 };
}

/** One approved draft through the existing save boundary: 201 = new card, 200 = the learner already had the word. */
export async function saveStudioCard(card: { term: string; meaning: string; example: string; ipa?: string | null; cefr?: string | null;
  definition?: string | null; partOfSpeech?: string | null; exampleVi?: string | null }): Promise<"created" | "existing"> {
  const res = await apiClient.post("/flashcards", {
    front: card.term.slice(0, 255),
    back: card.meaning.slice(0, 2000),
    example: card.example.slice(0, 1000),
    ipa: card.ipa || undefined,
    cefr: card.cefr || undefined,
    // the contextual sense the learner approved (V117): the card then shows only this sense
    definition: card.definition ? card.definition.slice(0, 500) : undefined,
    partOfSpeech: card.partOfSpeech || undefined,
    exampleVi: card.exampleVi ? card.exampleVi.slice(0, 1000) : undefined,
  });
  return res.status === 201 ? "created" : "existing";
}

/** True when a request was cancelled by the learner (no message is shown for it). */
export function isCancelled(error: unknown): boolean {
  const e = error as { name?: string; code?: string } | null;
  return !!e && (e.name === "CanceledError" || e.name === "AbortError" || e.code === "ERR_CANCELED");
}

/** The Vietnamese reason an Echo AI action did not run, from the server's own answer where it has one. */
export function memoryAiError(error: unknown, vi = true): { message: string; upgrade: boolean } {
  const e = error as { response?: { status?: number; data?: { message?: unknown; errorCode?: unknown; code?: unknown } } } | null;
  const status = e?.response?.status;
  const data = e?.response?.data;
  const server = typeof data?.message === "string" ? data.message.trim() : "";
  const code = typeof data?.errorCode === "string" ? data.errorCode : typeof data?.code === "string" ? data.code : "";
  if (!status) return { message: vi ? "Mất kết nối. Kiểm tra mạng rồi thử lại." : "Connection lost. Check your network and try again.", upgrade: false };
  if (status === 401) return { message: vi ? "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." : "Your session has expired. Sign in again.", upgrade: false };
  if (status === 403 && (code === "PREMIUM_REQUIRED" || code === "PREMIUM_LIMIT_REACHED")) {
    return { message: server || (vi ? "Bạn đã dùng hết lượt AI hôm nay." : "You have used today's AI allowance."), upgrade: true };
  }
  if (status === 503 && code === "AI_BUSY") return { message: vi ? "Echo AI đang bận. Thử lại sau vài giây." : "Echo AI is busy. Try again in a few seconds.", upgrade: false };
  if ((status === 400 || status === 404 || status === 503) && server) return { message: server, upgrade: false };
  if (status === 429) return { message: vi ? "Bạn thao tác hơi nhanh. Đợi một chút rồi thử lại." : "Too many requests. Wait a moment.", upgrade: false };
  return { message: vi ? "Echo AI chưa xử lý được yêu cầu. Hãy thử lại." : "Echo AI could not handle the request. Try again.", upgrade: false };
}
