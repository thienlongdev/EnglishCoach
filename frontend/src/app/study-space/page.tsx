import { AuthGuard } from '@/components/common/AuthGuard';
import StudySpaceEntry from '@/components/study-space/StudySpaceEntry';
import { connection } from 'next/server';

export const metadata = {
  description: 'Không gian học tập: căn phòng 3D và các công cụ học của riêng bạn trên hình nền bạn chọn.',
};

export default async function StudySpacePage() {
  await connection();
  const enabled=process.env.APP_ECHO_LIFE_ENABLED;
  const lifeEnabled=enabled==='true' || (enabled===undefined && process.env.NODE_ENV!=='production');
  return (
    <AuthGuard>
      <StudySpaceEntry lifeEnabled={lifeEnabled} />
    </AuthGuard>
  );
}
