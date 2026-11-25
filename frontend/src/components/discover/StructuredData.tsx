import { headers } from 'next/headers';
import { ORIGIN, PUBLIC_PAGES, SITE_NAME, type PublicPath } from '@/lib/discover/pages';

export async function StructuredData({ paths }: { paths: PublicPath[] }) {
  const data = paths.length === 1 ? {
    '@context': 'https://schema.org', '@type': 'WebSite',
    '@id': ORIGIN + '/#website', name: SITE_NAME, alternateName: [PUBLIC_PAGES['/'].title, 'EnglishCoach'],
    url: ORIGIN + '/', inLanguage: 'vi',
  } : {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: paths.map((path, index) => ({
      '@type': 'ListItem', position: index + 1, name: PUBLIC_PAGES[path].title, item: new URL(path, ORIGIN).href,
    })),
  };
  return <script nonce={(await headers()).get('x-nonce') ?? undefined} type="application/ld+json">
    {JSON.stringify(data).replace(/</g, '\\u003c')}
  </script>;
}
