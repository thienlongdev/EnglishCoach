'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useSearchParams } from 'next/navigation';
import { useLanguage } from '@/context/LanguageContext';
import { useUnifiedStreak } from '@/hooks/useUnifiedStreak';
import { activeGuide, activeGuideStart, guidePanelOpen, guideRecord, markGuideInvited, pendingGuide, setGuideProfile, startGuide, subscribeGuide, setPendingGuide, openGuidePanel, markGuide, setGuideOffering } from '@/lib/guide/store';
import { guideById, nextOffer, routeMatches } from '@/lib/guide/registry';
import { offerBlocked } from '@/lib/guide/quiet';
import { GuideTour } from './GuideTour';
import { GuidePanel } from './GuidePanel';
import { GuideOffer } from './GuideOffer';

/** How long a screen stays quiet after it opens, and how long between two offers. A guide is help, never an interruption. */
const SETTLE_MS = 1500;
const BETWEEN_OFFERS_MS = 45_000;
const OFFERS_PER_VISIT = 2;
/** On a lesson or a session Echo may ask only in the first moments, before the learner has started anything. */
const ENTRY_WINDOW_MS = 7000;

export default function GuideRuntime() {
  const pathname = usePathname() || '/';
  const tab = useSearchParams().get('tab');
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const active = useSyncExternalStore(subscribeGuide, activeGuide, () => null);
  const panel = useSyncExternalStore(subscribeGuide, guidePanelOpen, () => false);
  const pending = useSyncExternalStore(subscribeGuide, pendingGuide, () => null);
  const profile = useSyncExternalStore(subscribeGuide, () => guideRecord().profile, () => null);
  const auto = useSyncExternalStore(subscribeGuide, () => guideRecord().auto, () => true);
  const invited = useSyncExternalStore(subscribeGuide, () => guideRecord().invited === true, () => false);
  const { streak, error } = useUnifiedStreak();
  const [offerId, setOfferId] = useState<string | null>(null);
  const [invite, setInvite] = useState(false);
  const counted = useRef({ offers: 0, lastAt: 0 });

  // Who is this? A learner with a history is not walked through what they already use: one quiet invitation, and the switch stays theirs. An unreadable history counts as a history.
  useEffect(() => {
    if (profile) return;
    if (error) {
      setGuideProfile('returning');
      return;
    }
    if (!streak) return;
    setGuideProfile((streak.longestStreakDays ?? 0) >= 2 || (streak.currentStreakDays ?? 0) >= 2 ? 'returning' : 'new');
  }, [profile, streak, error]);

  // A guide asked for from another page starts once its screen is really there.
  useEffect(() => {
    if (!pending) return;
    const def = guideById(pending);
    if (!def) {
      setPendingGuide(null);
      return;
    }
    if (!routeMatches(def, pathname, tab)) return;
    const timer = window.setTimeout(() => startGuide(pending), 500);
    return () => window.clearTimeout(timer);
  }, [pending, pathname, tab]);

  // Offers: at most one card, at most twice a visit, only on a calm screen, only what this screen is and what this account has not seen.
  const enteredAt = useRef(Date.now());
  useEffect(() => {
    enteredAt.current = Date.now();
    setOfferId(null);
    setInvite(false);
  }, [pathname, tab]);
  useEffect(() => {
    if (active || panel || pending || !profile) return;
    let timer = 0;
    const look = () => {
      timer = window.setTimeout(look, 1800);
      if (document.hidden || Date.now() - enteredAt.current < SETTLE_MS) return;
      if (offerId || invite) return;
      const c = counted.current;
      if (c.offers >= OFFERS_PER_VISIT || Date.now() - c.lastAt < BETWEEN_OFFERS_MS) return;
      if (offerBlocked()) return;
      const record = guideRecord();
      if (profile === 'returning' && !record.auto) {
        if (record.invited) return;
        c.offers += 1;
        c.lastAt = Date.now();
        setInvite(true);
        return;
      }
      if (!record.auto) return;
      const def = nextOffer(pathname, tab, record.guides);
      if (!def) return;
      if (def.entryOnly && Date.now() - enteredAt.current > ENTRY_WINDOW_MS) return;
      if (def.gate && !document.querySelector(def.gate)) return;
      c.offers += 1;
      c.lastAt = Date.now();
      markGuide(def.id, 'offered', def.version);
      setOfferId(def.id);
    };
    look();
    return () => window.clearTimeout(timer);
  }, [active, panel, pending, profile, auto, invited, pathname, tab, offerId, invite]);

  // The companion's own small words wait while Echo is asking something else.
  useEffect(() => {
    setGuideOffering(!!offerId || invite);
    return () => setGuideOffering(false);
  }, [offerId, invite]);

  const def = active ? guideById(active) : null;
  const offer = offerId ? guideById(offerId) : null;
  return createPortal(
    <>
      {def && <GuideTour key={def.id} def={def} startAt={activeGuideStart()} vi={vi} pathname={pathname} />}
      {panel && <GuidePanel pathname={pathname} tab={tab} vi={vi} />}
      {!active && !panel && offer && (
        <GuideOffer
          title={vi ? offer.title.vi : offer.title.en}
          text={vi ? offer.summary.vi : offer.summary.en}
          primary={vi ? 'Xem nhanh' : 'Show me'}
          later={vi ? 'Để sau' : 'Later'}
          onPrimary={() => {
            setOfferId(null);
            startGuide(offer.id);
          }}
          onLater={() => setOfferId(null)}
          vi={vi}
        />
      )}
      {!active && !panel && !offer && invite && (
        <GuideOffer
          title={vi ? 'Có hướng dẫn mới' : 'New: Echo Guide'}
          text={vi ? 'Muốn xem cách dùng một tính năng? Nhấn dấu hỏi ở thanh trên cùng.' : 'Want to see how a feature works? Press the question mark in the top bar.'}
          primary={vi ? 'Mở hướng dẫn' : 'Open guides'}
          later={vi ? 'Để sau' : 'Later'}
          onPrimary={() => {
            setInvite(false);
            markGuideInvited();
            openGuidePanel();
          }}
          onLater={() => {
            setInvite(false);
            markGuideInvited();
          }}
          vi={vi}
        />
      )}
    </>,
    document.body,
  );
}
