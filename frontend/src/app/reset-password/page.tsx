'use client';

import React, { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthShell } from '@/components/auth/AuthShell';
import { AuthCard } from '@/components/auth/AuthCard';
import type { MascotState } from '@/components/auth/AuthEchoMascot';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';
import { AuthLoading } from '@/app/login/page';

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [mascotState, setMascotState] = useState<MascotState>('idle');

  return (
    <AuthShell mood={mascotState}>
      <AuthCard>
        <ResetPasswordForm token={token} onMascotStateChange={setMascotState} />
      </AuthCard>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthLoading variant="login" />}>
      <ResetPasswordContent />
    </Suspense>
  );
}
