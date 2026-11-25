import { AuthGuard } from "@/components/common/AuthGuard";
import { LearningProgressPage } from "@/components/features/learning-path/LearningProgressPage";

export default function ProgressRoute() {
  return (
    <AuthGuard>
      <LearningProgressPage />
    </AuthGuard>
  );
}
