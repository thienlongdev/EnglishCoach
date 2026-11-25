import type { ReactNode } from 'react';
import { AuthGuard } from '@/components/common/AuthGuard';
import { GrammarNav } from '@/components/features/grammar/GrammarNav';
import { GrammarAtmosphere } from '@/components/features/grammar/GrammarAtmosphere';
import styles from '@/components/features/grammar/grammar.module.css';

/**
 * Echo Grammar Academy. Signed-in learners only. `.world` carries the tokens (and paints the page only when no wallpaper is on);
 * `.shell` fills the workspace; lesson prose keeps its own reading measure.
 */
export default function GrammarLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <GrammarAtmosphere className={styles.world}>
        <div className={styles.shell}>
          <GrammarNav />
          {children}
        </div>
      </GrammarAtmosphere>
    </AuthGuard>
  );
}
