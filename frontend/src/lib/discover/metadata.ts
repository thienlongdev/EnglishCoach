import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ECHO_ICON } from '@/lib/brand/echoArt';
import { isCanonicalHost, ORIGIN, PUBLIC_PAGES, SITE_NAME, type PublicPath } from './pages';

export const privateRobots = { index: false, follow: false };

export async function publicMetadata(path: PublicPath): Promise<Metadata> {
  const canonical = new URL(path, ORIGIN).href;
  const { title, description } = PUBLIC_PAGES[path];
  const live = isCanonicalHost((await headers()).get('host'));
  const image = { url: new URL(ECHO_ICON.png512, ORIGIN).href, width: 512, height: 512, alt: 'Cá voi Echo của English Coach' };
  return {
    title, description, alternates: { canonical },
    robots: live ? { index: true, follow: true } : privateRobots,
    openGraph: { type: 'website', siteName: SITE_NAME, locale: 'vi_VN', url: canonical, title, description, images: [image] },
    twitter: { card: 'summary', title, description, images: [image] },
    verification: live && path === '/' ? {
      google: process.env.DISCOVER_GOOGLE_VERIFICATION,
      other: process.env.DISCOVER_BING_VERIFICATION ? { 'msvalidate.01': process.env.DISCOVER_BING_VERIFICATION } : undefined,
    } : undefined,
  };
}
