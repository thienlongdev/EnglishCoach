'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { DoorOpen } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAccount } from './data';
import { studyReturn } from '@/lib/study-space/exploration';
import { markWorldPassage } from '@/lib/morph/scene';
import { journeyGo } from '@/lib/journey/journey';

/** A tab-local route receipt only. Personal room data is always read through the existing owner-scoped API. */
export function useStudyReturn() {
  const account = useAccount(), params = useSearchParams(), path = usePathname();
  const direct = studyReturn(new URLSearchParams(params.toString()));
  const [saved, setSaved] = useState<{ account: string; href: string } | null>(null);
  useEffect(() => {
    setSaved(null);
    if (!account) return;
    const key = `ec_study_journey:u${account}`;
    try {
      if (direct && (path === '/games' || path === '/speaking/arena')) {
        sessionStorage.setItem(key, JSON.stringify({ href: direct, destination: path, at: Date.now() }));
        setSaved({ account, href: direct });
      } else if (path === '/games' || path === '/speaking/arena') {
        const receipt = JSON.parse(sessionStorage.getItem(key) || 'null');
        if (receipt?.destination === path && Number.isFinite(receipt.at) && Date.now() >= receipt.at && Date.now() - receipt.at < 86400000 && /^\/study-space\?space=[a-zA-Z0-9-]{1,64}$/.test(receipt.href)) setSaved({ account, href: receipt.href });
      } else if (path === '/study-space') sessionStorage.removeItem(key);
    } catch { /* Deep links still work with denied session storage. */ }
  }, [account, direct, path]);
  return direct || (saved?.account === account ? saved.href : null);
}
export default function StudyReturn() {
  const href = useStudyReturn(), path = usePathname(), { locale } = useLanguage();
  if (!href || path !== '/games') return null;
  return <div className="px-4 py-2 bg-surface-container border-b border-outline-variant/30" data-morph-source="study-return">
    <Link href={href} onClick={(e)=>{markWorldPassage('/study-space');if(!e.defaultPrevented&&e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&journeyGo(href))e.preventDefault();}} prefetch={false} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><DoorOpen size={17}/>{locale === 'vi' ? 'Trở về phòng học của tôi' : 'Return to my study room'}</Link>
  </div>;
}
