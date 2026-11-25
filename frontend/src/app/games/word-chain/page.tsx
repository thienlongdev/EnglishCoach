'use client';
import { Suspense, useEffect, useState } from 'react';
import { AuthGuard } from '@/components/common/AuthGuard';
import { WordChainGame } from '@/components/features/games/word-chain/WordChainGame';

export default function WordChainPage() {
  // AuthGuard optimistically reads browser storage while loading. Defer it until
  // hydration so this route's first client tree matches its server placeholder.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="min-h-64 bg-surface" aria-busy="true" />;
  return <AuthGuard><Suspense fallback={<div className="min-h-64 bg-surface" aria-busy="true" />}><WordChainGame /></Suspense></AuthGuard>;
}
