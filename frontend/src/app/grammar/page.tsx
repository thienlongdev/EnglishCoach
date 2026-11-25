import { GrammarHome } from '@/components/features/grammar/GrammarHome';

/** `/grammar`: the academy's home (resume, next steps, start, the path, areas, tracks). */
export default function GrammarHomeRoute() {
  return <Suspense fallback={null}><GrammarHome /></Suspense>;
}
import { Suspense } from 'react';
