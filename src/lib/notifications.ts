import { notificationService } from '../services/notificationService';
import { NotificationItem } from '../types';

/**
 * Call signaling is an ephemeral transport event, not a user notification.
 * Older releases accidentally persisted these payloads in the notification
 * array, so keep the check deliberately tolerant of wrappers/legacy formats.
 */
export function getNotificationContent(notification: Partial<NotificationItem> | null | undefined): string {
  if (!notification) return '';
  const value = notification.message_content ?? notification.message ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

export function isEphemeralCallNotification(notification: Partial<NotificationItem> | null | undefined): boolean {
  if (!notification) return false;
  const content = getNotificationContent(notification);
  const isSignalPayload = /(?:CALL_SIGNAL|INCOMING_CALL):/i.test(content);
  if (isSignalPayload) return true;

  // `call_` IDs were used by the old invite fallback. Do not hide durable
  // call-log records that happen to use the same prefix.
  const isLegacyCallId = Boolean(notification.id && String(notification.id).startsWith('call_'));
  const isCallLog = /(?:\[?CALL_LOG:)/i.test(content);
  return isLegacyCallId && !isCallLog;
}

/**
 * Requests browser and native Android notification permissions
 */
export async function requestNotificationPermission() {
  try {
    await notificationService.requestPermission();
  } catch (e) {
    console.warn('Failed to request notification permission:', e);
  }
}

/**
 * Triggers a desktop/Android notification and plays the in-app synthesized notification sound
 */
export function sendInAppNotification(
  title: string,
  body: string,
  icon?: string,
  onClick?: () => void,
  notifItem?: NotificationItem
) {
  const item: NotificationItem = notifItem || {
    id: 'notif-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
    type: 'system',
    sender_id: 'system',
    sender_name: title,
    sender_avatar: icon,
    message_content: body,
    created: new Date().toISOString(),
    read: false
  };

  if (onClick) {
    const unsub = notificationService.onNotificationTapped((tappedItem) => {
      if (tappedItem.id === item.id || tappedItem.message_id === item.message_id) {
        unsub();
        onClick();
      }
    });
  }

  notificationService.sendNotification(item);
}

