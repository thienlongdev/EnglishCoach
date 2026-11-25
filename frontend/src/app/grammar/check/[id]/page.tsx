import { Suspense } from 'react';
import { CheckRunner } from '@/components/features/grammar/CheckRunner';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** `/grammar/check/<id>`: a running or finished check. It is created by a button (POST) that then navigates here. */
export default async function GrammarCheckRoute({ params }: PageProps) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <CheckRunner key={id} checkId={id} />
    </Suspense>
  );
}
