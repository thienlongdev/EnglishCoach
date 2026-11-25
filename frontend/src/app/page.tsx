import Home from '@/components/landing/Home';
import { StructuredData } from '@/components/discover/StructuredData';
import { privateRobots, publicMetadata } from '@/lib/discover/metadata';

type Props = { searchParams: Promise<{ tab?: string | string[] }> };

async function isLanding({ searchParams }: Props) {
  const { tab } = await searchParams;
  const first = Array.isArray(tab) ? tab[0] : tab;
  return !first || first === 'landing';
}

export async function generateMetadata(props: Props) {
  return await isLanding(props) ? publicMetadata('/') : { robots: privateRobots };
}

export default async function Page(props: Props) {
  return <>{await isLanding(props) && <StructuredData paths={['/']} />}<Home /></>;
}
