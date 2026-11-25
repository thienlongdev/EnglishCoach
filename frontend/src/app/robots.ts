import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { isCanonicalHost, ORIGIN } from '@/lib/discover/pages';

export default async function robots(): Promise<MetadataRoute.Robots> {
  if (!isCanonicalHost((await headers()).get('host'))) return { rules: { userAgent: '*', disallow: '/' } };
  return { rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/admin/'] }, sitemap: ORIGIN + '/sitemap.xml' };
}
