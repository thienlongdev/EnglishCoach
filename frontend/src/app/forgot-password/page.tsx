'use client';

import React, { Suspense } from 'react';
import { AuthPageView } from '@/app/login/page';

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen w-full bg-slate-950 text-slate-100" />}>
      <AuthPageView defaultViewState="forgot" />
    </Suspense>
  );
}
