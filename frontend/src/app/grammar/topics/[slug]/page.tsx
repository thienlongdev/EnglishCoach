import { Suspense } from 'react';
import { TopicPage } from '@/components/features/grammar/TopicPage';

interface PageProps {
  params: Promise<{ slug: string }>;
}

/** `/grammar/topics/<slug>`: the lesson. The layer (`?layer=quick|lesson|deep`) is read on the client, in the URL. */
export default async function GrammarTopicRoute({ params }: PageProps) {
  const { slug } = await params;
  return (
    <Suspense fallback={null}>
      <TopicPage key={slug} slug={slug} />
    </Suspense>
  );
}
