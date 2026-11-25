"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { rootModuleOf } from "@/lib/navigation/routes";

/*
 * Route entry. A short CSS fade (`.ec-view-enter`, globals.css) instead of the former framer spring: the spring rendered
 * the server HTML at opacity 0 until hydration, then slid 24 px with an overshoot for ~0.6 s after every route change.
 * The root modules animate their own views (WorkspaceTabs) and the Landing its own entrance, so they get no second animation here.
 */
export default function Template({ children }: { children: React.ReactNode }) {
    const pathname = usePathname() || "";
    const isQuietRuntime = pathname.includes('/exams/') && pathname.includes('/attempts/');
    const isEchoGarden = pathname === '/games/echo-garden' || pathname.startsWith('/games/echo-garden/');

    if (isQuietRuntime || isEchoGarden || pathname === "/" || rootModuleOf(pathname)) {
        return <div className="w-full h-full">{children}</div>;
    }

    return <div className="ec-view-enter w-full h-full">{children}</div>;
}
