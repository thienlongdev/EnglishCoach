import React, { Suspense } from "react";
import WorkspaceTabs from "@/components/layout/WorkspaceTabs";

/**
 * Trang chủ, Thẻ từ vựng, Đọc, Viết and Bảng xếp hạng are views of one mounted tree: it lives here so that moving between them never
 * remounts it and never waits for the server. The route files render nothing; they exist for their addresses (same shape as the Listening lesson, 10 §BN).
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<div className="animate-pulse p-8 text-center">Loading Application...</div>}>
        <WorkspaceTabs />
      </Suspense>
      {children}
    </>
  );
}
