import type { MetadataRoute } from 'next';
import { ECHO_ICON } from '@/lib/brand/echoArt';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'English Coach',
    short_name: 'English Coach',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#eafaff',
    theme_color: '#0b78ea',
    icons: [
      { src: ECHO_ICON.png192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: ECHO_ICON.png512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: ECHO_ICON.maskable192, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: ECHO_ICON.maskable512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
