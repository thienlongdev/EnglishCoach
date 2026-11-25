'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { examsApi } from '@/services/examsApi';
import { IeltsProfileDto, ToeicProfileDto, ExamFamily } from '@/types/exams';
import { ExamProfileView } from '@/components/features/exams/ExamProfileView';
import { Loader2 } from 'lucide-react';
import { UniverseStage, UniverseWorld } from '@/components/features/exams/universe/ExamUniverse';

function ProfileContent() {
  const searchParams = useSearchParams();
  const queryFamily = searchParams.get('family')?.toUpperCase();
  const initialFamily: ExamFamily = queryFamily === 'TOEIC' ? 'TOEIC' : 'IELTS';

  const [ieltsProfile, setIeltsProfile] = useState<IeltsProfileDto | null>(null);
  const [toeicProfile, setToeicProfile] = useState<ToeicProfileDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadProfiles = async () => {
      setIsLoading(true);
      try {
        const [ielts, toeic] = await Promise.allSettled([
          examsApi.getIeltsProfile(),
          examsApi.getToeicProfile(),
        ]);

        if (ielts.status === 'fulfilled') {
          setIeltsProfile(ielts.value);
        }
        if (toeic.status === 'fulfilled') {
          setToeicProfile(toeic.value);
        }
      } catch (err) {
        console.error('Failed to load profiles:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadProfiles();
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
        <p className="text-xs text-muted-foreground">Loading Competency Assessment Profile...</p>
      </div>
    );
  }

  // Echo Exam Universe (2026-10-24): the profile lives in the Exams world (token wrapper only; the view is unchanged).
  return (
    <UniverseWorld world="nexus">
      <UniverseStage world="nexus">
        <ExamProfileView
          initialFamily={initialFamily}
          ieltsProfile={ieltsProfile}
          toeicProfile={toeicProfile}
        />
      </UniverseStage>
    </UniverseWorld>
  );
}

export default function ProfilePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-xs text-muted-foreground">Loading Competency Assessment Profile...</p>
        </div>
      }
    >
      <ProfileContent />
    </Suspense>
  );
}
