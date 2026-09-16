import React, { useState, useMemo, useEffect } from 'react';
import { Channel, Message, User, Server, Attachment, ServerMember } from '../types';
import { Search, X, Calendar, User as UserIcon, Filter, Paperclip, ArrowRight } from 'lucide-react';
import { getUserAvatarUrl, pbService } from '../pocketbase';
import { isAttachmentAudio, isAttachmentImage, isAttachmentVideo } from '../services/attachmentProcessor';

type SearchHasFilter = 'all' | 'file' | 'image' | 'video' | 'audio' | 'link';

type MemberSuggestion = {
  user: User;
  displayName: string;
  username: string;
};

const ATTACHMENT_EXPANSION_KEYS = [
  'attachments(message)',
  'private_attachments(message)',
  'attachments',
  'private_attachments',
] as const;
const EMPTY_SERVER_MEMBERS: ServerMember[] = [];

/**
 * PocketBase returns expanded message attachments under a relation key. Older
 * records and offline cache can also contain the attachment array directly,
 * so normalize every supported shape before applying a content filter.
 */
function getMessageAttachments(message: Message): Array<Attachment | string> {
  const values: unknown[] = [];
  if (Array.isArray(message.attachments)) values.push(...message.attachments);
  for (const key of ATTACHMENT_EXPANSION_KEYS) {
    const expanded = message.expand?.[key];
    if (Array.isArray(expanded)) values.push(...expanded);
  }

  const seen = new Set<string>();
  return values.filter((value): value is Attachment | string => {
    if (typeof value !== 'string' && (!value || typeof value !== 'object')) return false;
    const record = typeof value === 'string' ? null : value as Partial<Attachment> & { filename?: string; name?: string };
    const fileName = typeof value === 'string'
      ? value
      : String(record.file || record.filename || record.name || record.url || '');
    const key = String(record?.id || fileName);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function attachmentFileName(attachment: Attachment | string): string {
  if (typeof attachment === 'string') return attachment;
  const value = attachment as Attachment & { filename?: string; name?: string };
  return String(value.file || value.filename || value.name || value.url || '');
}

function attachmentMimeType(attachment: Attachment | string): string | undefined {
  if (typeof attachment === 'string') return undefined;
  const value = attachment as Attachment & { mimeType?: string };
  return value.type || value.mimeType;
}

function normalizeHasFilter(value: string): SearchHasFilter {
  const token = value.toLowerCase().replace(/s$/, '');
  if (token === 'attachment' || token === 'file') return 'file';
  if (token === 'image') return 'image';
  if (token === 'video') return 'video';
  if (token === 'audio') return 'audio';
  if (token === 'link') return 'link';
  return 'all';
}

function parseDateBoundary(value: string, endOfDay: boolean): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]) + (endOfDay ? 1 : 0);
    const parsed = new Date(year, month, day).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildMemberSuggestions(
  members: ServerMember[],
  cachedUsers: User[],
  currentUser: User,
  server: Server | null,
): MemberSuggestion[] {
  const usersById = new Map(cachedUsers.map((user) => [user.id, user]));
  const byId = new Map<string, MemberSuggestion>();

  for (const member of members) {
    if (member.is_member === false || member.membership_status === 'left' || member.membership_status === 'banned' || member.membership_status === 'kicked') continue;
    const user = member.expand?.user || usersById.get(member.user);
    if (!user?.id || !user.username) continue;
    byId.set(user.id, {
      user,
      displayName: member.nickname || member.member_name || user.display_name || user.username,
      username: user.username,
    });
  }

  // Keep the signed-in user and owner searchable even when a stale membership
  // cache has not loaded those records yet.
  if (currentUser?.id && currentUser.username && !byId.has(currentUser.id)) {
    byId.set(currentUser.id, {
      user: currentUser,
      displayName: currentUser.display_name || currentUser.username,
      username: currentUser.username,
    });
  }
  if (server?.owner && !byId.has(server.owner)) {
    const owner = usersById.get(server.owner);
    if (owner?.username) {
      byId.set(owner.id, {
        user: owner,
        displayName: owner.display_name || owner.username,
        username: owner.username,
      });
    }
  }

  return Array.from(byId.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
}

interface AdvancedSearchModalProps {
  server: Server | null;
  currentChannel: Channel;
  serverChannels: Channel[];
  serverMembers?: ServerMember[];
  currentUser: User;
  onClose: () => void;
  onSelectMessage: (channelId: string, messageId: string) => void;
  lang?: 'en' | 'ar';
}

export default function AdvancedSearchModal({
  server,
  currentChannel,
  serverChannels,
  serverMembers = EMPTY_SERVER_MEMBERS,
  currentUser,
  onClose,
  onSelectMessage,
  lang = 'en'
}: AdvancedSearchModalProps) {
  const [query, setQuery] = useState('');
  const [targetChannelId, setTargetChannelId] = useState<string>(currentChannel.id);
  const [searchScope, setSearchScope] = useState<'current' | 'all_server'>('current');
  const [filterUser, setFilterUser] = useState<string>('');
  const [filterBefore, setFilterBefore] = useState<string>('');
  const [filterAfter, setFilterAfter] = useState<string>('');
  const [filterHas, setFilterHas] = useState<SearchHasFilter>('all');
  const [memberDirectory, setMemberDirectory] = useState<MemberSuggestion[]>([]);
  const [showUserSuggestions, setShowUserSuggestions] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);

  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<Message[]>([]);

  // Hydrate the autocomplete synchronously from the same server-member cache
  // used by the member list, then refresh it in the background. This keeps the
  // picker useful immediately without scanning the global user directory.
  useEffect(() => {
    if (!server?.id) {
      setMemberDirectory([]);
      return;
    }

    let cancelled = false;
    const cachedMembers = serverMembers.length > 0
      ? serverMembers
      : pbService.getCachedServerMembers(server.id);
    const cachedUsers = pbService.getCachedUsers();
    setMemberDirectory(buildMemberSuggestions(cachedMembers, cachedUsers, currentUser, server));

    // ChatPanel already refreshes this collection in the background. Avoid a
    // second request when the modal is opened after that shared state is ready.
    if (serverMembers.length > 0) {
      return () => {
        cancelled = true;
      };
    }

    pbService.fetchServerMembers(server.id).then((freshMembers) => {
      if (cancelled || !Array.isArray(freshMembers)) return;
      setMemberDirectory(buildMemberSuggestions(freshMembers, pbService.getCachedUsers(), currentUser, server));
    }).catch(() => {
      // Cached members remain available while the server is offline.
    });

    return () => {
      cancelled = true;
    };
  }, [server?.id, server?.owner, serverMembers, currentUser.id, currentUser.username, currentUser.display_name]);

  const memberSuggestions = useMemo(() => {
    const entered = filterUser.trim().replace(/^from:/i, '').trim().toLowerCase();
    if (!entered) return memberDirectory.slice(0, 8);
    return memberDirectory.filter(({ displayName, username }) =>
      displayName.toLowerCase().includes(entered) || username.toLowerCase().includes(entered),
    ).slice(0, 8);
  }, [filterUser, memberDirectory]);

  useEffect(() => {
    setActiveSuggestionIndex((index) => Math.min(index, Math.max(memberSuggestions.length - 1, 0)));
  }, [memberSuggestions.length]);

  const selectMemberSuggestion = (suggestion: MemberSuggestion) => {
    setFilterUser(suggestion.username);
    setShowUserSuggestions(false);
    setActiveSuggestionIndex(0);
  };

  // Parse inline search tokens like `from:username`, `in:channel`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`
  useEffect(() => {
    let cancelled = false;

    const handleSearch = async () => {
      let textQuery = query;
      let fromUser = filterUser.trim().replace(/^from:/i, '').trim();
      let inChan = searchScope === 'current' ? targetChannelId : '';
      let beforeDate = filterBefore;
      let afterDate = filterAfter;
      let hasType: SearchHasFilter = filterHas;

      // Parse query string tokens
      const fromMatch = textQuery.match(/from:([^\s]+)/i);
      if (fromMatch) {
        fromUser = fromMatch[1].replace(/^@/, '');
        textQuery = textQuery.replace(fromMatch[0], '').trim();
      }

      const inMatch = textQuery.match(/in:([^\s]+)/i);
      if (inMatch) {
        const chanName = inMatch[1].replace('#', '');
        const matchedChan = serverChannels.find((c) => c.name.toLowerCase() === chanName.toLowerCase() || c.id === chanName);
        if (matchedChan) inChan = matchedChan.id;
        textQuery = textQuery.replace(inMatch[0], '').trim();
      }

      const beforeMatch = textQuery.match(/before:([^\s]+)/i);
      if (beforeMatch) {
        beforeDate = beforeMatch[1];
        textQuery = textQuery.replace(beforeMatch[0], '').trim();
      }

      const afterMatch = textQuery.match(/after:([^\s]+)/i);
      if (afterMatch) {
        afterDate = afterMatch[1];
        textQuery = textQuery.replace(afterMatch[0], '').trim();
      }

      const hasMatch = textQuery.match(/has:(attachment|attachments|file|files|image|images|video|videos|audio|audios|link|links)/i);
      if (hasMatch) {
        hasType = normalizeHasFilter(hasMatch[1]);
        textQuery = textQuery.replace(hasMatch[0], '').trim();
      }

      const hasSearchCriteria = Boolean(
        textQuery.trim() || fromUser || beforeDate || afterDate || hasType !== 'all',
      );
      if (!hasSearchCriteria) {
        if (!cancelled) {
          setResults([]);
          setIsLoading(false);
        }
        return;
      }

      setIsLoading(true);
      try {
        const searchChannels = Array.from(new Map(
          (inChan
            ? [serverChannels.find((c) => c.id === inChan) || currentChannel]
            : (searchScope === 'all_server' && serverChannels.length > 0 ? serverChannels : [currentChannel])
          ).map((channel) => [channel.id, channel]),
        ).values());
        const qLower = textQuery.trim().toLowerCase();
        const fromLower = fromUser.toLowerCase();
        const beforeTime = parseDateBoundary(beforeDate, true);
        const afterTime = parseDateBoundary(afterDate, false);

        const channelMatches = await Promise.all(searchChannels.map(async (chan) => {
          try {
            const isDm = currentChannel.server === 'dm' || currentChannel.name.startsWith('@') || currentChannel.id.startsWith('dm-');
            let messagesForChannel: Message[];
            if (isDm) {
              const recipientId = currentChannel.recipientUser?.id || currentChannel.recipientId;
              if (!recipientId) return [];
              const chatServerId = currentChannel.id.startsWith('dm-server-')
                ? currentChannel.id.replace(/^dm-server-/, '')
                : undefined;
              messagesForChannel = await pbService.fetchDirectMessages(recipientId, chatServerId, false);
            } else {
              const list = await pbService.fetchMessages(chan.id, 1, 100);
              messagesForChannel = list.items;
            }
            return messagesForChannel.flatMap((msg): Message[] => {
              if (msg.deleted || msg.deleted_at) return [];

              // Text query matching
              if (qLower && !msg.content?.toLowerCase().includes(qLower)) {
                return [];
              }

              // From user matching
              if (fromLower) {
                const sender = msg.expand?.sender;
                const senderValues = [msg.sender, sender?.id, sender?.username, sender?.display_name]
                  .filter(Boolean)
                  .map((value) => String(value).toLowerCase());
                if (!senderValues.some((value) => value.includes(fromLower))) {
                  return [];
                }
              }

              // Date filtering
              const msgTime = msg.created ? new Date(msg.created).getTime() : NaN;
              if (beforeTime !== null && !Number.isNaN(msgTime) && msgTime >= beforeTime) {
                return [];
              }
              if (afterTime !== null && !Number.isNaN(msgTime) && msgTime < afterTime) {
                return [];
              }

              // Media / Has filtering
              const attachments = getMessageAttachments(msg);
              if (hasType === 'file' && attachments.length === 0 && !msg.has_attachment) return [];
              if (hasType === 'image' && !attachments.some((attachment) =>
                isAttachmentImage(attachmentFileName(attachment), attachmentMimeType(attachment)),
              )) return [];
              if (hasType === 'video' && !attachments.some((attachment) =>
                isAttachmentVideo(attachmentFileName(attachment), attachmentMimeType(attachment)),
              )) return [];
              if (hasType === 'audio' && !attachments.some((attachment) =>
                isAttachmentAudio(attachmentFileName(attachment), attachmentMimeType(attachment)),
              )) return [];
              if (hasType === 'link' && !/(https?:\/\/[^\s]+)/i.test(msg.content || '')) return [];

              return [{ ...msg, channel: chan.id }];
            });
          } catch (e) {
            return [];
          }
        }));

        if (cancelled) return;
        const allMatched = channelMatches.flat();
        const seen = new Set<string>();
        const uniqueMatched = allMatched.filter((message) => {
          const key = `${message.channel}:${message.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        uniqueMatched.sort((a, b) => {
          const createdDiff = new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime();
          return createdDiff || String(b.id).localeCompare(String(a.id));
        });
        setResults(uniqueMatched.slice(0, 50));
      } catch (err) {
        if (!cancelled) console.warn('Advanced search error:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    const timer = setTimeout(handleSearch, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, targetChannelId, searchScope, filterUser, filterBefore, filterAfter, filterHas, currentChannel.id, serverChannels]);

  return (
    <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        className="w-full max-w-3xl bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] text-[var(--theme-text-primary)] animate-in zoom-in-95 duration-150"
        dir={lang === 'ar' ? 'rtl' : 'ltr'}
      >
        {/* Header with Search Input */}
        <div className="p-4 border-b border-[var(--theme-border)] flex flex-col gap-3 bg-[var(--theme-bg-primary)]/80">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Search className="w-5 h-5 text-accent" />
              <h2 className="text-sm font-black uppercase tracking-wider text-[var(--theme-text-primary)]">
                {lang === 'ar' ? 'البحث المتقدم والفلاتر' : 'Advanced Search & Filters'}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full hover:bg-[var(--theme-bg-tertiary)] text-[var(--theme-text-muted)] hover:text-[var(--theme-text-primary)] transition-colors cursor-pointer border-0 bg-transparent"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2 p-2.5 rounded-2xl bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] focus-within:border-accent shadow-inner">
            <Search className="w-4 h-4 text-[var(--theme-text-muted)] shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                lang === 'ar'
                  ? 'ابحث عن نص، أو اكتب from:user أو in:channel أو before:2026-08-01...'
                  : 'Search text, or type from:user in:general before:2026-08-01...'
              }
              className="flex-1 bg-transparent text-sm text-[var(--theme-text-primary)] placeholder-[var(--theme-text-muted)] focus:outline-none"
              autoFocus
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-[var(--theme-text-muted)] hover:text-[var(--theme-text-primary)] p-1 cursor-pointer bg-transparent border-0"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Quick Filter Modifiers */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Scope */}
            {server && serverChannels.length > 1 && (
              <div className="flex items-center gap-1 bg-[var(--theme-bg-secondary)] p-1 rounded-xl border border-[var(--theme-border)]">
                <button
                  type="button"
                  onClick={() => setSearchScope('current')}
                  className={`px-2.5 py-1 rounded-lg font-bold transition-all cursor-pointer border-0 ${
                    searchScope === 'current' ? 'bg-accent text-white shadow-xs' : 'text-[var(--theme-text-muted)] hover:text-[var(--theme-text-primary)] bg-transparent'
                  }`}
                >
                  #{currentChannel.name}
                </button>
                <button
                  type="button"
                  onClick={() => setSearchScope('all_server')}
                  className={`px-2.5 py-1 rounded-lg font-bold transition-all cursor-pointer border-0 ${
                    searchScope === 'all_server' ? 'bg-accent text-white shadow-xs' : 'text-[var(--theme-text-muted)] hover:text-[var(--theme-text-primary)] bg-transparent'
                  }`}
                >
                  {lang === 'ar' ? 'كل قنوات السيرفر' : 'All Server Channels'}
                </button>
              </div>
            )}

            {/* From Filter */}
            <div className="relative">
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] focus-within:border-accent">
                <UserIcon className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <input
                  type="text"
                  value={filterUser}
                  onChange={(e) => {
                    setFilterUser(e.target.value);
                    setShowUserSuggestions(true);
                    setActiveSuggestionIndex(0);
                  }}
                  onFocus={() => setShowUserSuggestions(true)}
                  onBlur={() => window.setTimeout(() => setShowUserSuggestions(false), 120)}
                  onKeyDown={(event) => {
                    if (!showUserSuggestions || memberSuggestions.length === 0) return;
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setActiveSuggestionIndex((index) => (index + 1) % memberSuggestions.length);
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setActiveSuggestionIndex((index) => (index - 1 + memberSuggestions.length) % memberSuggestions.length);
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      selectMemberSuggestion(memberSuggestions[activeSuggestionIndex]);
                    } else if (event.key === 'Escape') {
                      setShowUserSuggestions(false);
                    }
                  }}
                  placeholder="from:username"
                  aria-label={lang === 'ar' ? 'البحث حسب المستخدم' : 'Filter by user'}
                  aria-autocomplete="list"
                  aria-expanded={showUserSuggestions && memberSuggestions.length > 0}
                  className="bg-transparent text-xs text-[var(--theme-text-primary)] placeholder-[var(--theme-text-muted)] focus:outline-none w-28 min-w-0"
                />
              </div>
              {showUserSuggestions && memberSuggestions.length > 0 && (
                <div
                  role="listbox"
                  className="absolute z-30 left-0 top-full mt-1 w-64 max-h-56 overflow-y-auto rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-1.5 shadow-2xl"
                >
                  {memberSuggestions.map((suggestion, index) => (
                    <button
                      key={suggestion.user.id}
                      type="button"
                      role="option"
                      aria-selected={index === activeSuggestionIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectMemberSuggestion(suggestion)}
                      className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors cursor-pointer border-0 ${
                        index === activeSuggestionIndex
                          ? 'bg-accent/15 text-[var(--theme-text-primary)]'
                          : 'bg-transparent text-[var(--theme-text-secondary)] hover:bg-[var(--theme-bg-tertiary)]'
                      }`}
                    >
                      {getUserAvatarUrl(suggestion.user) ? (
                        <img
                          src={getUserAvatarUrl(suggestion.user)}
                          alt=""
                          className="w-6 h-6 rounded-full object-cover shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <span className="w-6 h-6 rounded-full bg-accent/20 text-accent flex items-center justify-center text-[10px] font-black shrink-0">
                          {suggestion.displayName.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-bold">{suggestion.displayName}</span>
                        <span className="block truncate text-[10px] opacity-70">@{suggestion.username}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* After Date Filter */}
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)]">
              <Calendar className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-[10px] text-[var(--theme-text-muted)]">{lang === 'ar' ? 'بعد:' : 'After:'}</span>
              <input
                type="date"
                value={filterAfter}
                onChange={(e) => setFilterAfter(e.target.value)}
                className="bg-transparent text-xs text-[var(--theme-text-primary)] focus:outline-none"
              />
            </div>

            {/* Before Date Filter */}
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)]">
              <Calendar className="w-3.5 h-3.5 text-rose-400" />
              <span className="text-[10px] text-[var(--theme-text-muted)]">{lang === 'ar' ? 'قبل:' : 'Before:'}</span>
              <input
                type="date"
                value={filterBefore}
                onChange={(e) => setFilterBefore(e.target.value)}
                className="bg-transparent text-xs text-[var(--theme-text-primary)] focus:outline-none"
              />
            </div>

            {/* Has Filter */}
            <select
              value={filterHas}
              onChange={(e) => setFilterHas(e.target.value as SearchHasFilter)}
              className="px-2.5 py-1 rounded-xl bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] text-xs text-[var(--theme-text-secondary)] focus:outline-none cursor-pointer"
            >
              <option value="all">{lang === 'ar' ? 'كل أنواع المحتوى' : 'All Content'}</option>
              <option value="file">{lang === 'ar' ? 'يحتوي على ملفات' : 'Has Files'}</option>
              <option value="image">{lang === 'ar' ? 'يحتوي على صور' : 'Has Images'}</option>
              <option value="video">{lang === 'ar' ? 'يحتوي على فيديو' : 'Has Videos'}</option>
              <option value="audio">{lang === 'ar' ? 'يحتوي على صوت' : 'Has Audio'}</option>
              <option value="link">{lang === 'ar' ? 'يحتوي على روابط' : 'Has Links'}</option>
            </select>
          </div>
        </div>

        {/* Results List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5 hover-scrollbar min-h-[300px]">
          {isLoading ? (
            <div className="py-12 text-center text-[var(--theme-text-muted)] text-sm animate-pulse">
              {lang === 'ar' ? 'جارٍ البحث...' : 'Searching...'}
            </div>
          ) : results.length === 0 ? (
            <div className="py-12 text-center text-[var(--theme-text-muted)] text-sm flex flex-col items-center gap-2">
              <Filter className="w-8 h-8 opacity-40" />
              <span>{lang === 'ar' ? 'لم يتم العثور على رسائل تطابق معايير البحث.' : 'No messages matched your search filters.'}</span>
            </div>
          ) : (
            results.map((msg) => {
              const matchedChan = serverChannels.find((c) => c.id === msg.channel) || currentChannel;
              const sender = msg.expand?.sender;
              const senderName = sender?.display_name || sender?.username || 'User';
              const senderUsername = sender?.username || (sender?.id === currentUser.id ? currentUser.username : '');
              const attachments = getMessageAttachments(msg);

              return (
                <div
                  key={`${msg.channel}:${msg.id}`}
                  onClick={() => {
                    onSelectMessage(msg.channel, msg.id);
                    onClose();
                  }}
                  className="p-3 rounded-2xl bg-[var(--theme-bg-primary)] border border-[var(--theme-border)] hover:border-accent/60 hover:bg-[var(--theme-bg-tertiary)] transition-all cursor-pointer flex flex-col gap-1.5 group"
                >
                  <div className="flex items-center justify-between text-xs text-[var(--theme-text-muted)]">
                    <div className="flex items-center gap-2 font-bold">
                      <span className="text-[var(--theme-text-primary)] font-extrabold">{senderName}</span>
                      {senderUsername && <span className="text-[10px] text-[var(--theme-text-muted)]">@{senderUsername}</span>}
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] text-accent font-mono">
                        #{matchedChan.name}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-[var(--theme-text-muted)]">
                      {new Date(msg.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  <p className="text-xs text-[var(--theme-text-secondary)] line-clamp-2 leading-relaxed break-words font-medium">
                    {msg.content || (attachments.length > 0 ? (lang === 'ar' ? '📎 [مرفق]' : '📎 [Attachment]') : '')}
                  </p>

                  {attachments.length > 0 && (
                    <div className="flex items-center gap-1 text-[10px] text-[var(--theme-text-muted)]">
                      <Paperclip className="w-3 h-3" />
                      <span>{attachments.length} {lang === 'ar' ? 'مرفق' : attachments.length === 1 ? 'attachment' : 'attachments'}</span>
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-1 text-[10px] text-accent opacity-0 group-hover:opacity-100 transition-opacity font-bold">
                    <span>{lang === 'ar' ? 'الانتقال إلى الرسالة' : 'Jump to message'}</span>
                    <ArrowRight className="w-3 h-3" />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
