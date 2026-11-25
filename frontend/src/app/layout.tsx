import type { Metadata, Viewport } from 'next'
import { connection } from 'next/server'
import { headers } from 'next/headers'
import { Quicksand } from 'next/font/google'
import './globals.css'
import './echo-ocean.css'
import { Providers } from './providers'
import ApplicationFrame from '@/components/layout/ApplicationFrame'
import { ECHO_ICON } from '@/lib/brand/echoArt'
import { resolvePageTitle } from '@/lib/brand/pageTitle'
import { privateRobots } from '@/lib/discover/metadata'
import { ORIGIN } from '@/lib/discover/pages'

// The one product typeface (owner choice 2026-10-15). Variable font, weights 300–700; self-hosted by next/font at
// build time (no runtime request to Google; every subset is self-hosted, `subsets` only picks the preloaded files).
// Bolder utility weights (800/900) resolve to 700. The landing hero headline is Quicksand too (owner brief 2026-10-31).
const quicksand = Quicksand({
  subsets: ['latin', 'vietnamese'],
  variable: '--font-quicksand',
  display: 'swap',
})

// One architecture for the tab title: the same table on the server (first paint) and on the client (lib/brand/tabTitle).
// The landing page is exactly "English Coach"; every other page is named after what is on it, with no brand suffix.
export async function generateMetadata(): Promise<Metadata> {
  const request = await headers()
  return {
    title: resolvePageTitle(request.get('x-ec-path') ?? '/', request.get('x-ec-tab') || null, 'vi').title,
    metadataBase: new URL(ORIGIN),
    robots: privateRobots,
    // The owner's blue whale (public/brand/echo, content-hashed: Nginx caches images as immutable for a year). One icon
    // link on purpose: the living favicon swaps this one link's picture while the tab is open (lib/brand/livingFavicon).
    icons: {
      icon: [{ url: ECHO_ICON.ico, sizes: '16x16 32x32 48x48 64x64' }],
      apple: ECHO_ICON.touch,
    },
  }
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

// Both run before the first paint: plain inline scripts in <head>, carrying this response's nonce. `next/script` beforeInteractive only queues them for the client
// bootstrap, after the first paint, which showed the light sea and then the dark one. Written with backticks and without < > & so they survive as script text unchanged.
const APPEARANCE_BOOT = 'try{var l=location,p=l.pathname,t=new URLSearchParams(l.search).get(`tab`),h=function(x){return p.indexOf(x)===0},own=(p===`/`?(!t||t===`landing`):false)||h(`/landing-preview`)||(p.indexOf(`/exams/`)+1?p.indexOf(`/attempts/`)+1:0)||h(`/games/echo-garden`)||h(`/games/echo-quiz-rush`);if(!own){var s=localStorage.getItem(`theme`);if(s===`dark`||(s?false:matchMedia(`(prefers-color-scheme: dark)`).matches))document.documentElement.classList.add(`dark`)}}catch(e){}'

// A page entered through a full load mid-journey (back from Google, after signing out) opens on the same water, not on a blank one. Only a kind and a time are read (10 §BK).
const JOURNEY_BOOT = 'try{var r=sessionStorage.getItem(`ec_journey`);if(r){var j=JSON.parse(r),m=(j.kind===`oauth`?6e5:j.kind===`signout`||j.kind===`fresh`?3e4:0)-(Date.now()-j.at);if(m===Math.abs(m))document.documentElement.setAttribute(`data-journey-boot`,j.kind)}}catch(e){}'

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Every page is rendered per request so that its scripts carry that request's CSP nonce (src/proxy.ts).
  await connection()
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    <html lang="vi" className={`${quicksand.variable} bg-surface text-on-surface`} suppressHydrationWarning>
      <head>
        <noscript><link rel="stylesheet" href="/discover-noscript.css" /></noscript>
        {/* The workspace paints in the learner's appearance from the first frame (same rule as TopNavbar). Pages with their
            own fixed look (landing, exam attempt, standalone games) keep it. */}
        <script id="ec-appearance" nonce={nonce} suppressHydrationWarning>{APPEARANCE_BOOT}</script>
        <script id="ec-journey" nonce={nonce} suppressHydrationWarning>{JOURNEY_BOOT}</script>
        {/* Material Symbols is self-hosted (globals.css @font-face, /fonts/material-symbols-outlined.woff2: the same variable
            font, FILL / GRAD / opsz / wght). The render-blocking Google stylesheet every route used to fetch first is gone
            (performance release 2026-11-16, PERF-26); the file downloads only where an icon is drawn. */}
      </head>
      <body className="font-sans antialiased bg-surface text-on-surface">
        <Providers>
          <ApplicationFrame>
            {children}
          </ApplicationFrame>
        </Providers>
      </body>
    </html>
  )
}
