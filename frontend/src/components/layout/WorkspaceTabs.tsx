"use client";

import React from "react";
import { useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { DictionaryPopup, InteractiveText } from "@/components/features/dictionary/DictionaryPopup";
import { AuthGuard } from "@/components/common/AuthGuard";
import { isRootModuleHref, moduleHref, rootModuleOf } from "@/lib/navigation/routes";

// Each module is its own chunk, loaded only when it is shown (still rendered on the server for a direct visit). The landing
// page, which every anonymous visitor gets, downloads none of them (capacity release 2026-10).
const tabLoading = () => (
  <div
    role="status"
    aria-live="polite"
    data-navigation-loading="module"
    className="mx-auto min-h-[50vh] w-full max-w-7xl px-4 py-8"
  >
    <span className="sr-only">Đang mở nội dung… / Loading content…</span>
    <div className="motion-safe:animate-pulse space-y-5" aria-hidden="true">
      <div className="h-8 w-52 rounded-xl bg-surface-container-high" />
      <div className="h-4 w-full max-w-xl rounded-lg bg-surface-container" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-36 rounded-2xl border border-outline-variant/30 bg-surface-container-low" />
        ))}
      </div>
    </div>
  </div>
);
const DashboardBento = dynamic(() => import("@/components/dashboard/DashboardBento").then((m) => m.DashboardBento), { loading: tabLoading });
const FlashcardUI = dynamic(() => import("@/components/features/flashcard/FlashcardUI").then((m) => m.FlashcardUI), { loading: tabLoading });
const ReadingDashboard = dynamic(() => import("@/components/features/reading/ReadingDashboard").then((m) => m.ReadingDashboard), { loading: tabLoading });
const WritingModule = dynamic(() => import("@/components/features/writing/WritingModule").then((m) => m.WritingModule), { loading: tabLoading });
const LeaderboardPage = dynamic(() => import("@/components/features/leaderboard/LeaderboardPage").then((m) => m.LeaderboardPage), { loading: tabLoading });

/**
 * The five root modules (Trang chủ, Thẻ từ vựng, Đọc, Viết, Bảng xếp hạng) as views of one mounted tree: `app/(workspace)/layout.tsx` renders
 * this and the route files render nothing, so a switch between them is a native history change with no server round trip (10 §Z).
 * The address is the only source of the active module: a sidebar pushState, Back / Forward and a direct visit all render the new module
 * in the same pass.
 */
export default function WorkspaceTabs() {
  const pathname = usePathname() || "";
  const router = useRouter();
  const activeTab = rootModuleOf(pathname);
  const { data: session } = useSession();

  const handleTabChange = (id: string) => {
    const href = moduleHref(id);
    if (!isRootModuleHref(href)) {
      router.push(href);
      return;
    }
    // These modules are views of this already-mounted tree. Native history is integrated with usePathname and avoids a
    // redundant App Router / RSC round trip.
    window.history.pushState(null, "", href);
  };

  if (!activeTab) return null;

  return (
    // min-h-full (not min-h-screen): the scrolling <main> is the viewport minus the 4 rem top bar, so a full-screen
    // minimum made every tab scroll by that amount.
    <div className="min-h-full bg-surface text-on-surface transition-colors duration-300 font-sans">
      {/*
        One keyed wrapper per module. The new module renders at once with a short CSS fade (`.ec-view-enter`): no exit
        animation to wait for (the former AnimatePresence "wait" kept the page blank for ~0.25–0.4 s on every switch).
      */}
      <div key={activeTab} className="ec-view-enter" data-morph-stage={activeTab}>
        {activeTab === "dashboard" ? (
          <AuthGuard><main className="min-h-screen px-3.5 py-5 sm:px-6 sm:py-7 lg:px-10 lg:py-9">
            <DashboardBento userName={session?.user?.name} onNavigate={handleTabChange} />
          </main></AuthGuard>
        ) : (
          <AuthGuard>
            {activeTab === "writing" ? (
              <WritingModule />
            ) : activeTab === "leaderboard" ? (
              <LeaderboardPage />
            ) : activeTab === "reading" ? (
              // Reading paints its own full-width worlds (Echo Glass); the article reader fills the viewport itself.
              <ReadingDashboard />
            ) : activeTab === "flashcards" ? (
              // The deck library paints its own full-width world (Echo Memory Universe); the study screens keep the
              // former centred 7xl frame inside FlashcardUI.
              <FlashcardUI />
            ) : null}
          </AuthGuard>
        )}
      </div>

      {/* Kept for parity with the source module — dictionary helpers stay available. */}
      <span className="hidden">
        <InteractiveText text="" />
        <DictionaryPopup word="" onClose={() => { }} />
      </span>
    </div>
  );
}
