import { AuthGuard } from '@/components/common/AuthGuard';
import TimerWindow from '@/components/study-space/TimerWindow';

export const metadata = {
  description: 'Đồng hồ tập trung trong một cửa sổ riêng.',
};

export default function StudySpaceTimerPage() {
  return (
    <AuthGuard>
      <TimerWindow />
    </AuthGuard>
  );
}
