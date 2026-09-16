import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Search, UserPlus, Users, X } from 'lucide-react';
import { User } from '../types';
import { MediaParticipant } from '../types/media';
import { pbService } from '../pocketbase';
import Avatar from './Avatar';

interface CallInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvite: (user: User) => Promise<boolean>;
  currentUserId: string;
  participants: MediaParticipant[];
  maxParticipants?: number;
  lang?: 'en' | 'ar';
}

/** Small, mobile-safe picker for inviting users to an existing voice room. */
export const CallInviteModal: React.FC<CallInviteModalProps> = ({
  isOpen,
  onClose,
  onInvite,
  currentUserId,
  participants,
  maxParticipants = 8,
  lang = 'en',
}) => {
  const isAr = lang === 'ar';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());
  const occupiedIds = useMemo(() => new Set(participants.map((participant) => participant.userId)), [participants]);
  const roomFull = participants.length >= maxParticipants;

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setResults([]);
    setInvitingId(null);
    setInvitedIds(new Set());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    const timer = window.setTimeout(async () => {
      const users = await pbService.searchUsers(trimmed);
      if (!cancelled) {
        setResults(users.filter((user) => user.id !== currentUserId && !occupiedIds.has(user.id)).slice(0, 20));
        setIsSearching(false);
      }
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentUserId, isOpen, occupiedIds, query]);

  const handleInvite = async (user: User) => {
    if (roomFull || invitingId || invitedIds.has(user.id)) return;
    setInvitingId(user.id);
    try {
      const sent = await onInvite(user);
      if (sent) setInvitedIds((previous) => new Set(previous).add(user.id));
    } finally {
      setInvitingId(null);
    }
  };

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1000000] bg-black/70 flex items-center justify-center p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-sm max-h-[min(560px,90vh)] rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg-card)] text-[var(--theme-text-primary)] shadow-2xl overflow-hidden flex flex-col"
        dir={isAr ? 'rtl' : 'ltr'}
        role="dialog"
        aria-modal="true"
        aria-label={isAr ? 'دعوة إلى المكالمة' : 'Invite to call'}
      >
        <div className="px-4 py-3 border-b border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-accent/15 text-accent border border-accent/30 flex items-center justify-center shrink-0">
              <UserPlus className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="font-extrabold text-sm truncate">{isAr ? 'دعوة أشخاص' : 'Invite people'}</h3>
              <p className="text-[10px] text-[var(--theme-text-muted)] flex items-center gap-1">
                <Users className="w-3 h-3" />
                {participants.length}/{maxParticipants} {isAr ? 'في الغرفة' : 'in room'}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-[var(--theme-text-muted)] hover:bg-[var(--theme-bg-tertiary)] cursor-pointer" aria-label={isAr ? 'إغلاق' : 'Close'}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 flex-1 min-h-0 flex flex-col">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--theme-text-muted)]" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isAr ? 'ابحث باسم المستخدم...' : 'Search by username...'}
              className="w-full h-10 pl-9 pr-3 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] text-sm outline-none focus:border-accent"
            />
          </div>

          {roomFull && (
            <p className="text-xs text-amber-500 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              {isAr ? 'الغرفة ممتلئة.' : 'This call has reached its participant limit.'}
            </p>
          )}

          <div className="overflow-y-auto space-y-1.5 min-h-0">
            {isSearching ? (
              <div className="py-8 flex items-center justify-center text-[var(--theme-text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : query.trim().length < 2 ? (
              <p className="py-8 text-center text-xs text-[var(--theme-text-muted)]">{isAr ? 'اكتب حرفين على الأقل للبحث.' : 'Type at least two characters to search.'}</p>
            ) : results.length === 0 ? (
              <p className="py-8 text-center text-xs text-[var(--theme-text-muted)]">{isAr ? 'لم يتم العثور على مستخدمين.' : 'No users found.'}</p>
            ) : (
              results.map((user) => {
                const isInvited = invitedIds.has(user.id);
                const isBusy = invitingId === user.id;
                return (
                  <div key={user.id} className="flex items-center gap-2.5 p-2 rounded-xl border border-transparent hover:border-[var(--theme-border)] hover:bg-[var(--theme-bg-secondary)]">
                    <Avatar src={user.avatar || ''} username={user.display_name || user.username} size="sm" className="w-8 h-8 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold truncate">{user.display_name || user.username}</p>
                      <p className="text-[10px] text-[var(--theme-text-muted)] truncate">@{user.username}</p>
                    </div>
                    <button
                      type="button"
                      disabled={roomFull || isBusy || isInvited}
                      onClick={() => handleInvite(user)}
                      className={`shrink-0 h-8 px-2.5 rounded-lg text-[10px] font-bold flex items-center gap-1 border cursor-pointer disabled:cursor-not-allowed disabled:opacity-70 ${isInvited ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' : 'bg-accent text-white border-accent hover:opacity-90'}`}
                    >
                      {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : isInvited ? <Check className="w-3 h-3" /> : <UserPlus className="w-3 h-3" />}
                      <span>{isInvited ? (isAr ? 'تم' : 'Sent') : isAr ? 'دعوة' : 'Invite'}</span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default CallInviteModal;
