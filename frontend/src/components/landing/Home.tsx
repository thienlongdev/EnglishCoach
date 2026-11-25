"use client";

import React, { useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { LandingPage } from "@/components/landing/LandingPage";
import { canonicalHref } from "@/lib/navigation/routes";

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const query = searchParams.toString();
  const tab = searchParams.get("tab");
  const isLanding = !tab || tab === "landing";

  // `/?tab=x` is the old address of a module. The proxy redirects it before this page is rendered; this covers the one way past
  // the proxy, a client-side history change. An unknown tab goes to the dashboard rather than to an empty page.
  useEffect(() => {
    if (isLanding) return;
    const target = canonicalHref(`/?${query}`);
    router.replace(target.startsWith("/?") ? "/dashboard" : target);
  }, [isLanding, query, router]);

  return isLanding ? <LandingPage /> : <div role="status" className="min-h-full" data-navigation-loading="module" />;
}

export default function Home() {
  return (
    <Suspense fallback={<div data-discover-pending="" className="animate-pulse p-8 text-center">Loading Application...</div>}>
      <HomeContent />
    </Suspense>
  );
}
