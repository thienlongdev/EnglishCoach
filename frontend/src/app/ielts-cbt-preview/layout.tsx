import { notFound } from 'next/navigation';

/**
 * Development / QA preview page only. A production build answers 404 here so no preview
 * harness is reachable on the live site.
 */
export default function DevelopmentOnlyLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === 'production') notFound();
  return children;
}
