'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Inbox,
  Send,
  Check,
  XCircle,
  Clock,
  User,
} from 'lucide-react';
import { feedbackApi } from '@/services/feedbackApi';
import {
  FeedbackCategory,
  FeedbackMessage,
  FeedbackThread,
} from '@/types/feedback';
import {
  useAdminFeedbackInbox,
  useAdminFeedbackUnreadCount,
} from '@/hooks/useFeedback';
import { subscribeRealtimeTopic } from '@/services/stompClient';

const CATEGORY_MAP: Record<FeedbackCategory, { label: string; icon: string }> = {
  IDEA: { label: 'Ý tưởng', icon: '💡' },
  BUG: { label: 'Báo lỗi', icon: '🪲' },
  UI: { label: 'Giao diện', icon: '🎨' },
  CONTENT: { label: 'Nội dung', icon: '🧾' },
  OTHER: { label: 'Khác', icon: '💬' },
};

export function AdminFeedbackInbox() {
  const { inbox, isLoading: isLoadingInbox, mutateInbox } = useAdminFeedbackInbox();
  const { mutateUnreadCount } = useAdminFeedbackUnreadCount();

  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<FeedbackMessage[]>([]);
  const [messagesCache, setMessagesCache] = useState<Record<number, FeedbackMessage[]>>({});
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  // Reply form state
  const [replyText, setReplyText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySuccess, setReplySuccess] = useState<string | null>(null);

  // Close thread state
  const [isClosing, setIsClosing] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Auto-select first thread if none selected
  useEffect(() => {
    if (inbox.length > 0 && activeThreadId === null) {
      handleSelectThread(inbox[0]);
    }
  }, [inbox]);

  // Real-time chat sync for active thread in admin inbox (Instant live conversation)
  useEffect(() => {
    if (!activeThreadId) return;
    const threadId = activeThreadId;

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

      setMessagesCache((prev) => {
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

      // Update inbox list status & snippet
      mutateInbox((currentInbox) => {
        if (!currentInbox) return currentInbox;
        return currentInbox.map((t) =>
          t.id === threadId
            ? {
                ...t,
                adminUnread: false,
                status: incomingMsg.fromAdmin ? 'ANSWERED' : 'OPEN',
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
  }, [activeThreadId, mutateInbox]);

  const activeThread = inbox.find((t) => t.id === activeThreadId) || null;

  const handleSelectThread = async (thread: FeedbackThread) => {
    setActiveThreadId(thread.id);
    setReplyError(null);
    setReplySuccess(null);

    const cached = messagesCache[thread.id];
    if (cached) {
      // Instant 0-latency switch from SWR cache! No blanking, no full-pane spinner!
      setMessages(cached);
      setIsLoadingMessages(false);
      setTimeout(scrollToBottom, 40);
    } else {
      // Uncached thread: Clear previous thread's messages to avoid displaying wrong thread,
      // but show subtle skeleton loader inside the pane, keeping header & reply dock intact!
      setMessages([]);
      setIsLoadingMessages(true);
    }

    try {
      const msgs = await feedbackApi.getThreadMessages(thread.id);
      const loaded = msgs || [];
      setMessages(loaded);
      setMessagesCache((prev) => ({ ...prev, [thread.id]: loaded }));
      setTimeout(scrollToBottom, 40);

      // If thread was unread by admin, mark read locally and decrement unread counter
      if (thread.adminUnread) {
        mutateInbox(
          inbox.map((t) => (t.id === thread.id ? { ...t, adminUnread: false } : t)),
          false
        );
        mutateUnreadCount();
      }
    } catch (err: any) {
      setReplyError('Không thể tải tin nhắn của góp ý này.');
    } finally {
      setIsLoadingMessages(false);
    }
  };

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    const textToSend = replyText.trim();
    if (!activeThread || !textToSend) return;

    // 1. Instantly clear reply textarea and reset errors
    setReplyText('');
    setReplyError(null);
    setReplySuccess(null);
    setIsSending(true);

    // 2. Instantly inject optimistic reply message into right chat pane
    const tempId = -Date.now();
    const optimisticMessage: FeedbackMessage = {
      id: tempId,
      threadId: activeThread.id,
      senderUserId: 0,
      senderName: 'Quản trị viên',
      content: textToSend,
      fromAdmin: true,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    setMessagesCache((prev) => ({
      ...prev,
      [activeThread.id]: [...(prev[activeThread.id] || []), optimisticMessage],
    }));

    // 3. Instantly update thread's status to ANSWERED in local UI
    mutateInbox(
      inbox.map((t) =>
        t.id === activeThread.id
          ? {
              ...t,
              status: 'ANSWERED',
              adminUnread: false,
              lastMessageAt: new Date().toISOString(),
              lastMessageSnippet: textToSend,
            }
          : t
      ),
      false
    );
    mutateUnreadCount();

    // 4. Instantly auto-scroll to bottom
    setTimeout(scrollToBottom, 30);

    // 5. In background, dispatch POST API request
    try {
      const sentMessage = await feedbackApi.adminReply(activeThread.id, {
        content: textToSend,
      });

      // 6. Replace optimistic message in place with server DTO
      setMessages((prev) =>
        prev.map((msg) => (msg.id === tempId ? sentMessage : msg))
      );
      setMessagesCache((prev) => ({
        ...prev,
        [activeThread.id]: (prev[activeThread.id] || []).map((msg) =>
          msg.id === tempId ? sentMessage : msg
        ),
      }));
      setReplySuccess('Đã gửi phản hồi thành công!');
      setTimeout(() => setReplySuccess(null), 3000);
    } catch (err: any) {
      // 7. Roll back optimistic message and restore typed text on failure
      setMessages((prev) => prev.filter((msg) => msg.id !== tempId));
      setMessagesCache((prev) => ({
        ...prev,
        [activeThread.id]: (prev[activeThread.id] || []).filter(
          (msg) => msg.id !== tempId
        ),
      }));
      setReplyText(textToSend);
      setReplyError(
        err?.response?.data?.message || 'Không thể gửi phản hồi lúc này.'
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleCloseThread = async () => {
    if (!activeThread) return;
    setIsClosing(true);
    setReplyError(null);
    try {
      const updated = await feedbackApi.closeThread(activeThread.id);
      mutateInbox(
        inbox.map((t) => (t.id === activeThread.id ? { ...t, status: 'CLOSED' } : t)),
        false
      );
      mutateUnreadCount();
    } catch (err: any) {
      setReplyError(err?.response?.data?.message || 'Không thể đóng góp ý lúc này.');
    } finally {
      setIsClosing(false);
    }
  };

  const getCategoryInfo = (cat: FeedbackCategory) => {
    return CATEGORY_MAP[cat] || CATEGORY_MAP.OTHER;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left Column: Thread List */}
      <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden flex flex-col h-[750px]">
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex items-center gap-2">
            <Inbox className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            <h3 className="font-bold text-sm text-slate-800 dark:text-slate-100">
              Danh sách góp ý ({inbox.length})
            </h3>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/60">
          {isLoadingInbox && inbox.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-purple-600 mb-2" />
              <p className="text-xs">Đang tải hộp thư góp ý...</p>
            </div>
          ) : inbox.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 text-center px-4">
              <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3 text-slate-400">
                <Inbox className="w-6 h-6" />
              </div>
              <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                Chưa có góp ý nào từ học viên
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Các ý kiến đóng góp, báo lỗi sẽ xuất hiện tại đây.
              </p>
            </div>
          ) : (
            inbox.map((t) => {
              const isSelected = activeThreadId === t.id;
              const catInfo = getCategoryInfo(t.category);

              return (
                <div
                  key={t.id}
                  onClick={() => handleSelectThread(t)}
                  className={`p-4 transition cursor-pointer relative ${
                    isSelected
                      ? 'bg-purple-50/80 dark:bg-purple-950/40 border-l-4 border-purple-600'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2">
                      {/* Red unread indicator dot */}
                      {t.adminUnread && (
                        <span
                          className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0"
                          title="Chưa đọc"
                        />
                      )}
                      {/* Category badge with icon */}
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300 border border-purple-200/60 dark:border-purple-800/60">
                        <span>{catInfo.icon}</span>
                        <span>{catInfo.label}</span>
                      </span>
                    </div>

                    <span className="text-[10px] text-slate-400 font-medium">
                      {new Date(t.lastMessageAt).toLocaleDateString('vi-VN')}
                    </span>
                  </div>

                  {/* Subject */}
                  <h4
                    className={`text-xs truncate mb-1 ${
                      t.adminUnread
                        ? 'font-black text-slate-900 dark:text-white'
                        : 'font-semibold text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    {t.subject}
                  </h4>

                  {/* Sender display name / email */}
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    <User className="w-3 h-3 shrink-0 text-slate-400" />
                    <span className="truncate font-medium">{t.userName || t.userEmail || 'Học viên'}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right Column: Thread Detail & Reply Pane */}
      <div className="lg:col-span-7 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden flex flex-col h-[750px]">
        {activeThread ? (
          <>
            {/* Thread Header */}
            <div className="p-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-bold text-slate-900 dark:text-white">
                    {activeThread.subject}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-1.5 font-medium">
                    <span>{activeThread.userName || activeThread.userEmail}</span>
                    <span>·</span>
                    <span>
                      {getCategoryInfo(activeThread.category).icon}{' '}
                      {getCategoryInfo(activeThread.category).label}
                    </span>
                  </p>
                </div>

                <div>
                  {activeThread.status === 'CLOSED' ? (
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                      Đã đóng
                    </span>
                  ) : activeThread.status === 'ANSWERED' ? (
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      Đã trả lời
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      Chờ phản hồi
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Conversation Messages */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {isLoadingMessages && messages.length === 0 ? (
                <div className="space-y-4 py-4 animate-pulse">
                  {/* Skeleton user message */}
                  <div className="flex flex-col items-start space-y-1">
                    <div className="h-3 w-24 bg-slate-200 dark:bg-slate-700 rounded" />
                    <div className="h-14 w-2/3 bg-slate-100 dark:bg-slate-800 rounded-2xl" />
                  </div>
                  {/* Skeleton admin reply */}
                  <div className="flex flex-col items-end space-y-1">
                    <div className="h-3 w-20 bg-slate-200 dark:bg-slate-700 rounded" />
                    <div className="h-10 w-1/2 bg-purple-100 dark:bg-purple-950/50 rounded-2xl" />
                  </div>
                  {/* Skeleton follow up */}
                  <div className="flex flex-col items-start space-y-1">
                    <div className="h-3 w-24 bg-slate-200 dark:bg-slate-700 rounded" />
                    <div className="h-12 w-3/5 bg-slate-100 dark:bg-slate-800 rounded-2xl" />
                  </div>
                </div>
              ) : messages.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-8">Chưa có tin nhắn nào.</p>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${msg.fromAdmin ? 'items-end' : 'items-start'}`}
                  >
                    <div className="flex items-center gap-1.5 mb-1 px-1">
                      <span
                        className={`text-[11px] font-bold ${
                          msg.fromAdmin
                            ? 'text-purple-600 dark:text-purple-400'
                            : 'text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {msg.fromAdmin ? '🛡️ Quản trị viên' : msg.senderName || 'Học viên'}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {new Date(msg.createdAt).toLocaleTimeString('vi-VN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        {new Date(msg.createdAt).toLocaleDateString('vi-VN')}
                      </span>
                      {msg.id < 0 && (
                        <span className="text-[9px] text-purple-400 font-medium">Đang gửi...</span>
                      )}
                    </div>

                    {/* Chat Bubble - XSS Protected strictly via {msg.content} */}
                    <div
                      className={`max-w-[85%] px-4 py-3 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap break-words ${
                        msg.fromAdmin
                          ? 'bg-purple-600 text-white rounded-tr-xs shadow-xs'
                          : 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 rounded-tl-xs border border-slate-200/60 dark:border-slate-700/60'
                      } ${msg.id < 0 ? 'opacity-80 ring-1 ring-purple-300/50' : ''}`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply Box & Action Buttons */}
            <div className="p-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
              <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 mb-2">
                Trả lời học viên
              </h4>

              {replyError && (
                <div className="mb-3 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 flex items-center gap-2 text-xs text-red-700 dark:text-red-300">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{replyError}</span>
                </div>
              )}

              {replySuccess && (
                <div className="mb-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{replySuccess}</span>
                </div>
              )}

              <form onSubmit={handleSendReply} className="space-y-3">
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Nhập phản hồi..."
                  disabled={activeThread.status === 'CLOSED'}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 transition resize-none disabled:opacity-50"
                />

                <div className="flex items-center justify-between gap-3">
                  <div>
                    {activeThread.status !== 'CLOSED' && (
                      <button
                        type="button"
                        onClick={handleCloseThread}
                        disabled={isClosing}
                        className="px-4 py-2 rounded-xl text-xs font-bold border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-50"
                      >
                        {isClosing ? 'Đang đóng...' : 'Đóng góp ý'}
                      </button>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={!replyText.trim() || activeThread.status === 'CLOSED'}
                    className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 shadow-md shadow-purple-600/30 transition cursor-pointer"
                  >
                    {isSending ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Đang gửi...</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5" />
                        <span>Gửi phản hồi</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center">
            <Inbox className="w-12 h-12 mb-3 text-slate-300 dark:text-slate-700" />
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">
              Chưa chọn góp ý nào
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Chọn một góp ý từ danh sách bên trái để xem nội dung và phản hồi.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
