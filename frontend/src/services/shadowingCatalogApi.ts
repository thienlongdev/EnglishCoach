import { useEffect, useRef } from "react";
import useSWR, { mutate } from "swr";
import { apiClient } from "./api-client";
import { useModuleEntryScope } from "@/hooks/useModuleEntryResource";
import { registerUserScopedCleanup } from "@/lib/auth-cache-cleanup";

export const SHADOWING_DEFAULT_PAGE_SIZE = 12;
export const SHADOWING_MAX_PAGE_SIZE = 24;
export const SHADOWING_STATE_STORAGE_PREFIX = "ec_shadowing_catalog_state:v1:";

export type ShadowingSourceFilter = "ALL" | "SYSTEM" | "USER";

export interface ShadowingMaterialCard {
    id: number;
    title: string;
    topic?: string | null;
    channel?: string | null;
    youtubeVideoId?: string | null;
    thumbnail?: string | null;
    durationSeconds: number;
    cefrLevel?: string | null;
    accent?: string | null;
    isSystem: boolean;
    sourceType?: string | null;
}

export interface ShadowingCatalogPage {
    content: ShadowingMaterialCard[];
    page: number;
    size: number;
    totalElements: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
}

export interface ShadowingCatalogQuery {
    page?: number;
    size?: number;
    cefr?: string;
    accent?: string;
    source?: ShadowingSourceFilter;
    q?: string;
}

export interface ShadowingPersistedViewState {
    page: number;
    cefr: string;
    accent: string;
    source: ShadowingSourceFilter;
    q: string;
    updatedAt: number;
}

export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem?(key: string): void;
}

interface InFlightEntry<T> {
    controller: AbortController;
    promise: Promise<T>;
}

const inFlightRequests = new Map<string, InFlightEntry<unknown>>();
let requestGeneration = 0;

export function clearShadowingCatalogRequests(): void {
    requestGeneration += 1;
    for (const entry of inFlightRequests.values()) {
        try {
            entry.controller.abort();
        } catch {
            // Ignore abort errors during cleanup.
        }
    }
    inFlightRequests.clear();
}

registerUserScopedCleanup(clearShadowingCatalogRequests);

export function clampShadowingPageSize(size?: number): number {
    if (typeof size !== "number" || !Number.isFinite(size)) {
        return SHADOWING_DEFAULT_PAGE_SIZE;
    }
    return Math.max(1, Math.min(SHADOWING_MAX_PAGE_SIZE, Math.floor(size)));
}

export function clampShadowingPageIndex(page?: number): number {
    if (typeof page !== "number" || !Number.isFinite(page)) {
        return 0;
    }
    return Math.max(0, Math.min(100_000, Math.floor(page)));
}

export function normalizeShadowingSource(source?: string | null): ShadowingSourceFilter {
    const upper = (source ?? "").trim().toUpperCase();
    if (upper === "SYSTEM" || upper === "USER") {
        return upper;
    }
    return "ALL";
}

export function buildShadowingCatalogPath(query: ShadowingCatalogQuery = {}): string {
    const page = clampShadowingPageIndex(query.page);
    const size = clampShadowingPageSize(query.size);
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("size", String(size));

    const source = normalizeShadowingSource(query.source);
    if (source !== "ALL") {
        params.set("source", source);
    }

    const cefr = (query.cefr ?? "").trim().toUpperCase();
    if (cefr && cefr !== "ALL") {
        params.set("cefr", cefr.slice(0, 20));
    }

    const accent = (query.accent ?? "").trim();
    if (accent && accent.toUpperCase() !== "ALL") {
        params.set("accent", accent.slice(0, 60));
    }

    const q = (query.q ?? "").trim();
    if (q) {
        params.set("q", q.slice(0, 160));
    }

    return `/speaking/shadowing/catalog?${params.toString()}`;
}

export function shadowingCatalogSwrKey(scope: string, path: string) {
    return ["shadowing-catalog", scope, path] as const;
}

export function shadowingCardSwrKey(scope: string, materialId: number) {
    return ["shadowing-catalog-card", scope, materialId] as const;
}

function runDeduplicatedRequest<T>(cacheId: string, fetcher: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const startedGeneration = requestGeneration;
    const dedupeKey = `${startedGeneration}:${cacheId}`;
    const existing = inFlightRequests.get(dedupeKey) as InFlightEntry<T> | undefined;
    if (existing) {
        return existing.promise;
    }

    const controller = new AbortController();
    const promise = (async () => {
        try {
            const result = await fetcher(controller.signal);
            if (controller.signal.aborted || startedGeneration !== requestGeneration) {
                throw new Error("Shadowing catalog request cancelled");
            }
            return result;
        } finally {
            inFlightRequests.delete(dedupeKey);
        }
    })();

    inFlightRequests.set(dedupeKey, { controller, promise });
    return promise;
}

export function fetchShadowingCatalogPage(path: string, scope: string): Promise<ShadowingCatalogPage> {
    if (!scope) {
        return Promise.reject(new Error("Authenticated user scope required"));
    }
    return runDeduplicatedRequest(`page:${scope}:${path}`, async (signal) => {
        const { data } = await apiClient.get<ShadowingCatalogPage>(path, {
            signal,
            timeout: 15000,
        });
        return data;
    });
}

export function fetchShadowingMaterialCard(materialId: number, scope: string): Promise<ShadowingMaterialCard> {
    if (!scope) {
        return Promise.reject(new Error("Authenticated user scope required"));
    }
    const path = `/speaking/shadowing/catalog/${encodeURIComponent(String(materialId))}`;
    return runDeduplicatedRequest(`card:${scope}:${materialId}`, async (signal) => {
        const { data } = await apiClient.get<ShadowingMaterialCard>(path, {
            signal,
            timeout: 10000,
        });
        return data;
    });
}

export function useShadowingCatalog(query: ShadowingCatalogQuery, enabled = true) {
    const scope = useModuleEntryScope();
    const prevScopeRef = useRef<string | null>(scope);
    const sameScope = scope !== null && prevScopeRef.current === scope;

    useEffect(() => {
        prevScopeRef.current = scope;
    }, [scope]);

    const path = buildShadowingCatalogPath(query);
    const swrKey = scope && enabled ? shadowingCatalogSwrKey(scope, path) : null;

    return useSWR<ShadowingCatalogPage>(
        swrKey,
        () => fetchShadowingCatalogPage(path, scope!),
        {
            keepPreviousData: sameScope,
            revalidateOnFocus: false,
            dedupingInterval: 15000,
            shouldRetryOnError: false,
        }
    );
}

export function useShadowingMaterialCard(materialId: number | null | undefined, enabled = true) {
    const scope = useModuleEntryScope();
    const validId = typeof materialId === "number" && Number.isInteger(materialId) && materialId > 0 ? materialId : null;
    const swrKey = scope && enabled && validId !== null ? shadowingCardSwrKey(scope, validId) : null;

    return useSWR<ShadowingMaterialCard>(
        swrKey,
        () => fetchShadowingMaterialCard(validId!, scope!),
        {
            keepPreviousData: false,
            revalidateOnFocus: false,
            dedupingInterval: 30000,
            shouldRetryOnError: false,
        }
    );
}

export function revalidateShadowingCatalog() {
    inFlightRequests.clear();
    return mutate(
        (key) => Array.isArray(key) && (key[0] === "shadowing-catalog" || key[0] === "shadowing-catalog-card"),
        undefined,
        { revalidate: true }
    );
}

function defaultSessionStorage(): StorageLike | null {
    if (typeof window === "undefined") return null;
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

export function shadowingViewStateStorageKey(scope: string): string {
    return `${SHADOWING_STATE_STORAGE_PREFIX}${scope}`;
}

export function parseShPageParam(raw: string | null | undefined): number | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
    return Math.min(100_000, parsed);
}

export function readShadowingViewState(
    scope: string | null | undefined,
    storage: StorageLike | null = defaultSessionStorage()
): ShadowingPersistedViewState | null {
    if (!scope || !storage) return null;
    try {
        const raw = storage.getItem(shadowingViewStateStorageKey(scope));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<ShadowingPersistedViewState> | null;
        if (!parsed || typeof parsed !== "object") return null;
        const page = typeof parsed.page === "number" && Number.isFinite(parsed.page) && parsed.page >= 1
            ? Math.min(100_000, Math.floor(parsed.page))
            : 1;
        const cefr = typeof parsed.cefr === "string" && parsed.cefr.trim() ? parsed.cefr.trim().toUpperCase().slice(0, 20) : "ALL";
        const accent = typeof parsed.accent === "string" && parsed.accent.trim() ? parsed.accent.trim().slice(0, 60) : "ALL";
        const source = normalizeShadowingSource(typeof parsed.source === "string" ? parsed.source : "ALL");
        const q = typeof parsed.q === "string" ? parsed.q.slice(0, 160) : "";
        const updatedAt = typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
        return { page, cefr, accent, source, q, updatedAt };
    } catch {
        return null;
    }
}

export function writeShadowingViewState(
    scope: string | null | undefined,
    state: Omit<ShadowingPersistedViewState, "updatedAt">,
    storage: StorageLike | null = defaultSessionStorage()
): void {
    if (!scope || !storage) return;
    try {
        const payload: ShadowingPersistedViewState = {
            page: Math.max(1, Math.min(100_000, Math.floor(state.page || 1))),
            cefr: (state.cefr || "ALL").trim().toUpperCase().slice(0, 20),
            accent: (state.accent || "ALL").trim().slice(0, 60),
            source: normalizeShadowingSource(state.source),
            q: (state.q || "").slice(0, 160),
            updatedAt: Date.now(),
        };
        storage.setItem(shadowingViewStateStorageKey(scope), JSON.stringify(payload));
    } catch {
        // Ignore quota or storage security restrictions.
    }
}
