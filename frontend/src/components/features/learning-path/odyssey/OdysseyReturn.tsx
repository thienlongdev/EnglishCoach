'use client';
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { ArrowLeft, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { odysseyApi } from '@/lib/odyssey/api';
import { clearContext, contextId, contextLight, returnHref, saveContext, rememberWritingSession } from '@/lib/odyssey/navigation';
import type { LaunchView } from '@/lib/odyssey/types';
import s from './return.module.css';

/** Context only. A return never marks an activity complete; the world's server reconciliation does that. */
export default function OdysseyReturn() {
  const pathname = usePathname() || '', params = useSearchParams(); const { data: session } = useSession();
  const account = session?.user ? String((session.user as { id?: string | number }).id || session.user.email || '') : '';
  const { locale } = useLanguage(); const vi = locale !== 'en';
  const [context, setContext] = useState<{ account: string; data: LaunchView } | null>(null), [dismissed, setDismissed] = useState(false);
  const requested = params.get('odyssey');
  const writingSession = params.get('sessionId');
  const quiet = pathname.includes('/attempts/') || pathname.startsWith('/learning-path');
  useEffect(() => {
    setContext(null); setDismissed(false);
    const id = requested || contextId(account, pathname);
    if (!account || quiet || !id || !/^[0-9a-f-]{36}$/.test(id)) return;
    let active = true;
    void odysseyApi.launchById(id).then(data => {
      if (!active || !data || data.launch.requestId !== id) return;
      const module = data.href.split(/[/?#]/)[1]; if (pathname.split('/')[1] !== module) return;
      saveContext(account, data); setContext({ account, data });
    }).catch(() => { /* an unavailable context cannot block the activity */ });
    return () => { active = false; };
  }, [account, pathname, requested, quiet]);
  useEffect(() => {
    if (pathname === '/writing' && writingSession && context?.account === account)
      rememberWritingSession(account, context.data.launch.stationId, writingSession);
  }, [account, pathname, writingSession, context]);
  if (!context || context.account !== account || dismissed || quiet) return null;
  return <div className={s.returnBar} data-guide="odyssey-return"><Link href={returnHref(context.data.launch.regionId, context.data.launch.stationId)+(contextLight(account)?'&render=light':'')}><ArrowLeft size={16} />{vi ? 'Trở về Echo Odyssey' : 'Return to Echo Odyssey'}</Link><p>{vi ? 'Kết quả sẽ được đối chiếu khi trở về.' : 'Saved results will be checked when you return.'}</p><button aria-label={vi ? 'Ẩn lối về' : 'Hide return link'} onClick={() => { clearContext(account); setDismissed(true); }}><X size={16} /></button></div>;
}
