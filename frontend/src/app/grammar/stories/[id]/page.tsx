import { StoryPlayer } from '@/components/features/grammar/StoryPlayer';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** `/grammar/stories/<id>`: one story. */
export default async function GrammarStoryRoute({ params }: PageProps) {
  const { id } = await params;
  return <StoryPlayer key={id} id={id} />;
}
