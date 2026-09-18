import React, { useState, useEffect } from 'react';
import { CornerDownRight, MessageSquare, Lock, Hash, ArrowUpRight, User as UserIcon, Loader2, FileText, Image as ImageIcon, Trash2 } from 'lucide-react';
import { Channel, Message, Server, User } from '../types';
import { pbService } from '../pocketbase';
import { MessageDeletionService } from '../services/messageDeletionService';

function getSenderAvatar(user?: User) {
  if (user?.avatar) {
    if (user.avatar.startsWith('blob:') || user.avatar.startsWith('http')) {
      return user.avatar;
    }
    return `${pbService.getServerUrl()}/api/files/users/${user.id}/${user.avatar}`;
  }
  return '';
}

export interface MessageLinkData {
  serverId: string;
  channelId: string;
  messageId: string;
}

export function parseMessageLink(urlStr: string): MessageLinkData | null {
  if (!urlStr) return null;
  try {
    // Matches patterns like:
    // ...#/server/SERVER_ID/channel/CHANNEL_ID/message/MSG_ID
    // .../server/SERVER_ID/channel/CHANNEL_ID/message/MSG_ID
    // .../channel/CHANNEL_ID/message/MSG_ID
    const serverChanMsgRegex = /(?:#\/?|\/)(?:server\/([a-zA-Z0-9_-]+)\/)?channel\/([a-zA-Z0-9_-]+)\/message\/([a-zA-Z0-9_-]+)/i;
    const match = urlStr.match(serverChanMsgRegex);
    if (match && match[2] && match[3]) {
      return {
        serverId: match[1] || '',
        channelId: match[2],
        messageId: match[3]
      };
    }
  } catch (e) {}
  return null;
}

interface MessageLinkPreviewProps {
  url: string;
  currentServer?: Server;
  channels?: Channel[];
  currentChannelId?: string;
  lang?: string;
  isLight?: boolean;
  onNavigateToMessageLink?: (serverId: string, channelId: string, messageId: string) => void;
  scrollToMessage?: (msgId: string) => void;
}

export const MessageLinkPreviewCard: React.FC<MessageLinkPreviewProps> = React.memo(({
  url,
  currentServer,
  channels = [],
  currentChannelId,
  lang,
  isLight = false,
  onNavigateToMessageLink,
  scrollToMessage
}) => {
  const activeLang = lang || (typeof localStorage !== 'undefined' ? localStorage.getItem('language') : null) || 'en';
  const isAr = activeLang === 'ar';
  const linkData = parseMessageLink(url);
  const [targetMessage, setTargetMessage] = useState<Message | null>(null);
  const [targetChanName, setTargetChanName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDeleted, setIsDeleted] = useState<boolean>(() => {
    return Boolean(linkData?.messageId && MessageDeletionService.isMessageDeleted(linkData.messageId));
  });

  useEffect(() => {
    if (!linkData) {
      setLoading(false);
      return;
    }

    if (MessageDeletionService.isMessageDeleted(linkData.messageId)) {
      setIsDeleted(true);
      setLoading(false);
      return;
    }

    // Resolve channel name
    const foundChan = channels.find((c) => c.id === linkData.channelId);
    if (foundChan) {
      setTargetChanName(foundChan.name);
    } else {
      pbService.getChannelById(linkData.channelId).then((ch) => {
        if (ch?.name) setTargetChanName(ch.name);
      }).catch(() => {});
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    pbService
      .getMessageById(linkData.messageId)
      .then((msg) => {
        if (!isMounted) return;
        if (!msg || msg.deleted || (msg as any).deleted_at || MessageDeletionService.isMessageDeleted(msg.id)) {
          setIsDeleted(true);
        } else {
          setTargetMessage(msg);
          setIsDeleted(false);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        const errMsg = String(err?.message || '').toLowerCase();
        if (
          err?.status === 404 ||
          errMsg.includes('not found') ||
          errMsg.includes("wasn't found") ||
          errMsg.includes('deleted')
        ) {
          setIsDeleted(true);
        } else if (err?.status === 401 || err?.status === 403) {
          setError('No access to message');
        } else {
          setError('Message preview unavailable');
        }
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [linkData?.messageId, linkData?.channelId, channels]);

  if (!linkData) return null;

  const chanName = targetChanName || channels.find((c) => c.id === linkData.channelId)?.name || 'channel';

  const handleJump = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isDeleted) return;

    if (onNavigateToMessageLink) {
      onNavigateToMessageLink(linkData.serverId || currentServer?.id || 'dm', linkData.channelId, linkData.messageId);
    }
    if (currentChannelId === linkData.channelId && scrollToMessage) {
      scrollToMessage(linkData.messageId);
    }
  };

  // Render deleted state if message was removed
  if (isDeleted) {
    return (
      <div className="message-link-preview-card w-full max-w-lg min-h-[76px] rounded-2xl p-3 border shadow-sm my-2 flex items-center gap-3 select-none bg-[var(--theme-bg-secondary)] border-[var(--theme-border)] text-[var(--theme-text-muted)] opacity-85 transition-colors">
        <div className="w-9 h-9 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
          <Trash2 className="w-4 h-4 text-rose-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 font-bold text-xs text-rose-500">
            <span>{isAr ? 'رسالة محذوفة' : 'Deleted message'}</span>
            {chanName && (
              <span className="text-[10px] text-[var(--theme-text-muted)] font-mono">
                #{chanName}
              </span>
            )}
          </div>
          <p className="text-[11px] text-[var(--theme-text-muted)] truncate mt-0.5 italic">
            {isAr
              ? 'تم حذف هذه الرسالة من المحادثة ولا يمكن عرضها'
              : 'This message was deleted and is no longer available'}
          </p>
        </div>
      </div>
    );
  }

  // Check for image attachment inside targetMessage
  const rawAtts =
    targetMessage?.expand?.['attachments(message)'] ||
    targetMessage?.expand?.['private_attachments(message)'] ||
    targetMessage?.attachments ||
    [];
  const imageAttachment = Array.isArray(rawAtts)
    ? rawAtts.find((a: any) => {
        const file = a?.file || '';
        return /\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(file);
      })
    : null;

  return (
    <div
      onClick={handleJump}
      className="message-link-preview-card w-full max-w-lg min-h-[100px] rounded-2xl p-3.5 border shadow-md my-2 transition-colors cursor-pointer group bg-[var(--theme-bg-card)] border-[var(--theme-border)] text-[var(--theme-text-primary)] hover:bg-[var(--theme-bg-tertiary)] hover:border-accent/40"
    >
      {/* Header Channel Badge & Jump Action */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--theme-border)] pb-2 mb-2">
        <div className="flex items-center gap-1.5 font-bold text-xs text-accent truncate">
          <Hash className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{chanName}</span>
          <span className="text-[10px] font-mono text-[var(--theme-text-muted)] font-normal">
            ({isAr ? 'رسالة مشاركة' : 'Shared message'})
          </span>
        </div>
        <button
          type="button"
          onClick={handleJump}
          className="flex items-center gap-1 text-[11px] font-bold text-accent hover:underline bg-accent/10 px-2.5 py-1 rounded-lg border border-accent/20 cursor-pointer shrink-0 transition-transform active:scale-95"
        >
          <span>{isAr ? 'انتقال' : 'Jump'}</span>
          <ArrowUpRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-3 text-[var(--theme-text-muted)] text-xs">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
          <span>{isAr ? 'جاري تحميل الرسالة...' : 'Loading message preview...'}</span>
        </div>
      ) : error || !targetMessage ? (
        <div className="text-xs text-[var(--theme-text-muted)] italic py-1">
          {error || (isAr ? 'عذراً، تعذر العثور على الرسالة' : 'Message preview unavailable')}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* User info row */}
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-[var(--theme-bg-tertiary)] border border-[var(--theme-border)] overflow-hidden shrink-0 flex items-center justify-center text-[10px] font-bold text-[var(--theme-text-primary)]">
              {getSenderAvatar(targetMessage.expand?.sender) ? (
                <img
                  src={getSenderAvatar(targetMessage.expand?.sender)}
                  alt="Avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                <UserIcon className="w-3 h-3 text-[var(--theme-text-secondary)]" />
              )}
            </div>
            <span className="font-extrabold text-xs text-[var(--theme-text-primary)] truncate">
              {targetMessage.expand?.sender?.display_name || targetMessage.expand?.sender?.username || 'User'}
            </span>
            <span className="text-[9px] font-mono text-[var(--theme-text-muted)] ms-auto shrink-0">
              {new Date(targetMessage.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          {/* Truncated message content */}
          {targetMessage.content && targetMessage.content.trim().length > 0 && (
            <p className="text-xs text-[var(--theme-text-primary)] opacity-90 line-clamp-3 leading-relaxed font-normal whitespace-pre-wrap pl-8">
              {targetMessage.content}
            </p>
          )}

          {/* Image preview if message contains an image attachment */}
          {imageAttachment && (
            <div className="pl-8 mt-1">
              <div className="max-w-[200px] max-h-[140px] rounded-xl overflow-hidden border border-[var(--theme-border)] bg-[var(--theme-bg-tertiary)]">
                <img
                  src={`${pbService.getServerUrl()}/api/files/attachments/${imageAttachment.id}/${imageAttachment.file}`}
                  alt=""
                  className="w-full h-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              </div>
            </div>
          )}

          {/* Attachment indicator if any */}
          {rawAtts && rawAtts.length > 0 && !imageAttachment && (
            <div className="flex items-center gap-1 text-[10px] font-semibold text-accent pl-8 mt-0.5">
              <PaperclipIcon className="w-3 h-3" />
              <span>
                {isAr
                  ? `تحتوي على ${rawAtts.length} مرفق`
                  : `Contains ${rawAtts.length} attachment${rawAtts.length > 1 ? 's' : ''}`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const PaperclipIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
  </svg>
);
