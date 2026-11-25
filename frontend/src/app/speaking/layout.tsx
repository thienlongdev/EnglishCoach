"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { DictionaryPopup, InteractiveText } from "@/components/features/dictionary/DictionaryPopup";
import { AuthGuard } from "@/components/common/AuthGuard";

export default function SpeakingLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const arena = usePathname() === "/speaking/arena";
    return (
        <div className="flex flex-col h-full relative bg-surface text-on-surface transition-colors duration-300 font-sans">
            <main className="flex-1 overflow-y-auto block relative" id="speaking-scroll-area">
                {/* Arena's own session gate returns invited guests to the exact relative URL after login. */}
                {arena ? children : <AuthGuard>{children}</AuthGuard>}
            </main>

            <span className="hidden">
                <InteractiveText text="" />
                <DictionaryPopup word="" onClose={() => { }} />
            </span>
        </div>
    );
}
