import React from 'react';
import { notFound } from 'next/navigation';
import { ExamFormDetail } from '@/components/features/exams/ExamFormDetail';
import { ExamFamily } from '@/types/exams';

interface PageProps {
  params: Promise<{
    family: string;
    formId: string;
  }>;
}

/** Exams Phase 7: test detail — "Thi đầy đủ" and "Luyện theo phần" of one test. */
export default async function ExamTestDetailPage({ params }: PageProps) {
  const { family: rawFamily, formId } = await params;
  const familySlug = rawFamily.toLowerCase();
  if (familySlug !== 'ielts' && familySlug !== 'toeic') {
    notFound();
  }
  const family: ExamFamily = familySlug === 'ielts' ? 'IELTS' : 'TOEIC';
  return <ExamFormDetail family={family} formId={formId} />;
}
