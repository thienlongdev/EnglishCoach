"use client";

import React from "react";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { AuthRequired } from "./AuthRequired";
import { useLanguage } from "@/context/LanguageContext";

interface AuthGuardProps {
    children: React.ReactNode;
    fallbackTitle?: string;
    fallbackDescription?: string;
}

export function AuthGuard({
    children,
    fallbackTitle,
    fallbackDescription,
}: AuthGuardProps) {
    const { data: session, status } = useSession();
    const { locale } = useLanguage();

    if (status === "loading") {
        // Wait for authoritative NextAuth state before mounting private children.
        return (
            <div data-navigation-loading="auth" className="flex flex-col items-center justify-center py-32 text-center">
                <Loader2 className="h-8 w-8 text-indigo-600 animate-spin mb-4" />
                <p className="ec-wp-plate text-sm text-slate-500 dark:text-slate-400">
                    {locale === "vi" ? "Đang kiểm tra đăng nhập..." : "Checking authentication..."}
                </p>
            </div>
        );
    }

    if (status === "unauthenticated" || !session) {
        return (
            <AuthRequired
                title={fallbackTitle}
                description={fallbackDescription}
            />
        );
    }

    return <>{children}</>;
}

export default AuthGuard;
