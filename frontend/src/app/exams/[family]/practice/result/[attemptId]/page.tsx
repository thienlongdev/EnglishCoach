import React from 'react';
import { notFound } from 'next/navigation';
import { PracticeResultReview } from '@/components/features/exams/PracticeResultReview';
import { UniverseStage, UniverseWorld } from '@/components/features/exams/universe/ExamUniverse';

interface PageProps {
  params: Promise<{
    family: string;
    attemptId: string;
  }>;
}

/** Exams Phase 6: raw practice result + review from the attempt snapshot. */
export default async function PracticeResultPage({ params }: PageProps) {
  const { family: rawFamily, attemptId } = await params;
  const familySlug = rawFamily.toLowerCase();
  if (familySlug !== 'ielts' && familySlug !== 'toeic') {
    notFound();
  }
  // Echo Exam Universe (2026-10-24): the family's world around the unchanged result + review view (token wrapper only).
  return (
    <UniverseWorld world={familySlug === 'ielts' ? 'ielts' : 'toeic'} narrow>
      <UniverseStage world={familySlug === 'ielts' ? 'ielts' : 'toeic'}>
        <PracticeResultReview family={familySlug} attemptId={attemptId} />
      </UniverseStage>
    </UniverseWorld>
  );
}
