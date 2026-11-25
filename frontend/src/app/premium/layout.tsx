import { SWRConfig } from 'swr';
import { backendCandidates } from '@/lib/server/backend-origin';

// Render the same public catalog for the first page load and for client-side checkout.
export default async function PremiumLayout({ children }: { children: React.ReactNode }) {
  for (const origin of backendCandidates()) {
    try {
      const response = await fetch(`${origin}/api/v1/premium/plans`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) {
        const plans = await response.json();
        if (Array.isArray(plans)) {
          return <SWRConfig value={{ fallback: { '/premium/plans': plans } }}>{children}</SWRConfig>;
        }
      }
    } catch {
      // The client retries the public catalog if the server cannot reach it.
    }
  }
  return children;
}
