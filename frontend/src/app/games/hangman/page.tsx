'use client';
import { Suspense, useEffect, useState } from 'react';
import { AuthGuard } from '@/components/common/AuthGuard';
import { HangmanGame } from '@/components/features/games/hangman/HangmanGame';

export default function HangmanPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <div data-hangman-route>{mounted
    ? <AuthGuard><Suspense fallback={<div className="min-h-64 bg-surface" aria-busy="true" />}><HangmanGame /></Suspense></AuthGuard>
    : <div className="min-h-64 bg-surface" aria-busy="true" />}</div>;
}
