'use client';
import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { prepareIdentity, profileKey } from '../../services/profileIdentityResource';
import { prepareWeeklyBoard } from '../../services/leaderboardSnapshots';
import { communityApi } from '../../services/communityApi';
import { getCachedFeed, setCachedFeed, deduplicateRequest } from '../../services/communityCache';
import { contentPaths } from '../../lib/content-system-snapshots';
import { prepareContentCards } from '../../services/contentSystemResources';
import { authEpoch, authEnding } from '../../lib/auth-lifecycle';
import { useSWRConfig, unstable_serialize } from 'swr';
import { useModuleEntryScope } from '../../hooks/useModuleEntryResource';
import { prepareEntryResources } from '../../lib/module-entry-core';
import { entryKey, clearModuleEntryRequests, prepareModuleEntry, READING_ENTRY_PATH, FLASHCARD_CATALOG_PATH, FLASHCARD_PROGRESS_PATH, SYSTEM_CATEGORIES_PATH, WRITING_CAPABILITIES_PATH, TRANSLATION_CATALOG_PATH, SPEAKING_METADATA_PATH } from '../../services/moduleEntryResources';

export function ModuleEntryPreparation() {
  const scope = useModuleEntryScope();
  const { data: session } = useSession();
  const email = session?.user?.email;
  const { cache } = useSWRConfig();
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    const started = authEpoch();
    const isCancelled = () => cancelled || authEnding() || started !== authEpoch();
    // Defer until the authenticated shell has painted. Only lightweight catalogs; concurrency 1.
    const timer = setTimeout(() => {
      void prepareEntryResources([FLASHCARD_CATALOG_PATH, FLASHCARD_PROGRESS_PATH, READING_ENTRY_PATH, 'profile', 'community', 'leaderboard', SYSTEM_CATEGORIES_PATH, WRITING_CAPABILITIES_PATH, TRANSLATION_CATALOG_PATH, SPEAKING_METADATA_PATH, ...contentPaths()],
        async path => {
          if (path === 'profile') {
            if (email && !cache.get(unstable_serialize(profileKey(email)))?.data) await prepareIdentity(email, isCancelled);
            return;
          }
          if (path === 'community') {
            const feedKey = 'feed_public_ALL';
            if (getCachedFeed(scope, feedKey)?.isStale === false) return;
            const data = await deduplicateRequest(`req_${scope}_${feedKey}_p0`, () => communityApi.getPublicFeed(0, 10));
            if (!isCancelled()) setCachedFeed(scope, feedKey, { posts: data.posts, page: data.page, hasMore: data.hasMore });
            return;
          }
          if (path === 'leaderboard') { if (email) await prepareWeeklyBoard(email, isCancelled); return; }
          if (path.startsWith('/content/')) { await prepareContentCards(path, isCancelled); return; }
          if (cache.get(unstable_serialize(entryKey(path, scope)))?.data !== undefined) return;
          await prepareModuleEntry(path, scope, isCancelled);
        }, isCancelled);
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); clearModuleEntryRequests(); };
  }, [scope, email, cache]);
  return null;
}
