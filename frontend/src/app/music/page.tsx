'use client';
import dynamic from 'next/dynamic';
import AuthGuard from '@/components/common/AuthGuard';
const MusicHub = dynamic(() => import('@/components/music/MusicHub'), { loading: () => <div role="status" className="p-10 text-on-surface">Echo Music…</div> });
export default function MusicPage() { return <AuthGuard><MusicHub /></AuthGuard>; }
