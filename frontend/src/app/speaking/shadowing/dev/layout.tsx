import { notFound } from 'next/navigation';

/**
 * Development / QA pages only. A production build answers 404 here (security closure 2026-10: no developer or
 * acceptance page is reachable on the live site); Nginx refuses the same paths as a second layer.
 */
export default function DevelopmentOnlyLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === 'production') notFound();
  return children;
}
