import React, { Suspense } from 'react';
import LessonWorkspace from '@/components/features/listening/workspace/LessonWorkspace';

/**
 * Overview and Dictation are two views of one mounted workspace (10 §BN): it lives here so that moving between them never recreates the player.
 * The two route files render nothing; they exist for their addresses.
 */
export default function ListeningLessonLayout({ children }: { children: React.ReactNode }) {
    return (
        <>
            <Suspense fallback={null}><LessonWorkspace /></Suspense>
            {children}
        </>
    );
}
