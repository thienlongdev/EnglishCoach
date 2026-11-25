export type NotificationScope = 'GLOBAL' | 'USER';

export type NotificationType =
  | 'SYSTEM_UPDATE'
  | 'EVENT'
  | 'LEARNING_REMINDER'
  | 'REVIEW_DUE'
  | 'STREAK'
  | 'PREMIUM'
  | 'PAYMENT';

export type NotificationCategory = 'SYSTEM' | 'MILESTONE' | 'STREAK';

export interface NotificationPayload {
  id?: number;
  type?: NotificationType;
  category?: NotificationCategory;
  title?: string;
  content?: string;
  actionUrl?: string | null;
  createdAt?: string;
  unreadCount?: number;
}

export interface NotificationEnvelope {
  type: 'NOTIFICATION_CREATED' | 'NOTIFICATION_READ' | 'NOTIFICATIONS_ALL_READ' | 'UNREAD_COUNT_SYNC';
  version: number;
  eventId: string;
  occurredAt: string;
  data?: NotificationPayload;
}

export interface LearnerNotification {
  id: number;
  type: NotificationType;
  category?: NotificationCategory;
  title: string;
  body: string;
  actionUrl: string | null;
  publishedAt: string;
  read: boolean;
  sender?: string;
}

export interface UnreadCountResponse {
  unreadCount: number;
}

export type NotificationAdminState = 'SCHEDULED' | 'PUBLISHED' | 'EXPIRED';

export interface AdminNotification {
  id: number;
  scope: NotificationScope;
  type: NotificationType;
  title: string;
  body: string;
  actionUrl: string | null;
  publishAt: string;
  expiresAt: string | null;
  targetEmail: string | null;
  createdByUserId: number | null;
  state: NotificationAdminState;
  createdAt: string;
}

export interface AdminCreateNotificationRequest {
  scope: NotificationScope;
  type: 'SYSTEM_UPDATE' | 'EVENT';
  title: string;
  body: string;
  actionUrl?: string | null;
  publishAt?: string | null;
  expiresAt?: string | null;
  targetEmail?: string | null;
}
