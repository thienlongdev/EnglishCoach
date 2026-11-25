import { DetectivePage } from '@/components/features/grammar/DetectivePage';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** `/grammar/detective/<id>`: one case. */
export default async function GrammarCaseRoute({ params }: PageProps) {
  const { id } = await params;
  return <DetectivePage key={id} id={id} />;
}
