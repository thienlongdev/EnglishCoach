'use client';

import React, { Suspense } from 'react';
import { AuthPageView, AuthLoading } from '@/app/login/page';

export default function RegisterPage() {
  return (
    <Suspense fallback={<AuthLoading variant="register" />}>
      <AuthPageView defaultTab="register" />
    </Suspense>
  );
}
