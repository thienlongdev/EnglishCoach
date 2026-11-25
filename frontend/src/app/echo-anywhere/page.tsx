import { EchoAnywherePage } from '@/components/echoAnywhere/EchoAnywherePage';
import { publicMetadata } from '@/lib/discover/metadata';

export const generateMetadata = () => publicMetadata('/echo-anywhere');

export default function Page() {
  return <EchoAnywherePage />;
}
