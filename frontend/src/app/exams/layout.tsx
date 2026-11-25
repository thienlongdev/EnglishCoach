'use client';

import React from 'react';
import { AuthGuard } from '@/components/common/AuthGuard';

export default function ExamsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      {children}
    </AuthGuard>
  );
}
