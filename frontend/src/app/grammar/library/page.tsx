import { Suspense } from 'react';
import { Library } from '@/components/features/grammar/Library';

/** `/grammar/library`: the whole reference. Every filter is read from the query string on the client. */
export default function GrammarLibraryRoute() {
  return (
    <Suspense fallback={null}>
      <Library />
    </Suspense>
  );
}
