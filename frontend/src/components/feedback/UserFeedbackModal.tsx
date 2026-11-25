'use client';

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  MessageSquare,
  Clock,
  ChevronLeft,
  Info,
} from 'lucide-react';
import { feedbackApi } from '@/services/feedbackApi';
import {
  CreateFeedbackPayload,
  FeedbackCategory,
  FeedbackMessage,
  FeedbackThread,
} from '@/types/feedback';
import { useMyFeedbackList } from '@/hooks/useFeedback';
import { subscribeRealtimeTopic } from '@/services/stompClient';

interface UserFeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
}

const CATEGORIES: { key: FeedbackCategory; label: string; icon: string }[] = [
  { key: 'IDEA', label: 'Ý tưởng', icon: '💡' },
  { key: 'BUG', label: 'Báo lỗi', icon: '🪲' },
  { key: 'UI', label: 'Giao diện', icon: '🎨' },
  { key: 'CONTENT', label: 'Nội dung', icon: '🧾' },
  { key: 'OTHER', label: 'Khác', icon: '💬' },
];

export function UserFeedbackModal({ isOpen, onClose, onSubmitted }: UserFeedbackModalProps) {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<'WRITE' | 'MINE'>('WRITE');

  // Form state
  const [category, setCategory] = useState<FeedbackCategory>('IDEA');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Conversation history state
  const { threads, isLoading: isLoadingThreads, mutateThreads } = useMyFeedbackList(isOpen);
  const [selectedThread, setSelectedThread] = useState<FeedbackThread | null>(null);
  const [messages, setMessages] = useState<FeedbackMessage[]>([]);
  const [threadMessagesCache, setThreadMessagesCache] = useState<Record<number, FeedbackMessage[]>>({});
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [followUpContent, setFollowUpContent] = useState('');
  const [isSendingFollowUp, setIsSendingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  // Close on Escape key press
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Reset state on open/close
  useEffect(() => {
    if (!isOpen) {
      setSelectedThread(null);
      setErrorMsg(null);
      setSuccessMsg(null);
    }
  }, [isOpen]);

  // Real-time chat sync for active thread (Messenger-like live updates)
  useEffect(() => {
    if (!isOpen || !selectedThread?.id) return;
    const threadId = selectedThread.id;

    const unsub = subscribeRealtimeTopic<FeedbackMessage>(`/topic/feedback/${threadId}`, (incomingMsg) => {
      if (!incomingMsg || !incomingMsg.id) return;

      setMessages((prev) => {
        if (prev.some((m) => m.id === incomingMsg.id)) {
          return prev;
        }
        const optimisticIndex = prev.findIndex(
          (m) => m.id < 0 && m.content === incomingMsg.content && m.fromAdmin === incomingMsg.fromAdmin
        );
        if (optimisticIndex !== -1) {
          const next = [...prev];
          next[optimisticIndex] = incomingMsg;
          return next;
        }
        return [...prev, incomingMsg];
      });

      setThreadMessagesCache((prev) => {
        const cached = prev[threadId] || [];
        if (cached.some((m) => m.id === incomingMsg.id)) {
          return prev;
        }
        const optIdx = cached.findIndex(
          (m) => m.id < 0 && m.content === incomingMsg.content && m.fromAdmin === incomingMsg.fromAdmin
        );
        if (optIdx !== -1) {
          const nextCached = [...cached];
          nextCached[optIdx] = incomingMsg;
          return { ...prev, [threadId]: nextCached };
        }
        return { ...prev, [threadId]: [...cached, incomingMsg] };
      });

      // Update thread status if answered
      mutateThreads((currentThreads) => {
        if (!currentThreads) return currentThreads;
        return currentThreads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                userUnread: false,
                status: incomingMsg.fromAdmin ? 'ANSWERED' : t.status,
                lastMessageAt: incomingMsg.createdAt || new Date().toISOString(),
                lastMessageSnippet: incomingMsg.content,
              }
            : t
        );
      }, false);

      setTimeout(scrollToBottom, 40);
    });

    return () => {
      unsub();
    };
  }, [isOpen, selectedThread?.id, mutateThreads]);

  // Load messages when selecting a thread (SWR cache retention)
  const handleSelectThread = async (thread: FeedbackThread) => {
    setSelectedThread(thread);
    setFollowUpError(null);

    // If cached, display instantly with 0-latency
    if (threadMessagesCache[thread.id]) {
      setMessages(threadMessagesCache[thread.id]);
      setIsLoadingMessages(false);
      setTimeout(scrollToBottom, 40);
    } else {
      setMessages([]);
      setIsLoadingMessages(true);
    }

    try {
      const msgs = await feedbackApi.getThreadMessages(thread.id);
      const loadedMsgs = msgs || [];
      setMessages(loadedMsgs);
      setThreadMessagesCache((prev) => ({ ...prev, [thread.id]: loadedMsgs }));
      setTimeout(scrollToBottom, 40);

      // If thread was unread by user, mutate thread list to clear badge
      if (thread.userUnread) {
        mutateThreads(
          threads.map((t) => (t.id === thread.id ? { ...t, userUnread: false } : t)),
          false
        );
      }
    } catch (err: any) {
      setFollowUpError('Không thể tải tin nhắn hội thoại.');
    } finally {
      setIsLoadingMessages(false);
    }
  };

  const handleFollowUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const contentToSend = followUpContent.trim();
    if (!selectedThread || !contentToSend) return;

    // 1. Immediately clear input textarea and any previous error
    setFollowUpContent('');
    setFollowUpError(null);
    setIsSendingFollowUp(true);

    // 2. Instantly inject optimistic message item into conversation list
    const tempId = -Date.now();
    const optimisticMessage: FeedbackMessage = {
      id: tempId,
      threadId: selectedThread.id,
      senderUserId: 0,
      senderName: 'Bạn',
      content: contentToSend,
      fromAdmin: false,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    setThreadMessagesCache((prev) => ({
      ...prev,
      [selectedThread.id]: [...(prev[selectedThread.id] || []), optimisticMessage],
    }));

    // 3. Instantly auto-scroll to bottom
    setTimeout(scrollToBottom, 30);

    // 4. In background, dispatch POST API request
    try {
      const sent = await feedbackApi.userFollowUp(selectedThread.id, {
        content: contentToSend,
      });

      // 5. Replace temporary optimistic message in place with server DTO
      setMessages((prev) =>
        prev.map((msg) => (msg.id === tempId ? sent : msg))
      );
      setThreadMessagesCache((prev) => ({
        ...prev,
        [selectedThread.id]: (prev[selectedThread.id] || []).map((msg) =>
          msg.id === tempId ? sent : msg
        ),
      }));
      mutateThreads();
    } catch (err: any) {
      // 6. If API call fails, roll back optimistic message and restore typed text
      setMessages((prev) => prev.filter((msg) => msg.id !== tempId));
      setThreadMessagesCache((prev) => ({
        ...prev,
        [selectedThread.id]: (prev[selectedThread.id] || []).filter(
          (msg) => msg.id !== tempId
        ),
      }));
      setFollowUpContent(contentToSend);

      const status = err?.response?.status;
      if (status === 429) {
        setFollowUpError('Giới hạn 5 góp ý mỗi giờ. Vui lòng thử lại sau.');
      } else {
        setFollowUpError(
          err?.response?.data?.message || 'Không thể gửi phản hồi. Vui lòng thử lại.'
        );
      }
    } finally {
      setIsSendingFollowUp(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!subject.trim()) {
      setErrorMsg('Vui lòng nhập tiêu đề góp ý.');
      return;
    }
    if (!content.trim()) {
      setErrorMsg('Vui lòng nhập nội dung góp ý.');
      return;
    }

    const payload: CreateFeedbackPayload = {
      category,
      subject: subject.trim(),
      content: content.trim(),
    };

    setIsSubmitting(true);
    try {
      await feedbackApi.createFeedback(payload);
      setSuccessMsg('Góp ý của bạn đã được gửi thành công! Admin sẽ phản hồi sớm nhất có thể.');
      setSubject('');
      setContent('');
      setCategory('IDEA');
      mutateThreads();
      if (onSubmitted) onSubmitted();
      setTimeout(() => {
        setActiveTab('MINE');
        setSuccessMsg(null);
      }, 1200);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429) {
        setErrorMsg('Giới hạn 5 góp ý mỗi giờ. Đừng gửi mật khẩu hoặc thông tin cá nhân nhạy cảm.');
      } else {
        setErrorMsg(
          err?.response?.data?.message ||
          err?.response?.data?.detail ||
          'Không thể gửi góp ý lúc này. Vui lòng thử lại sau.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderCategoryPill = (catKey: FeedbackCategory) => {
    const item = CATEGORIES.find((c) => c.key === catKey) || CATEGORIES[4];
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200/60 dark:border-purple-800/60">
        <span>{item.icon}</span>
        <span>{item.label}</span>
      </span>
    );
  };

  const renderStatusBadge = (status: string) => {
    switch (status) {
      case 'ANSWERED':
        return (
          <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            Đã trả lời
          </span>
        );
      case 'CLOSED':
        return (
          <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
            Đã đóng
          </span>
        );
      case 'OPEN':
      default:
        return (
          <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            Chờ phản hồi
          </span>
        );
    }
  };

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
      data-feedback-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 pb-4 border-b border-slate-100 dark:border-slate-800 relative bg-slate-50/50 dark:bg-slate-900/50">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-5 right-5 p-2 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition cursor-pointer"
            aria-label="Đóng"
          >
            <X className="w-5 h-5" />
          </button>

          <h2 id="feedback-modal-title" className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
            <span>💭</span>
            <span>Góp ý cho EnglishCoach</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
            Mỗi góp ý giúp mình làm web tốt hơn. Admin sẽ phản hồi qua chuông 🔔.
          </p>

          {/* Tab Switcher */}
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={() => {
                setActiveTab('WRITE');
                setSelectedThread(null);
              }}
              className={`px-4 py-2 text-xs font-bold rounded-xl transition cursor-pointer ${
                activeTab === 'WRITE' && !selectedThread
                  ? 'bg-purple-600 text-white shadow-md shadow-purple-600/25'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              Viết góp ý
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('MINE')}
              className={`px-4 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'MINE'
                  ? 'bg-purple-600 text-white shadow-md shadow-purple-600/25'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              <span>Góp ý của tôi</span>
              {threads.length > 0 && (
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                  activeTab === 'MINE' ? 'bg-purple-800 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
                }`}>
                  {threads.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'WRITE' && !selectedThread ? (
            /* Tab: Viết góp ý */
            <form onSubmit={handleSubmit} className="space-y-5">
              {errorMsg && (
                <div className="p-3.5 rounded-2xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 flex items-start gap-2.5 text-red-700 dark:text-red-300 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{errorMsg}</span>
                </div>
              )}

              {successMsg && (
                <div className="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 flex items-start gap-2.5 text-emerald-700 dark:text-emerald-300 text-xs">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{successMsg}</span>
                </div>
              )}

              {/* Category Selector */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                  Bạn muốn góp ý về
                </label>
                <div className="flex flex-wrap gap-2">
                  {CATEGORIES.map((c) => {
                    const isSelected = category === c.key;
                    return (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setCategory(c.key)}
                        className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer select-none ${
                          isSelected
                            ? 'bg-purple-600 text-white shadow-md shadow-purple-600/25 ring-2 ring-purple-600 dark:ring-purple-500'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                        }`}
                      >
                        <span>{c.icon}</span>
                        <span>{c.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Subject Input */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    Tiêu đề
                  </label>
                  <span className="text-[11px] font-medium text-slate-400">
                    {subject.length}/120
                  </span>
                </div>
                <input
                  type="text"
                  maxLength={120}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="VD: Thêm chế độ tối cho Card Blast"
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-purple-500 transition"
                />
              </div>

              {/* Content Textarea */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    Nội dung
                  </label>
                  <span className="text-[11px] font-medium text-slate-400">
                    {content.length}/2000
                  </span>
                </div>
                <textarea
                  rows={5}
                  maxLength={2000}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Mô tả ý tưởng hoặc lỗi bạn gặp (trang nào, bạn đã làm gì)..."
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-purple-500 transition resize-none leading-relaxed"
                />
              </div>

              {/* Notice */}
              <div className="p-3 rounded-xl bg-purple-50/60 dark:bg-purple-950/30 border border-purple-100 dark:border-purple-900/40 flex items-start gap-2 text-purple-800 dark:text-purple-300 text-[11px] leading-relaxed">
                <Info className="w-4 h-4 shrink-0 mt-0.5 text-purple-600 dark:text-purple-400" />
                <span>Giới hạn 5 góp ý mỗi giờ. Đừng gửi mật khẩu hoặc thông tin cá nhân nhạy cảm.</span>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setSubject('');
                    setContent('');
                    setCategory('IDEA');
                    setErrorMsg(null);
                    onClose();
                  }}
                  className="px-4 py-2.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !subject.trim() || !content.trim()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-purple-600/30 transition cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Đang gửi...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      <span>Gửi góp ý</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : selectedThread ? (
            /* Conversation View for Selected Thread */
            <div className="flex flex-col h-full space-y-4">
              <button
                type="button"
                onClick={() => setSelectedThread(null)}
                className="inline-flex items-center gap-1.5 text-xs font-bold text-purple-600 dark:text-purple-400 hover:underline cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>Quay lại danh sách góp ý</span>
              </button>

              <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2">
                    {renderCategoryPill(selectedThread.category)}
                    {renderStatusBadge(selectedThread.status)}
                  </div>
                  <span className="text-[11px] text-slate-400">
                    {new Date(selectedThread.createdAt).toLocaleDateString('vi-VN')}
                  </span>
                </div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  {selectedThread.subject}
                </h3>
              </div>

              {/* Chat messages */}
              <div className="space-y-3 min-h-[160px] max-h-[300px] overflow-y-auto pr-1">
                {isLoadingMessages && messages.length === 0 ? (
                  <div className="space-y-3 py-3 animate-pulse">
                    <div className="flex flex-col items-start space-y-1">
                      <div className="h-3 w-20 bg-slate-200 dark:bg-slate-700 rounded" />
                      <div className="h-10 w-3/4 bg-slate-100 dark:bg-slate-800 rounded-2xl" />
                    </div>
                    <div className="flex flex-col items-end space-y-1">
                      <div className="h-3 w-16 bg-slate-200 dark:bg-slate-700 rounded" />
                      <div className="h-8 w-1/2 bg-purple-100 dark:bg-purple-950/60 rounded-2xl" />
                    </div>
                  </div>
                ) : messages.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-4">Chưa có tin nhắn nào.</p>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${msg.fromAdmin ? 'items-start' : 'items-end'}`}
                    >
                      <div className="flex items-center gap-1.5 mb-1 px-1">
                        <span className={`text-[11px] font-bold ${msg.fromAdmin ? 'text-purple-600 dark:text-purple-400' : 'text-slate-600 dark:text-slate-300'}`}>
                          {msg.fromAdmin ? '🛡️ ' + msg.senderName : msg.senderName}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(msg.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {msg.id < 0 && (
                          <span className="text-[9px] text-purple-500 font-medium">Đang gửi...</span>
                        )}
                      </div>
                      <div
                        className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-xs leading-relaxed break-words ${
                          msg.fromAdmin
                            ? 'bg-purple-100/80 text-purple-950 dark:bg-purple-950/70 dark:text-purple-100 rounded-tl-xs border border-purple-200/60 dark:border-purple-800/60'
                            : 'bg-slate-200/80 text-slate-900 dark:bg-slate-800 dark:text-slate-100 rounded-tr-xs'
                        } ${msg.id < 0 ? 'opacity-75 ring-1 ring-purple-400/40' : ''}`}
                      >
                        {msg.content}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Follow-up reply box */}
              {selectedThread.status !== 'CLOSED' ? (
                <form onSubmit={handleFollowUpSubmit} className="pt-2 border-t border-slate-100 dark:border-slate-800">
                  {followUpError && (
                    <p className="text-xs text-red-500 mb-2">{followUpError}</p>
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      maxLength={2000}
                      value={followUpContent}
                      onChange={(e) => setFollowUpContent(e.target.value)}
                      placeholder="Nhập phản hồi thêm..."
                      className="flex-1 px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-purple-500 transition"
                    />
                    <button
                      type="submit"
                      disabled={!followUpContent.trim()}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 transition cursor-pointer shrink-0"
                    >
                      {isSendingFollowUp ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <span>Gửi</span>
                      )}
                    </button>
                  </div>
                </form>
              ) : (
                <p className="text-xs text-slate-400 text-center py-2 italic">
                  Góp ý này đã được đóng bởi quản trị viên.
                </p>
              )}
            </div>
          ) : (
            /* Tab: Góp ý của tôi */
            <div className="space-y-3">
              {isLoadingThreads && threads.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin text-purple-600 mb-2" />
                  <p className="text-xs">Đang tải lịch sử góp ý...</p>
                </div>
              ) : threads.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-slate-400">
                  <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3 text-slate-400">
                    <MessageSquare className="w-6 h-6" />
                  </div>
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
                    Bạn chưa gửi góp ý nào
                  </p>
                  <p className="text-xs text-slate-400 mt-1 max-w-xs">
                    Hãy chia sẻ ý tưởng hoặc phản hồi để giúp EnglishCoach ngày càng hoàn thiện nhé!
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('WRITE')}
                    className="mt-4 px-4 py-2 rounded-xl text-xs font-bold bg-purple-600 hover:bg-purple-700 text-white shadow-sm transition cursor-pointer"
                  >
                    Viết góp ý đầu tiên
                  </button>
                </div>
              ) : (
                threads.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => handleSelectThread(t)}
                    className="group p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-purple-300 dark:hover:border-purple-700/60 shadow-xs hover:shadow-md transition cursor-pointer relative"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-2">
                        {renderCategoryPill(t.category)}
                        {renderStatusBadge(t.status)}
                        {t.userUnread && (
                          <span className="w-2 h-2 rounded-full bg-purple-600 animate-pulse" title="Admin đã trả lời mới" />
                        )}
                      </div>
                      <span className="text-[10px] text-slate-400 font-medium">
                        {new Date(t.lastMessageAt).toLocaleDateString('vi-VN')}
                      </span>
                    </div>

                    <h4 className="text-xs font-bold text-slate-900 dark:text-white group-hover:text-purple-600 dark:group-hover:text-purple-400 transition truncate">
                      {t.subject}
                    </h4>

                    {t.lastMessageSnippet && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">
                        {t.lastMessageSnippet}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
