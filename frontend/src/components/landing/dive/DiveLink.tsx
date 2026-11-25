'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ArrowRight } from 'lucide-react';
import { journeyActive, journeyGo } from '@/lib/journey/journey';
import styles from './dive.module.css';

// Only module routes that exist in the app tree; anything else falls back to the learner's home.
export const DIVE_DESTINATIONS = [
  '/flashcards',
  '/listening',
  '/speaking',
  '/reading',
  '/writing',
  '/grammar',
  '/exams',
  '/learning-path',
  '/progress',
  '/games',
  '/knowledge-universe',
  '/study-space',
  '/community',
  '/leaderboard',
  '/dashboard',
] as const;

export type DiveDestination = (typeof DIVE_DESTINATIONS)[number];

/**
 * A real link into the product. Its `href` is the module itself (crawlable, opens in a new tab as expected); a plain
 * click goes through the landing's passage: straight in for a signed-in learner, through sign-in (keeping the
 * destination) for a guest.
 */
export function DiveLink({ to, children, tone = 'aqua' }: { to: DiveDestination; children: React.ReactNode; tone?: 'aqua' | 'ink' | 'deep' }) {
  const router = useRouter();
  const { data: session } = useSession();

  const onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const safe = (DIVE_DESTINATIONS as readonly string[]).includes(to) ? to : '/dashboard';
    const target = session?.user ? safe : `/login?callbackUrl=${encodeURIComponent(safe)}`;
    if (!journeyActive() && !journeyGo(target)) router.push(target);
  };

  return (
    <a href={to} onClick={onClick} className={tone === 'ink' ? styles.linkInk : tone === 'deep' ? styles.linkDeep : styles.link}>
      <span>{children}</span>
      <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
    </a>
  );
}
