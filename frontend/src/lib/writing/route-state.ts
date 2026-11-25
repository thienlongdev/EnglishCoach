import { WritingRouteState, WritingView, SentenceLabSubView } from '@/types/writing';

const VALID_VIEWS: Set<WritingView> = new Set(['translation', 'for-you', 'sentence-lab', 'typing', 'coach', 'portfolio']);
const VALID_SUB_VIEWS: Set<SentenceLabSubView> = new Set(['check', 'mistakes']);

/**
 * Parses searchParams into a sanitized, validated WritingRouteState.
 * Whitelists parameters and prevents prototype pollution / unexpected parameters.
 */
export function parseWritingRouteState(searchParams: URLSearchParams | { [key: string]: string | string[] | undefined }): WritingRouteState {
  const getParam = (key: string): string | undefined => {
    if (searchParams instanceof URLSearchParams) {
      const val = searchParams.get(key);
      return val ?? undefined;
    }
    const val = searchParams[key];
    if (Array.isArray(val)) return val[0];
    return val;
  };

  const rawView = (getParam('w') || getParam('view')) as WritingView;
  // Translation is the default writing view; 'for-you' is maintained as backward-compatible alias
  let view: WritingView = 'translation';
  if (rawView === 'for-you') {
    view = 'translation';
  } else if (VALID_VIEWS.has(rawView)) {
    view = rawView;
  }

  let subView: SentenceLabSubView | undefined;
  if (view === 'sentence-lab') {
    const rawSubView = (getParam('lab') || getParam('subView')) as SentenceLabSubView;
    subView = VALID_SUB_VIEWS.has(rawSubView) ? rawSubView : 'check';
  }

  return {
    view,
    mode: getParam('mode') || getParam('m'),
    subView,
    patternCode: getParam('patternCode'),
    sessionId: getParam('sessionId') || getParam('exercise') || getParam('exerciseId'),
    taskId: getParam('taskId'),
    draftId: getParam('draftId'),
    assessmentId: getParam('assessmentId'),
    practiceId: getParam('practiceId'),
  };
}

/**
 * Builds the URL query string for a target Writing state.
 * The Writing module's own address; `w` names the room.
 */
export function buildWritingUrl(state: Partial<WritingRouteState>): string {
  const params = new URLSearchParams();
  const view = state.view || 'translation';
  params.set('w', view);

  if (state.mode) params.set('mode', state.mode);

  if (view === 'sentence-lab' && state.subView) {
    params.set('lab', state.subView);
  }

  if (state.patternCode) params.set('patternCode', state.patternCode);
  if (state.sessionId) params.set('sessionId', state.sessionId);
  if (state.taskId) params.set('taskId', state.taskId);
  if (state.draftId) params.set('draftId', state.draftId);
  if (state.assessmentId) params.set('assessmentId', state.assessmentId);
  if (state.practiceId) params.set('practiceId', state.practiceId);

  return `/writing?${params.toString()}`;
}
