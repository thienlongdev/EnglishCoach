import { Suspense } from 'react';
import { PracticeStudio } from '@/components/features/grammar/PracticeStudio';

/** `/grammar/practice`: the Practice Studio. Mode and filters (`?kind=mixed|mistakes|due&domain=&level=&type=`) live in the address. */
export default function GrammarPracticeRoute() {
  return (
    <Suspense fallback={null}>
      <PracticeStudio />
    </Suspense>
  );
}
