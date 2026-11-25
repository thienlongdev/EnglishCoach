import { AuthGuard } from "@/components/common/AuthGuard";
import LearningPathExperience from "@/components/features/learning-path/LearningPathExperience";

export default function LearningPathRoute() {
  return (
    <AuthGuard>
      <LearningPathExperience />
    </AuthGuard>
  );
}
