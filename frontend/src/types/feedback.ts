export type FeedbackCategory = 'IDEA' | 'BUG' | 'UI' | 'CONTENT' | 'OTHER';
export type FeedbackStatus = 'OPEN' | 'ANSWERED' | 'CLOSED';

export interface FeedbackThread {
  id: number;
  userId: number;
  userName: string;
  userEmail: string;
  category: FeedbackCategory;
  subject: string;
  status: FeedbackStatus;
  adminUnread: boolean;
  userUnread: boolean;
  createdAt: string;
  lastMessageAt: string;
  lastMessageSnippet?: string;
}

export interface FeedbackMessage {
  id: number;
  threadId: number;
  senderUserId: number;
  senderName: string;
  fromAdmin: boolean;
  content: string;
  createdAt: string;
}

export interface FeedbackUnreadCount {
  unreadCount: number;
}

export interface CreateFeedbackPayload {
  category: FeedbackCategory;
  subject: string;
  content: string;
}

export interface FeedbackMessagePayload {
  content: string;
}
