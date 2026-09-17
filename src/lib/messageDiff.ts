import { Message } from '../types';
import { parseReactions } from '../components/MessageReactions';

function profileRevision(message: Message): string {
  const sender = message.expand?.sender ||
    ((message as any).sender && typeof (message as any).sender === 'object'
      ? (message as any).sender
      : null);
  if (!sender) return '';
  return JSON.stringify([
    sender.id,
    sender.username,
    sender.display_name,
    sender.avatar,
    sender.avatar_processed,
    sender.profile_frame,
    sender.role,
    sender.updated,
  ]);
}

function replyRevision(message: Message): string {
  const reply = message.expand?.reply_to ||
    ((message as any).reply && typeof (message as any).reply === 'object'
      ? (message as any).reply
      : null);
  if (!reply) return String(message.reply_to || '');
  return JSON.stringify([
    reply.id,
    reply.sender,
    reply.content,
    reply.edited,
    reply.deleted,
    reply.deleted_at,
    reply.updated,
    profileRevision(reply),
  ]);
}

function attachmentRevision(message: Message): string {
  const attachments = ((message as any).attachments ||
    message.expand?.['attachments(message)'] ||
    message.expand?.attachments_via_message ||
    message.expand?.['private_attachments(message)'] ||
    message.expand?.private_attachments ||
    message.expand?.attachments ||
    []) as any[];
  return JSON.stringify(attachments.map((attachment) => {
    if (typeof attachment === 'string') return attachment;
    return [
      attachment?.id,
      attachment?.file,
      attachment?.thumbnail,
      attachment?.thumbnail_width,
      attachment?.thumbnail_height,
      attachment?.thumbnail_mime,
      attachment?.thumbnail_size,
      attachment?.url,
      attachment?.width,
      attachment?.height,
      attachment?.duration,
      attachment?.size,
      attachment?.type,
      attachment?.is_spoiler,
      attachment?.updated,
    ];
  }));
}

export function isSingleMessageEqual(p: Message, n: Message): boolean {
  if (p === n) return true;
  if (p.id !== n.id) return false;
  if (p.sender !== n.sender) return false;
  if (p.channel !== n.channel) return false;
  if (p.content !== n.content) return false;
  if (p.pinned !== n.pinned) return false;
  if (p.deleted !== n.deleted) return false;
  if (p.deleted_at !== n.deleted_at) return false;
  if (p.reply_to !== n.reply_to) return false;
  if (p.edited !== n.edited) return false;
  if (p.edited_at !== n.edited_at) return false;
  if (p.updated !== n.updated) return false;
  if (p.has_attachment !== n.has_attachment) return false;
  if (p.is_spoiler !== n.is_spoiler) return false;
  if (p.is_pending !== n.is_pending) return false;

  // Compare reactions using normalized parser
  const pReactionsRaw = (p as any).reactions ?? p.expand?.reactions ?? (p as any).reactions_list ?? (p as any).message_reactions;
  const nReactionsRaw = (n as any).reactions ?? n.expand?.reactions ?? (n as any).reactions_list ?? (n as any).message_reactions;
  if (pReactionsRaw !== nReactionsRaw) {
    const pParsed = parseReactions(pReactionsRaw);
    const nParsed = parseReactions(nReactionsRaw);
    if (JSON.stringify(pParsed) !== JSON.stringify(nParsed)) {
      return false;
    }
  }

  if (profileRevision(p) !== profileRevision(n)) return false;
  if (replyRevision(p) !== replyRevision(n)) return false;
  if (attachmentRevision(p) !== attachmentRevision(n)) return false;

  return true;
}

export function areMessagesEqual(prev: Message[], next: Message[]): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i++) {
    if (!isSingleMessageEqual(prev[i], next[i])) {
      return false;
    }
  }
  return true;
}

export function mergeMessageListPreservingReferences(prev: Message[], incoming: Message[]): Message[] {
  if (!prev || prev.length === 0) {
    if (!incoming || incoming.length === 0) return [];
    const seen = new Set<string>();
    return incoming.filter((m) => {
      const k = m.id || (m as any).temp_id;
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (!incoming || incoming.length === 0) return prev;

  const seenIds = new Set<string>();
  const uniqueIncoming: Message[] = [];
  for (let i = 0; i < incoming.length; i++) {
    const item = incoming[i];
    const key = item.id || (item as any).temp_id;
    if (key) {
      if (seenIds.has(key)) continue;
      seenIds.add(key);
    }
    uniqueIncoming.push(item);
  }

  if (areMessagesEqual(prev, uniqueIncoming)) {
    return prev;
  }

  const prevMap = new Map<string, Message>();
  for (const m of prev) {
    const k = m.id || (m as any).temp_id;
    if (k) prevMap.set(k, m);
  }

  const result: Message[] = new Array(uniqueIncoming.length);
  let hasAnyDiff = prev.length !== uniqueIncoming.length;

  for (let i = 0; i < uniqueIncoming.length; i++) {
    const inc = uniqueIncoming[i];
    const k = inc.id || (inc as any).temp_id;
    const old = k ? prevMap.get(k) : undefined;
    if (old && isSingleMessageEqual(old, inc)) {
      result[i] = old;
    } else {
      result[i] = inc;
      hasAnyDiff = true;
    }
  }

  return hasAnyDiff ? result : prev;
}
