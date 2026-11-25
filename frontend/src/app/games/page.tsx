import { Suspense } from "react";
import { AuthGuard } from "@/components/common/AuthGuard";
import { GamesHub } from "@/components/features/games/GamesHub";

import StudyReturn from "@/components/study-space/StudyReturn";

export default function GamesPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<div className="min-h-64 bg-surface" aria-busy="true" />}>
        <StudyReturn />
        <GamesHub />
      </Suspense>
    </AuthGuard>
  );
}
