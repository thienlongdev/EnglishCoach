'use client';

import dynamic from 'next/dynamic';
import { EchoLifeLoadingOverlay } from './echoLife/EchoLifeLoadingOverlay';

/** The whole study space is its own chunk: nothing of it is in the workspace bundle. */
const StudySpace = dynamic(() => import('./StudySpace'), {
  ssr: false,
  loading: () => (
    <EchoLifeLoadingOverlay
      stageId="preparing"
      progress={8}
      stage="Đang chuẩn bị Không gian học tập"
    />
  ),
});

export default function StudySpaceEntry({ lifeEnabled }: { lifeEnabled: boolean }) {
  return <StudySpace lifeEnabled={lifeEnabled} />;
}
