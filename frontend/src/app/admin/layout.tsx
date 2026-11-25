import React from 'react';
import { AdminSecurityGate } from '@/components/features/admin-security/AdminSecurityGate';

/**
 * Every /admin page: the administrator passes (or enrols) the second factor here before any administrator tool is
 * shown, and sensitive actions open their step-up dialog from here. The enforcement itself is on the backend.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminSecurityGate>{children}</AdminSecurityGate>;
}
