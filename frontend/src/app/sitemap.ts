import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { isCanonicalHost, ORIGIN, PUBLIC_PAGES } from '@/lib/discover/pages';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!isCanonicalHost((await headers()).get('host'))) return [];
  return Object.keys(PUBLIC_PAGES).map(path => ({ url: new URL(path, ORIGIN).href }));
}
