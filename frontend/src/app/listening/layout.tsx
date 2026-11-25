"use client";

import React from "react";
import { DictionaryPopup, InteractiveText } from "@/components/features/dictionary/DictionaryPopup";
import { AuthGuard } from "@/components/common/AuthGuard";

export default function ListeningLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col h-full relative bg-surface text-on-surface transition-colors duration-300 font-sans">
            <main className="flex-1 overflow-y-auto block relative" id="listening-scroll-area">
                <AuthGuard>
                    {children}
                </AuthGuard>
            </main>

            <span className="hidden">
                <InteractiveText text="" />
                <DictionaryPopup word="" onClose={() => { }} />
            </span>
        </div>
    );
}
