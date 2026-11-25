'use client';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import OdysseyEntry from './OdysseyEntry';
import { LearningPathPage } from './LearningPathPage';
const OdysseyPage = dynamic(() => import('./odyssey/OdysseyPage'), { ssr: false, loading: () => <div className="p-8" role="status">Echo Odyssey…</div> });
export default function LearningPathExperience() {
  const params = useSearchParams();
  if (params.get('view') === 'odyssey') return <OdysseyPage />;
  return <><OdysseyEntry /><LearningPathPage /></>;
}
