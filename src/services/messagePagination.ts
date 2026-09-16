import { ConversationKind, Message, MessageCursor, MessagePage } from '../types';

export const INITIAL_MESSAGE_PAGE_SIZE = 30;
export const OLDER_MESSAGE_PAGE_SIZE = 50;
export const MAX_ACTIVE_MESSAGES = 500;

/**
 * PocketBase's `created` field is not unique.  Always include the record id
 * in the cursor so two messages written in the same millisecond cannot be
 * skipped or returned twice.
 */
export function cursorFromMessage(message: Pick<Message, 'created' | 'id'> | null | undefined): MessageCursor | null {
  if (!message?.id || !message.created) return null;
  return { created: message.created, id: message.id };
}

export function cursorKey(cursor: MessageCursor | null | undefined): string {
  return cursor ? `${cursor.created}|${cursor.id}` : 'initial';
}

export function compareMessageOrder(a: Pick<Message, 'created' | 'id'>, b: Pick<Message, 'created' | 'id'>): number {
  const createdA = new Date(a.created || 0).getTime();
  const createdB = new Date(b.created || 0).getTime();
  if (createdA !== createdB) return createdA - createdB;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function relationRichness(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value as Record<string, unknown>)
    .filter((field) => field !== undefined && field !== null && field !== '').length;
}

/** Sort ascending for the React feed and remove duplicate optimistic/real ids. */
export function dedupeMessages(messages: Message[], maxItems?: number): Message[] {
  const byId = new Map<string, Message>();
  const optimisticBySignature = new Map<string, string>();
  for (const message of messages) {
    if (!message?.id || message.deleted || message.deleted_at) continue;
    const existing = byId.get(message.id);
    // A cached row can have the same id as a freshly fetched row but lack
    // sender/reply/attachment expansion. Prefer the richer incoming record so
    // a cache-first refresh can hydrate names and media without remounting the
    // feed. Newer edits also replace an older cached copy.
    const existingSender = existing?.expand?.sender || (existing as any)?.sender && typeof (existing as any).sender !== 'string';
    const incomingSender = message.expand?.sender || (message as any)?.sender && typeof (message as any).sender !== 'string';
    const existingAttachmentCount = ((existing as any)?.attachments || existing?.expand?.['attachments(message)'] || existing?.expand?.attachments_via_message || []).length;
    const incomingAttachmentCount = ((message as any)?.attachments || message.expand?.['attachments(message)'] || message.expand?.attachments_via_message || []).length;
    const incomingIsRicher = relationRichness(incomingSender) > relationRichness(existingSender) || incomingAttachmentCount > existingAttachmentCount || Boolean(message.reply_to && !existing?.reply_to);
    const incomingIsNewer = Boolean(message.updated && existing?.updated && message.updated > existing.updated);
    if (!existing || (!message.is_pending && existing.is_pending) || (!message.is_pending && !existing?.is_pending && (incomingIsRicher || incomingIsNewer))) {
      byId.set(message.id, message);
    }
    const sender = message.sender || message.expand?.sender?.id || '';
    const signature = sender && message.content?.trim()
      ? `${sender}|${message.content.trim()}`
      : '';
    if (signature && !message.is_pending && message.id && !message.id.startsWith('optimistic-')) {
      const optimisticId = optimisticBySignature.get(signature);
      if (optimisticId) byId.delete(optimisticId);
    } else if (signature && (message.is_pending || message.id.startsWith('optimistic-'))) {
      optimisticBySignature.set(signature, message.id);
    }
  }
  const sorted = Array.from(byId.values()).sort(compareMessageOrder);
  return typeof maxItems === 'number' && sorted.length > maxItems
    ? sorted.slice(sorted.length - maxItems)
    : sorted;
}

export type MessageWindowDirection = 'newest' | 'oldest';

/**
 * Merge a page into the active window. Newest-first retention is appropriate
 * for realtime/optimistic messages; older-history prepends retain the oldest
 * side of the window so the cursor can continue moving backwards after the
 * 500-message in-memory cap is reached.
 */
export function mergeMessagePage(
  existing: Message[],
  page: Message[],
  maxItems = MAX_ACTIVE_MESSAGES,
  retain: MessageWindowDirection = 'newest',
): Message[] {
  const merged = dedupeMessages([...existing, ...page]);
  if (merged.length <= maxItems) return merged;
  return retain === 'oldest' ? merged.slice(0, maxItems) : merged.slice(-maxItems);
}

export function mergeOlderMessagePage(
  existing: Message[],
  page: Message[],
  maxItems = MAX_ACTIVE_MESSAGES,
): Message[] {
  return mergeMessagePage(existing, page, maxItems, 'oldest');
}

/**
 * Deterministic in-memory equivalent of the gateway contract. It is used by
 * tests and by offline reveal code to prove that equal-timestamp records are
 * neither skipped nor repeated.
 */
export function paginateMessages(
  source: Message[],
  cursor: MessageCursor | null = null,
  limit = OLDER_MESSAGE_PAGE_SIZE,
): MessagePage<Message> {
  const sorted = dedupeMessages(source);
  const boundedLimit = Math.max(1, Math.floor(limit));
  const candidates = cursor
    ? sorted.filter((item) => compareMessageOrder(item, cursor) < 0)
    : sorted;
  const items = candidates.slice(Math.max(0, candidates.length - boundedLimit));
  return {
    items,
    nextCursor: items.length > 0 ? cursorFromMessage(items[0]) : null,
    hasMore: candidates.length > items.length,
  };
}

/** Reveal one persisted page before asking the network. */
export function revealCachedMessages(
  visible: Message[],
  cached: Message[],
  pageSize = OLDER_MESSAGE_PAGE_SIZE,
  remoteHasMore = true,
): { items: Message[]; hasMore: boolean } {
  const merged = dedupeMessages([...visible, ...cached]);
  if (merged.length <= visible.length) {
    return { items: visible, hasMore: remoteHasMore };
  }
  const targetCount = Math.min(MAX_ACTIVE_MESSAGES, visible.length + Math.max(1, pageSize));
  const items = merged.slice(Math.max(0, merged.length - targetCount));
  return {
    items,
    // `remoteHasMore` is independent from pages still on disk.
    hasMore: merged.length > items.length || remoteHasMore,
  };
}

/**
 * Reveal only the next persisted page before the current oldest message. This
 * keeps the active window moving backwards instead of repeatedly merging the
 * entire disk cache and retaining only the newest rows.
 */
export function revealCachedOlderMessages(
  visible: Message[],
  cached: Message[],
  pageSize = OLDER_MESSAGE_PAGE_SIZE,
  remoteHasMore = true,
): { items: Message[]; hasMore: boolean } {
  const visibleDeduped = dedupeMessages(visible);
  const oldest = visibleDeduped[0];
  const older = cached
    .filter((message) => !oldest || compareMessageOrder(message, oldest) < 0)
    .sort(compareMessageOrder);
  if (older.length === 0) {
    return { items: visibleDeduped, hasMore: remoteHasMore };
  }

  // Choose the closest older rows so the viewport advances continuously.
  const next = older.slice(Math.max(0, older.length - Math.max(1, pageSize)));
  const items = mergeOlderMessagePage(visibleDeduped, next, MAX_ACTIVE_MESSAGES);
  return {
    items,
    hasMore: older.length > next.length || remoteHasMore,
  };
}

/** Build the inclusive-safe older-history predicate used by both collections. */
export function buildOlderMessageFilter(
  baseFilter: string,
  cursor?: MessageCursor | null,
): string {
  if (!cursor) return baseFilter;
  const created = cursor.created.replace(/T/g, ' ').replace(/"/g, '\\"');
  const id = cursor.id.replace(/"/g, '\\"');
  const older = `(created < "${created}" || (created = "${created}" && id < "${id}"))`;
  return baseFilter ? `(${baseFilter}) && ${older}` : older;
}

/** Convert a newest-first API page into the chronological feed order. */
export function normalizeMessagePage<T extends Message>(items: T[], hasMore: boolean): MessagePage<T> {
  const chronological = [...items].sort(compareMessageOrder);
  const oldest = chronological[0];
  return {
    items: chronological,
    nextCursor: oldest ? cursorFromMessage(oldest) : null,
    hasMore,
  };
}

export function conversationKey(kind: ConversationKind, id: string): string {
  return `${kind}:${id}`;
}
