import { notFound, redirect } from 'next/navigation';

interface PageProps {
  params: Promise<{
    family: string;
    formId: string;
  }>;
}

/**
 * Exams Phase 6 route kept for existing links. Exams Phase 7: scope selection lives on the test detail page
 * (`/exams/[family]/tests/[formId]`, section "Luyện theo phần"), so this route only redirects there.
 */
export default async function PracticeScopesPage({ params }: PageProps) {
  const { family: rawFamily, formId } = await params;
  const familySlug = rawFamily.toLowerCase();
  if (familySlug !== 'ielts' && familySlug !== 'toeic') {
    notFound();
  }
  redirect(`/exams/${familySlug}/tests/${encodeURIComponent(formId)}#practice`);
}
