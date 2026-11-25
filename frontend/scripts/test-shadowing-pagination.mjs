// Wave B1 contracts: Server-side paginated Shadowing catalog client, 4x3 card rendering,
// native pagination with ellipsis, smooth heading scroll, URL + sessionStorage page restoration, and account isolation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const babel = require("next/dist/compiled/babel/bundle.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

function evaluateTs(relPath, deps = {}, globals = {}) {
    const isTsx = relPath.endsWith(".tsx");
    const { code } = babel.core().transformSync(read("src/" + relPath), {
        filename: relPath,
        configFile: false,
        babelrc: false,
        presets: [babel.presetTypescript(), ...(isTsx ? [babel.presetReact()] : [])],
        plugins: [babel.pluginTransformModulesCommonjs()],
    });
    const exports = {};
    const module = { exports };
    const globalKeys = Object.keys(globals);
    const globalVals = globalKeys.map((k) => globals[k]);
    const fn = new Function(
        "exports",
        "module",
        "require",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        ...globalKeys,
        code
    );
    fn(
        exports,
        module,
        (id) => (id in deps ? deps[id] : require(id)),
        (cb) => {
            cb(0);
            return 1;
        },
        () => {},
        ...globalVals
    );
    return module.exports;
}

function createMemoryStorage() {
    const map = new Map();
    return {
        map,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear(),
    };
}

let passed = 0;
async function check(name, fn) {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
}

console.log("=== Shadowing Pagination & Rendering Contracts ===");

// 1. Pure pagination slot math & ellipsis
await check("1. buildPaginationItems handles small (1..7) and large (8..50) page counts with clean ellipsis", () => {
    const cssProxy = new Proxy({}, { get: (_, prop) => String(prop) });
    const LucideStub = () => React.createElement("svg");
    const mod = evaluateTs("components/features/speaking/shadowing/ShadowingPagination.tsx", {
        react: React,
        "lucide-react": { ChevronLeft: LucideStub, ChevronRight: LucideStub },
        "./shadowingLibrary.module.css": cssProxy,
    });

    assert.deepEqual(mod.buildPaginationItems(1, 1), [1]);
    assert.deepEqual(mod.buildPaginationItems(2, 4), [1, 2, 3, 4]);
    assert.deepEqual(mod.buildPaginationItems(5, 7), [1, 2, 3, 4, 5, 6, 7]);

    // Large counts: start window, middle window, end window
    assert.deepEqual(mod.buildPaginationItems(1, 20), [1, 2, 3, 4, 5, "ellipsis-end", 20]);
    assert.deepEqual(mod.buildPaginationItems(4, 20), [1, 2, 3, 4, 5, "ellipsis-end", 20]);
    assert.deepEqual(mod.buildPaginationItems(5, 20), [1, "ellipsis-start", 4, 5, 6, "ellipsis-end", 20]);
    assert.deepEqual(mod.buildPaginationItems(10, 20), [1, "ellipsis-start", 9, 10, 11, "ellipsis-end", 20]);
    assert.deepEqual(mod.buildPaginationItems(17, 20), [1, "ellipsis-start", 16, 17, 18, 19, 20]);
    assert.deepEqual(mod.buildPaginationItems(20, 20), [1, "ellipsis-start", 16, 17, 18, 19, 20]);

    // Boundary rendering: page 1 disables Prev, last page disables Next, active page carries aria-current="page"
    const htmlPage1 = renderToStaticMarkup(
        React.createElement(mod.ShadowingPagination, {
            currentPage: 1,
            totalPages: 5,
            totalElements: 54,
            pageSize: 12,
            currentItemCount: 12,
            vi: true,
            onPageChange: () => {},
        })
    );
    assert.match(htmlPage1, /Trang 1 \/ 5/);
    assert.match(htmlPage1, /Hiển thị <strong>1–12<\/strong> trong tổng số <strong>54<\/strong> bài luyện/);
    assert.match(htmlPage1, /data-testid="shadowing-page-prev"[^>]*disabled=""/);
    assert.doesNotMatch(htmlPage1, /data-testid="shadowing-page-next"[^>]*disabled=""/);
    assert.match(htmlPage1, /data-testid="shadowing-page-num-1"[^>]*aria-current="page"/);

    const htmlLastPage = renderToStaticMarkup(
        React.createElement(mod.ShadowingPagination, {
            currentPage: 5,
            totalPages: 5,
            totalElements: 54,
            pageSize: 12,
            currentItemCount: 6,
            vi: true,
            onPageChange: () => {},
        })
    );
    assert.match(htmlLastPage, /Hiển thị <strong>49–54<\/strong> trong tổng số <strong>54<\/strong> bài luyện/);
    assert.doesNotMatch(htmlLastPage, /data-testid="shadowing-page-prev"[^>]*disabled=""/);
    assert.match(htmlLastPage, /data-testid="shadowing-page-next"[^>]*disabled=""/);
});

// 2. API client query normalization, request deduplication, logout cancellation, and user-scoped storage
await check("2. shadowingCatalogApi deduplicates in-flight requests, aborts on logout, and scopes SWR & sessionStorage per user", async () => {
    const cleanups = [];
    let apiCalls = 0;
    let pendingResolvers = [];

    const apiMod = evaluateTs("services/shadowingCatalogApi.ts", {
        react: React,
        swr: {
            default: () => ({}),
            mutate: async () => {},
        },
        "./api-client": {
            apiClient: {
                get: (url, cfg) => {
                    apiCalls += 1;
                    return new Promise((resolve, reject) => {
                        cfg?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
                        pendingResolvers.push({ url, resolve });
                    });
                },
            },
        },
        "@/hooks/useModuleEntryResource": {
            useModuleEntryScope: () => "101",
        },
        "@/lib/auth-cache-cleanup": {
            registerUserScopedCleanup: (fn) => {
                cleanups.push(fn);
                return () => {};
            },
        },
    });

    assert.equal(cleanups.length, 1, "registers logout cleanup callback");
    assert.equal(apiMod.buildShadowingCatalogPath({}), "/speaking/shadowing/catalog?page=0&size=12");
    assert.equal(
        apiMod.buildShadowingCatalogPath({ page: 2, size: 99, cefr: "b2", source: "USER", q: "  ted talk  " }),
        "/speaking/shadowing/catalog?page=2&size=24&source=USER&cefr=B2&q=ted+talk"
    );
    assert.equal(apiMod.clampShadowingPageSize(0), 1);
    assert.equal(apiMod.clampShadowingPageSize(12), 12);
    assert.equal(apiMod.clampShadowingPageSize(50), 24);
    assert.equal(apiMod.parseShPageParam("3"), 3);
    assert.equal(apiMod.parseShPageParam("0"), null);
    assert.equal(apiMod.parseShPageParam("-2"), null);
    assert.equal(apiMod.parseShPageParam("abc"), null);

    // Account-scoped SWR keys never collide across User A and User B
    assert.notDeepEqual(
        apiMod.shadowingCatalogSwrKey("101", "/speaking/shadowing/catalog?page=0&size=12"),
        apiMod.shadowingCatalogSwrKey("202", "/speaking/shadowing/catalog?page=0&size=12")
    );

    // Deduplication: two concurrent calls for the same user & path trigger 1 HTTP GET
    const p1 = apiMod.fetchShadowingCatalogPage("/speaking/shadowing/catalog?page=0&size=12", "101");
    const p2 = apiMod.fetchShadowingCatalogPage("/speaking/shadowing/catalog?page=0&size=12", "101");
    assert.equal(p1, p2);
    assert.equal(apiCalls, 1);
    pendingResolvers.shift().resolve({
        data: { content: [], page: 0, size: 12, totalElements: 0, totalPages: 0, hasNext: false, hasPrevious: false },
    });
    const resolved = await p1;
    assert.equal(resolved.totalElements, 0);

    // Logout aborts in-flight requests so late User A responses never settle
    const inFlight = apiMod.fetchShadowingCatalogPage("/speaking/shadowing/catalog?page=1&size=12", "101");
    assert.equal(apiCalls, 2);
    cleanups[0]();
    await assert.rejects(inFlight, /aborted|cancelled/i);

    // User-scoped sessionStorage isolation
    const storage = createMemoryStorage();
    apiMod.writeShadowingViewState("101", { page: 3, cefr: "B2", accent: "ALL", source: "USER", q: "climate" }, storage);
    assert.equal(apiMod.readShadowingViewState("202", storage), null, "User B never reads User A saved page");
    const restoredA = apiMod.readShadowingViewState("101", storage);
    assert.equal(restoredA.page, 3);
    assert.equal(restoredA.cefr, "B2");
    assert.equal(restoredA.source, "USER");
    assert.equal(restoredA.q, "climate");
});

// 3. ShadowingLibrarySection DOM count (<= 12 cards, 0 hidden cards, 0 audio players), smooth heading scroll, and URL/sessionStorage restoration
await check("3. ShadowingLibrarySection renders <= 12 lightweight cards, zero audio players, preserves page on Open/Return, and scrolls heading smoothly", () => {
    const cssProxy = new Proxy({}, { get: (_, prop) => String(prop) });
    const IconStub = (props) => React.createElement("svg", props);
    const icons = new Proxy({}, { get: () => IconStub });

    const sampleCards = Array.from({ length: 12 }, (_, idx) => ({
        id: 500 - idx,
        title: `Shadowing Passage ${idx + 1}`,
        topic: "Everyday English",
        channel: "English Coach Studio",
        youtubeVideoId: `vid000000${String(idx).padStart(2, "0")}`,
        thumbnail: `https://i.ytimg.com/vi/vid000000${String(idx).padStart(2, "0")}/hqdefault.jpg`,
        durationSeconds: 185,
        cefrLevel: idx % 2 === 0 ? "B1" : "B2",
        accent: "American",
        isSystem: idx > 0,
        sourceType: "VIDEO",
    }));

    let currentSearchParams = new URLSearchParams("shPage=2");
    const replacedUrls = [];
    const pushedUrls = [];
    const sessionStore = createMemoryStorage();

    const paginationMod = evaluateTs("components/features/speaking/shadowing/ShadowingPagination.tsx", {
        react: React,
        "lucide-react": icons,
        "./shadowingLibrary.module.css": cssProxy,
    });

    const apiMod = evaluateTs(
        "services/shadowingCatalogApi.ts",
        {
            react: React,
            swr: { default: () => ({}), mutate: async () => {} },
            "./api-client": { apiClient: { get: async () => ({ data: null }) } },
            "@/hooks/useModuleEntryResource": { useModuleEntryScope: () => "101" },
            "@/lib/auth-cache-cleanup": { registerUserScopedCleanup: () => () => {} },
        },
        { window: { sessionStorage: sessionStore } }
    );

    const capturedQueries = [];
    const sectionMod = evaluateTs(
        "components/features/speaking/shadowing/ShadowingLibrarySection.tsx",
        {
            react: React,
            "next/navigation": {
                useRouter: () => ({
                    replace: (u, opts) => replacedUrls.push({ u, opts }),
                    push: (u) => pushedUrls.push(u),
                }),
                usePathname: () => "/speaking",
                useSearchParams: () => currentSearchParams,
            },
            "lucide-react": icons,
            "@/components/features/speaking/studio/SpeakingArt": {
                StudioThumb: ({ src }) => React.createElement("img", { src, "data-stub": "StudioThumb" }),
                youtubePoster: (id) => (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null),
            },
            "@/components/features/speaking/studio/speakingStudio.module.css": cssProxy,
            "@/hooks/useModuleEntryResource": { useModuleEntryScope: () => "101" },
            "@/context/LanguageContext": { useLanguage: () => ({ locale: "vi", t: {} }) },
            "@/services/shadowingCatalogApi": {
                ...apiMod,
                useShadowingCatalog: (q) => {
                    capturedQueries.push(q);
                    return {
                        data: {
                            content: sampleCards,
                            page: q.page,
                            size: 12,
                            totalElements: 40,
                            totalPages: 4,
                            hasNext: q.page < 3,
                            hasPrevious: q.page > 0,
                        },
                        error: undefined,
                        isLoading: false,
                        isValidating: false,
                        mutate: async () => {},
                    };
                },
                useShadowingMaterialCard: () => ({ data: undefined }),
            },
            "./ShadowingPagination": paginationMod,
            "./shadowingLibrary.module.css": cssProxy,
        },
        { window: { sessionStorage: sessionStore, addEventListener: () => {}, removeEventListener: () => {} } }
    );

    const markup = renderToStaticMarkup(
        React.createElement(sectionMod.ShadowingLibrarySection, {
            onOpenImportModal: () => {},
            handoffQueryString: "",
        })
    );

    // ?shPage=2 (1-based) requests backend page=1 (0-based) with size=12
    assert.equal(capturedQueries[0].page, 1);
    assert.equal(capturedQueries[0].size, 12);

    // Exactly 12 visible cards, 0 hidden cards, 0 audio/video/iframe elements
    const cardMatches = markup.match(/data-testid="shadowing-material-card"/g) ?? [];
    assert.equal(cardMatches.length, 12);
    assert.doesNotMatch(markup, /<(audio|video|iframe)\b/i, "zero audio/video players initialized in catalog grid");
    assert.doesNotMatch(markup, /\bhidden=""|\bstyle="[^"]*display:\s*none/i, "zero hidden DOM cards");
    assert.match(markup, /data-guide="sh-import"/);
    assert.equal((markup.match(/data-guide="sh-item"/g) ?? []).length, 12);
    assert.match(markup, /Bắt đầu Shadowing/);
    assert.match(markup, /id="shadowing-library-heading"/);
    assert.match(markup, /Trang 2 \/ 4/);

    // Simulate returning from /speaking/shadowing/[id] via router.push("/speaking") (no shPage in URL) -> restores saved page 3!
    apiMod.writeShadowingViewState("101", { page: 3, cefr: "B2", accent: "ALL", source: "ALL", q: "" }, sessionStore);
    currentSearchParams = new URLSearchParams("");
    capturedQueries.length = 0;

    const restoredMarkup = renderToStaticMarkup(
        React.createElement(sectionMod.ShadowingLibrarySection, {
            onOpenImportModal: () => {},
        })
    );
    assert.equal(capturedQueries[0].page, 2, "restores 1-based page 3 -> 0-based backend page 2 from user-scoped sessionStorage");
    assert.equal(capturedQueries[0].cefr, "B2", "restores saved CEFR filter on return");
    assert.match(restoredMarkup, /Trang 3 \/ 4/);
});

// 4. Responsive 4x3 grid CSS, smooth heading scroll contract, no backdrop-filter/!important, no Sparkles, no "&"
await check("4. CSS grid (4x3 on xl/2xl, 3/2/1 responsive), smooth heading scroll, and repository hygiene gates hold", () => {
    const css = read("src/components/features/speaking/shadowing/shadowingLibrary.module.css");
    const sectionSrc = read("src/components/features/speaking/shadowing/ShadowingLibrarySection.tsx");
    const paginationSrc = read("src/components/features/speaking/shadowing/ShadowingPagination.tsx");
    const apiSrc = read("src/services/shadowingCatalogApi.ts");

    assert.match(css, /\.headingAnchor\s*\{\s*scroll-margin-top:\s*1\.5rem;/);
    assert.match(css, /@media \(min-width: 640px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /@media \(min-width: 960px\)[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(css, /@media \(min-width: 1280px\)[\s\S]*?repeat\(4, minmax\(0, 1fr\)\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(cssNoComments, /backdrop-filter|!important/);

    // Smooth scroll targets headingRef (never window.scrollTo(0, 0)), uses { scroll: false } on router.replace
    assert.match(sectionSrc, /router\.replace\(target,\s*\{\s*scroll:\s*false\s*\}\)/);
    assert.match(sectionSrc, /prefers-reduced-motion:\s*reduce/);
    assert.match(sectionSrc, /el\.scrollIntoView\(\{\s*behavior:\s*reduceMotion\s*\?\s*"auto"\s*:\s*"smooth",\s*block:\s*"start",\s*inline:\s*"nearest"/);
    assert.doesNotMatch(sectionSrc, /window\.scrollTo\s*\(\s*0/);

    for (const [label, content] of [
        ["ShadowingLibrarySection.tsx", sectionSrc],
        ["ShadowingPagination.tsx", paginationSrc],
        ["shadowingCatalogApi.ts", apiSrc],
    ]) {
        assert.doesNotMatch(content, /Sparkles|✨|dangerouslySetInnerHTML|AdvancedAudioPlayer/, `${label} clean of forbidden constructs`);
    }
});

// 5. Async Next.js App Router race regression (B1-URL-SYNC-RACE):
// router.replace() updates useSearchParams() ASYNCHRONOUSLY after synchronous React re-renders.
await check("5. Async router.replace race: filter reset (shPage=3 -> 1) and out-of-range clamping (?shPage=99 -> totalPages) never revert to stale shPage", async () => {
    function createHookHarness() {
        const slots = [];
        let cursor = 0;
        let dirty = false;
        let effectQueue = [];
        let renderFn = null;
        const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

        const mockReact = {
            ...React,
            useState(init) {
                const idx = cursor++;
                if (!(idx in slots)) {
                    slots[idx] = { value: typeof init === "function" ? init() : init };
                }
                const setState = (next) => {
                    const resolved = typeof next === "function" ? next(slots[idx].value) : next;
                    if (!Object.is(resolved, slots[idx].value)) {
                        slots[idx].value = resolved;
                        dirty = true;
                    }
                };
                return [slots[idx].value, setState];
            },
            useRef(init) {
                const idx = cursor++;
                if (!(idx in slots)) {
                    slots[idx] = { current: init };
                }
                return slots[idx];
            },
            useMemo(factory, deps) {
                const idx = cursor++;
                if (!slots[idx] || !sameDeps(slots[idx].deps, deps)) {
                    slots[idx] = { value: factory(), deps };
                }
                return slots[idx].value;
            },
            useCallback(fn, deps) {
                const idx = cursor++;
                if (!slots[idx] || !sameDeps(slots[idx].deps, deps)) {
                    slots[idx] = { fn, deps };
                }
                return slots[idx].fn;
            },
            useEffect(fn, deps) {
                const idx = cursor++;
                if (!slots[idx] || !sameDeps(slots[idx].deps, deps)) {
                    const prevCleanup = slots[idx]?.cleanup;
                    slots[idx] = { deps, cleanup: prevCleanup };
                    effectQueue.push(() => {
                        if (typeof slots[idx].cleanup === "function") slots[idx].cleanup();
                        slots[idx].cleanup = fn();
                    });
                }
            },
        };

        function flushRender(fn = renderFn) {
            renderFn = fn;
            let tree;
            let guard = 0;
            do {
                dirty = false;
                cursor = 0;
                tree = renderFn();
                const pendingEffects = effectQueue;
                effectQueue = [];
                for (const runEffect of pendingEffects) runEffect();
                assert.ok(++guard < 30, "bounded synchronous React render loop");
            } while (dirty);
            return tree;
        }

        function findElement(node, predicate) {
            if (!node || typeof node !== "object") return null;
            if (Array.isArray(node)) {
                for (const child of node) {
                    const hit = findElement(child, predicate);
                    if (hit) return hit;
                }
                return null;
            }
            if (predicate(node)) return node;
            if (node.props?.children) {
                return findElement(node.props.children, predicate);
            }
            return null;
        }

        return { mockReact, flushRender, findElement };
    }

    const cssProxy = new Proxy({}, { get: (_, prop) => String(prop) });
    const IconStub = (props) => React.createElement("svg", props);
    const icons = new Proxy({}, { get: () => IconStub });

    // (5a) Filter reset from /speaking?shPage=3 -> source=USER (3 items, 1 page) while router.replace is ASYNC
    {
        const { mockReact, flushRender, findElement } = createHookHarness();
        const sessionStore = createMemoryStorage();
        let activeUrlSearch = "?shPage=3";
        let routerSearchParams = new URLSearchParams("shPage=3");
        const pendingRouterCommits = [];
        const queries = [];

        const paginationMod = evaluateTs("components/features/speaking/shadowing/ShadowingPagination.tsx", {
            react: mockReact,
            "lucide-react": icons,
            "./shadowingLibrary.module.css": cssProxy,
        });
        const apiMod = evaluateTs(
            "services/shadowingCatalogApi.ts",
            {
                react: mockReact,
                swr: { default: () => ({}), mutate: async () => {} },
                "./api-client": { apiClient: { get: async () => ({ data: null }) } },
                "@/hooks/useModuleEntryResource": { useModuleEntryScope: () => "101" },
                "@/lib/auth-cache-cleanup": { registerUserScopedCleanup: () => () => {} },
            },
            { window: { sessionStorage: sessionStore, location: { get search() { return activeUrlSearch; } } } }
        );

        const sectionMod = evaluateTs(
            "components/features/speaking/shadowing/ShadowingLibrarySection.tsx",
            {
                react: mockReact,
                "next/navigation": {
                    useRouter: () => ({
                        replace: (target, opts) => {
                            assert.deepEqual(opts, { scroll: false });
                            // Do NOT mutate routerSearchParams synchronously — queue async commit!
                            pendingRouterCommits.push(() => {
                                const qIdx = target.indexOf("?");
                                activeUrlSearch = qIdx >= 0 ? target.slice(qIdx) : "";
                                routerSearchParams = new URLSearchParams(activeUrlSearch);
                            });
                        },
                        push: () => {},
                    }),
                    usePathname: () => "/speaking",
                    useSearchParams: () => routerSearchParams,
                },
                "lucide-react": icons,
                "@/components/features/speaking/studio/SpeakingArt": {
                    StudioThumb: () => null,
                    youtubePoster: () => null,
                },
                "@/components/features/speaking/studio/speakingStudio.module.css": cssProxy,
                "@/hooks/useModuleEntryResource": { useModuleEntryScope: () => "101" },
                "@/context/LanguageContext": { useLanguage: () => ({ locale: "vi", t: {} }) },
                "@/services/shadowingCatalogApi": {
                    ...apiMod,
                    useShadowingCatalog: (q) => {
                        queries.push({ ...q });
                        const isUserSource = q.source === "USER";
                        const totalElements = isUserSource ? 3 : 37;
                        const totalPages = isUserSource ? 1 : 4;
                        const count = q.page < totalPages ? (isUserSource ? 3 : 12) : 0;
                        const content = Array.from({ length: count }, (_, i) => ({
                            id: 900 - q.page * 12 - i,
                            title: `Item ${i + 1}`,
                            durationSeconds: 90,
                            isSystem: !isUserSource,
                            sourceType: "VIDEO",
                        }));
                        return {
                            data: {
                                content,
                                page: q.page,
                                size: 12,
                                totalElements,
                                totalPages,
                                hasNext: q.page + 1 < totalPages,
                                hasPrevious: q.page > 0,
                            },
                            error: undefined,
                            isLoading: false,
                            isValidating: false,
                            mutate: async () => {},
                        };
                    },
                    useShadowingMaterialCard: () => ({ data: undefined }),
                },
                "./ShadowingPagination": paginationMod,
                "./shadowingLibrary.module.css": cssProxy,
            },
            {
                window: {
                    sessionStorage: sessionStore,
                    location: { get search() { return activeUrlSearch; } },
                    addEventListener: () => {},
                    removeEventListener: () => {},
                },
            }
        );

        // Initial render at ?shPage=3 -> backend page=2
        let tree = flushRender(() =>
            sectionMod.ShadowingLibrarySection({ onOpenImportModal: () => {}, handoffQueryString: "" })
        );
        assert.equal(queries.at(-1).page, 2);

        // Click "Của tôi" (source=USER): routerSearchParams is STILL "shPage=3" during synchronous re-render!
        const userFilterBtn = findElement(tree, (el) => el.props?.["data-testid"] === "shadowing-source-user");
        assert.ok(userFilterBtn, "found USER source filter button");
        userFilterBtn.props.onClick();

        tree = flushRender();
        assert.equal(pendingRouterCommits.length, 1, "queued async router.replace('/speaking')");
        assert.equal(routerSearchParams.get("shPage"), "3", "Next searchParams is still stale on synchronous frame");
        assert.equal(queries.at(-1).source, "USER");
        assert.equal(queries.at(-1).page, 0, "currentPage stayed 1 (0-based page=0) despite stale shPage=3");

        // Now commit the async Next.js router transition and re-render
        pendingRouterCommits.shift()();
        assert.equal(activeUrlSearch, "");
        tree = flushRender();
        assert.equal(queries.at(-1).page, 0, "stays on page 1 after async searchParams catches up");
    }

    // (5b) Out-of-range /speaking?shPage=99 (37 items -> totalPages=4) clamps cleanly to shPage=4 with 0 empty-state flash
    {
        const { mockReact, flushRender, findElement } = createHookHarness();
        const sessionStore = createMemoryStorage();
        let currentScope = null; // Starts unauthenticated ("pending") like NextAuth hydration
        let activeUrlSearch = "?shPage=99";
        let routerSearchParams = new URLSearchParams("shPage=99");
        const pendingRouterCommits = [];
        const queries = [];

        const paginationMod = evaluateTs("components/features/speaking/shadowing/ShadowingPagination.tsx", {
            react: mockReact,
            "lucide-react": icons,
            "./shadowingLibrary.module.css": cssProxy,
        });
        const apiMod = evaluateTs(
            "services/shadowingCatalogApi.ts",
            {
                react: mockReact,
                swr: { default: () => ({}), mutate: async () => {} },
                "./api-client": { apiClient: { get: async () => ({ data: null }) } },
                "@/hooks/useModuleEntryResource": { useModuleEntryScope: () => currentScope },
                "@/lib/auth-cache-cleanup": { registerUserScopedCleanup: () => () => {} },
            },
            { window: { sessionStorage: sessionStore, location: { get search() { return activeUrlSearch; } } } }
        );

        const sectionMod = evaluateTs(
            "components/features/speaking/shadowing/ShadowingLibrarySection.tsx",
            {
                react: mockReact,
                "next/navigation": {
                    useRouter: () => ({
                        replace: (target, opts) => {
                            assert.deepEqual(opts, { scroll: false });
                            pendingRouterCommits.push(() => {
                                const qIdx = target.indexOf("?");
                                activeUrlSearch = qIdx >= 0 ? target.slice(qIdx) : "";
                                routerSearchParams = new URLSearchParams(activeUrlSearch);
                            });
                        },
                        push: () => {},
                    }),
                    usePathname: () => "/speaking",
                    useSearchParams: () => routerSearchParams,
                },
                "lucide-react": icons,
                "@/components/features/speaking/studio/SpeakingArt": {
                    StudioThumb: () => null,
                    youtubePoster: () => null,
                },
                "@/components/features/speaking/studio/speakingStudio.module.css": cssProxy,
                "@/hooks/useModuleEntryResource": { useModuleEntryScope: () => currentScope },
                "@/context/LanguageContext": { useLanguage: () => ({ locale: "vi", t: {} }) },
                "@/services/shadowingCatalogApi": {
                    ...apiMod,
                    useShadowingCatalog: (q) => {
                        if (!currentScope) {
                            return { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: async () => {} };
                        }
                        queries.push({ ...q });
                        const totalElements = 37;
                        const totalPages = 4;
                        const count = q.page < totalPages ? (q.page === 3 ? 1 : 12) : 0;
                        const content = Array.from({ length: count }, (_, i) => ({
                            id: 37 - i,
                            title: `Clamped Lesson ${i + 1}`,
                            durationSeconds: 120,
                            isSystem: true,
                            sourceType: "VIDEO",
                        }));
                        return {
                            data: {
                                content,
                                page: q.page,
                                size: 12,
                                totalElements,
                                totalPages,
                                hasNext: q.page + 1 < totalPages,
                                hasPrevious: q.page > 0,
                            },
                            error: undefined,
                            isLoading: false,
                            isValidating: false,
                            mutate: async () => {},
                        };
                    },
                    useShadowingMaterialCard: () => ({ data: undefined }),
                },
                "./ShadowingPagination": paginationMod,
                "./shadowingLibrary.module.css": cssProxy,
            },
            {
                window: {
                    sessionStorage: sessionStore,
                    location: { get search() { return activeUrlSearch; } },
                    addEventListener: () => {},
                    removeEventListener: () => {},
                },
            }
        );

        // Frame 0: scope is null -> shows loading state, NEVER empty state
        let tree = flushRender(() =>
            sectionMod.ShadowingLibrarySection({ onOpenImportModal: () => {}, handoffQueryString: "" })
        );
        assert.ok(findElement(tree, (el) => el.props?.["data-testid"] === "shadowing-loading"), "loading shown before auth scope");
        assert.equal(findElement(tree, (el) => el.props?.["data-testid"] === "shadowing-empty"), null, "never flashes false empty state");

        // Frame 1: scope hydrates to "101" while URL is still ?shPage=99 (router.replace is async!)
        currentScope = "101";
        tree = flushRender();
        assert.equal(queries.at(-1).page, 3, "clamped synchronously from page 99 -> page 4 (0-based page=3) even before router.replace settled!");
        assert.equal(pendingRouterCommits.length, 1, "queued router.replace('/speaking?shPage=4')");
        assert.equal(findElement(tree, (el) => el.props?.["data-testid"] === "shadowing-empty"), null);
        assert.ok(findElement(tree, (el) => el.props?.["data-testid"] === "shadowing-cards-grid"), "renders clamped page 4 cards");

        // Commit async Next.js router transition -> URL is now ?shPage=4 and state remains locked on page 4
        pendingRouterCommits.shift()();
        assert.equal(activeUrlSearch, "?shPage=4");
        tree = flushRender();
        assert.equal(queries.at(-1).page, 3);
        assert.equal(apiMod.readShadowingViewState("101", sessionStore).page, 4);
    }
});

console.log(`\n=== All ${passed}/5 Shadowing Pagination contract groups PASSED ===`);
