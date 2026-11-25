import { LabPage } from '@/components/features/grammar/LabPage';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** `/grammar/lab/<id>`: one experiment. */
export default async function GrammarLabItemRoute({ params }: PageProps) {
  const { id } = await params;
  return <LabPage key={id} id={id} />;
}
