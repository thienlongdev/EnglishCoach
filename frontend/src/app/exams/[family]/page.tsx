import React from 'react';
import { notFound } from 'next/navigation';
import { ExamsFamilyPage } from '@/components/features/exams/ExamsFamilyPage';
import { ExamFamily } from '@/types/exams';

interface PageProps {
  params: Promise<{
    family: string;
  }>;
  searchParams: Promise<{
    view?: 'overview' | 'library' | 'history' | 'progress';
  }>;
}

export default async function FamilyRoutePage({ params, searchParams }: PageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;

  const rawFamily = resolvedParams.family.toLowerCase();
  if (rawFamily !== 'ielts' && rawFamily !== 'toeic') {
    notFound();
  }

  const family: ExamFamily = rawFamily === 'ielts' ? 'IELTS' : 'TOEIC';
  const initialView = resolvedSearchParams.view || 'library';

  return <ExamsFamilyPage family={family} initialView={initialView} />;
}
