'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useModuleEntryResource } from '@/hooks/useModuleEntryResource';
import { TRANSLATION_CATALOG_PATH } from '@/services/moduleEntryResources';
import {
  TranslationCatalog,
  TranslationSession,
  TranslationStartRequest
} from '@/types/writing';
import {
  ParagraphCatalog,
  ParagraphSession,
  ParagraphStartRequest
} from '@/types/paragraphTranslation';
import { writingApi } from '@/services/writingApi';
import { paragraphTranslationApi } from '@/services/paragraphTranslationApi';
import { TranslationHome } from './TranslationHome';
import { TranslationWorkspace } from './TranslationWorkspace';
import { ParagraphHome } from './paragraph/ParagraphHome';
import { ParagraphWorkspace } from './paragraph/ParagraphWorkspace';
import { TranslationErrorBoundary } from './TranslationErrorBoundary';
import { AlertCircle, RefreshCw, ArrowLeft } from 'lucide-react';
import { StudioLoading, StatePanel, glass } from '../glass/WritingGlass';

interface TranslationPracticeProps {
  userId: number;
  sessionId?: string;
  initialSessionId?: string;
  initialMode?: 'SENTENCE' | 'PARAGRAPH';
  onNavigateSession?: (sessionId?: string, mode?: string) => void;
}

export const TranslationPractice: React.FC<TranslationPracticeProps> = ({
  userId,
  sessionId,
  initialSessionId,
  initialMode,
  onNavigateSession
}) => {
  const [mode, setMode] = useState<'SENTENCE' | 'PARAGRAPH'>(initialMode || 'SENTENCE');

  useEffect(() => {
    if (initialMode && initialMode !== mode) {
      setMode(initialMode);
    }
  }, [initialMode]);

  // SWR for Sentence Catalog with 30s deduping to prevent redundant tab toggling fetches
  const {
    data: swrCatalog,
    error: swrCatalogError,
    isLoading: swrCatalogLoading,
    mutate: mutateCatalog
  } = useModuleEntryResource<TranslationCatalog>(TRANSLATION_CATALOG_PATH);

  // SWR for Paragraph Catalog with 30s deduping
  const {
    data: swrParagraphCatalog,
    error: swrParagraphError,
    isLoading: swrParagraphLoading,
    mutate: mutateParagraphCatalog
  } = useModuleEntryResource<ParagraphCatalog>('/writing/translation/paragraphs/catalog', mode === 'PARAGRAPH');

  const catalog = swrCatalog || null;
  const loadingCatalog = swrCatalogLoading && !catalog;
  const catalogError = swrCatalogError
    ? (swrCatalogError?.response?.data?.message || 'Không thể tải danh mục bài tập luyện dịch. Vui lòng thử lại sau.')
    : null;

  const paragraphCatalog = swrParagraphCatalog || null;
  const loadingParagraphCatalog = swrParagraphLoading && !paragraphCatalog;

  const [activeSession, setActiveSession] = useState<TranslationSession | null>(null);
  const [loadingSession, setLoadingSession] = useState<boolean>(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [activeParagraphSession, setActiveParagraphSession] = useState<ParagraphSession | null>(null);

  const currentSessionId = sessionId || initialSessionId;

  // Load Sentence catalog data (revalidate SWR)
  const loadCatalog = useCallback(async () => {
    await mutateCatalog();
  }, [mutateCatalog]);

  // Load Paragraph catalog data (revalidate SWR)
  const loadParagraphCatalog = useCallback(async () => {
    await mutateParagraphCatalog();
  }, [mutateParagraphCatalog]);

  // Synchronize active session with currentSessionId from route (deep link, reload, Back & Forward)
  useEffect(() => {
    if (!currentSessionId) {
      setLoadingSession(false);
      setSessionError(null);
      if (activeSession) {
        setActiveSession(null);
        loadCatalog();
      }
      if (activeParagraphSession) {
        setActiveParagraphSession(null);
        loadParagraphCatalog();
      }
      return;
    }

    let isCancelled = false;
    const restoreSession = async () => {
      setLoadingSession(true);
      setSessionError(null);

      // Check if ID matches currently loaded session (handling para_ prefix)
      const cleanParaId = currentSessionId.replace(/^para_/, '');
      if (mode === 'PARAGRAPH' && activeParagraphSession?.sessionId === cleanParaId) {
        setLoadingSession(false);
        return;
      }
      if (mode === 'SENTENCE' && activeSession?.sessionId === currentSessionId) {
        setLoadingSession(false);
        return;
      }

      // If already in paragraph mode or prefix starts with para_, try paragraph first
      if (mode === 'PARAGRAPH' || currentSessionId.startsWith('para_')) {
        try {
          const paraSess = await paragraphTranslationApi.getSession(cleanParaId);
          if (!isCancelled) {
            setActiveParagraphSession(paraSess);
            setMode('PARAGRAPH');
            setLoadingSession(false);
            return;
          }
        } catch (paraErr) {
          if (mode === 'PARAGRAPH' || currentSessionId.startsWith('para_')) {
            if (!isCancelled) {
              setSessionError('Không thể tải phiên luyện dịch đoạn văn. Vui lòng quay về danh mục và thử lại.');
              setLoadingSession(false);
            }
            return;
          }
          console.warn('Paragraph session lookup failed, falling back to sentence lookup:', paraErr);
        }
      }

      // Try sentence session lookup
      try {
        const sess = await writingApi.getTranslationSession(currentSessionId);
        if (!isCancelled) {
          setActiveSession(sess);
          setMode('SENTENCE');
          setLoadingSession(false);
          return;
        }
      } catch (err: any) {
        // Try paragraph session lookup before failing
        try {
          const paraSess = await paragraphTranslationApi.getSession(cleanParaId);
          if (!isCancelled) {
            setActiveParagraphSession(paraSess);
            setMode('PARAGRAPH');
            setLoadingSession(false);
            return;
          }
        } catch {
          if (!isCancelled) {
            console.error('Failed to load translation session:', err);
            setSessionError(
              err?.response?.data?.message ||
              'Không thể tải phiên dịch đã chọn. Bạn có thể quay lại trang chủ để bắt đầu phiên mới.'
            );
          }
        }
      } finally {
        if (!isCancelled) {
          setLoadingSession(false);
        }
      }
    };

    restoreSession();

    return () => {
      isCancelled = true;
      setLoadingSession(false);
    };
  }, [currentSessionId, mode, activeSession?.sessionId, activeParagraphSession?.sessionId, loadCatalog, loadParagraphCatalog]);

  // Sentence Mode handlers
  const handleStartSentenceSession = async (request: TranslationStartRequest) => {
    setLoadingSession(true);
    setSessionError(null);
    try {
      const sess = await writingApi.startTranslationSession(request);
      setActiveSession(sess);
      if (onNavigateSession) {
        onNavigateSession(sess.sessionId);
      }
    } catch (err: any) {
      console.error('Failed to start sentence translation session:', err);
      setSessionError(
        err?.response?.data?.message ||
        'Không thể khởi tạo phiên luyện dịch câu đơn. Vui lòng thử lại.'
      );
    } finally {
      setLoadingSession(false);
    }
  };

  const handleResumeSentenceSession = (targetSessionId: string) => {
    if (onNavigateSession) {
      onNavigateSession(targetSessionId, 'sentence');
    }
  };

  const handleBackToSentenceHome = () => {
    setLoadingSession(false);
    setActiveSession(null);
    setSessionError(null);
    if (onNavigateSession) {
      onNavigateSession(undefined, 'sentence');
    }
    loadCatalog();
  };

  // Paragraph Mode handlers
  const handleStartParagraphSession = async (request: ParagraphStartRequest) => {
    setLoadingSession(true);
    setSessionError(null);
    try {
      const sess = await paragraphTranslationApi.startSession(request);
      setActiveParagraphSession(sess);
      if (onNavigateSession) {
        onNavigateSession(`para_${sess.sessionId}`, 'paragraph');
      }
    } catch (err: any) {
      console.error('Failed to start paragraph session:', err);
      setSessionError(
        err?.response?.data?.message ||
        'Không thể khởi tạo phiên luyện dịch đoạn văn. Vui lòng thử lại.'
      );
    } finally {
      setLoadingSession(false);
    }
  };

  const handleResumeParagraphSession = (targetSessionId: string) => {
    if (onNavigateSession) {
      onNavigateSession(`para_${targetSessionId}`, 'paragraph');
    }
  };

  const handleBackToParagraphHome = () => {
    setLoadingSession(false);
    setActiveParagraphSession(null);
    setSessionError(null);
    if (onNavigateSession) {
      onNavigateSession(undefined, 'paragraph');
    }
    loadParagraphCatalog();
  };

  return (
    <TranslationErrorBoundary>
      <div className="w-full">
        {/* Loading Session Overlay */}
        {loadingSession && (
          <StudioLoading text="Đang chuẩn bị phiên luyện dịch..." />
        )}

        {/* Session Error State */}
        {sessionError && !loadingSession && (
          <div className="max-w-xl mx-auto my-6">
            <StatePanel
              kind="error"
              icon={<AlertCircle />}
              title="Không thể mở phiên luyện dịch"
              text={sessionError}
              actions={
                <button
                  type="button"
                  onClick={mode === 'PARAGRAPH' ? handleBackToParagraphHome : handleBackToSentenceHome}
                  className={`${glass.btn} ${glass.btnPrimary}`}
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Quay về danh mục</span>
                </button>
              }
            />
          </div>
        )}

        {/* Catalog Error State */}
        {catalogError && !activeSession && !activeParagraphSession && !loadingSession && (
          <div className="max-w-xl mx-auto my-6">
            <StatePanel
              kind="error"
              icon={<AlertCircle />}
              title="Lỗi kết nối danh mục"
              text={catalogError}
              actions={
                <button
                  type="button"
                  onClick={loadCatalog}
                  className={`${glass.btn} ${glass.btnPrimary}`}
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Thử lại</span>
                </button>
              }
            />
          </div>
        )}

        {/* Mode View: Sentence vs Paragraph */}
        {!loadingSession && !sessionError && (
          mode === 'PARAGRAPH' ? (
            activeParagraphSession ? (
              <ParagraphWorkspace
                session={activeParagraphSession}
                userId={userId}
                onBackToHome={handleBackToParagraphHome}
                onSessionUpdated={setActiveParagraphSession}
              />
            ) : (
              <ParagraphHome
                catalog={paragraphCatalog}
                loading={loadingParagraphCatalog}
                onStartSession={handleStartParagraphSession}
                onResumeSession={handleResumeParagraphSession}
                onSelectSentenceMode={() => {
                  setMode('SENTENCE');
                  if (onNavigateSession) {
                    onNavigateSession(undefined, 'sentence');
                  }
                }}
              />
            )
          ) : (
            activeSession ? (
              <TranslationWorkspace
                session={activeSession}
                userId={userId}
                onBackToHome={handleBackToSentenceHome}
                onSessionUpdated={setActiveSession}
              />
            ) : (
              <TranslationHome
                catalog={catalog}
                loading={loadingCatalog}
                onStartSession={handleStartSentenceSession}
                onResumeSession={handleResumeSentenceSession}
                onSelectMode={(selected) => {
                  if (selected === 'PARAGRAPH') {
                    setMode('PARAGRAPH');
                    if (onNavigateSession) {
                      onNavigateSession(undefined, 'paragraph');
                    }
                  }
                }}
              />
            )
          )
        )}
      </div>
    </TranslationErrorBoundary>
  );
};
