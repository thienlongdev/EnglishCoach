import { Suspense } from "react";
import { AuthGuard } from "@/components/common/AuthGuard";
import { EchoGardenGameShell } from "@/components/features/games/echo-garden/EchoGardenGameShell";
import { EchoGardenView } from "@/components/features/games/echo-garden/EchoGardenView";

export const metadata = {
  description: "Khu vườn nông trại và cây tri thức phản chiếu hành trình học tiếng Anh cùng cá voi Echo.",
};

export default function EchoGardenPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<div className="h-[100dvh] w-[100dvw] bg-[#0c142b]" aria-busy="true" />}>
        <EchoGardenGameShell>
          <EchoGardenView />
        </EchoGardenGameShell>
      </Suspense>
    </AuthGuard>
  );
}
