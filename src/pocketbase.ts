import PocketBase from 'pocketbase';
import { parseReactions, toggleReactionInList } from './components/MessageReactions';
import { User, Server, Channel, Message, Attachment, Call, ServerMember, Translation, NotificationItem, ServerRole, ServerOptionInvite, ChannelOptions, DownloadedFileRecord, AppUpdateRecord, ServerEmoji, MessageCursor, MessagePage } from './types';
import { MessageDeletionService, DeleteMessageOptions } from './services/messageDeletionService';
import type { GeneratedThumbnailFile } from './services/attachmentProcessor';
import { inferMimeType } from './services/attachmentMime';
import { offlineCacheService } from './services/offlineCacheService';
import wsService from './services/websocket';
import ENDPOINTS from './config/endpoints';
import APP_URLS from './config/urls';
import { buildOlderMessageFilter, cursorFromMessage, INITIAL_MESSAGE_PAGE_SIZE } from './services/messagePagination';
import { isUserPresenceExpired } from './services/presencePolicy';
export { USER_PRESENCE_EXPIRY_MS } from './services/presencePolicy';

export class PocketBaseUnavailableError extends Error {
  readonly code = 'BACKEND_UNAVAILABLE';
  readonly status?: number;

  constructor(message = 'The chat service is temporarily unavailable', status?: number) {
    super(message);
    this.name = 'PocketBaseUnavailableError';
    this.status = status;
  }
}

/**
 * Compatibility fallbacks are safe only for a confirmed schema/collection
 * mismatch. Transport failures must bubble out so callers can keep cached
 * content visible instead of launching a waterfall of increasingly broad
 * requests while the backend is offline.
 */
function isSchemaCompatibilityError(error: any): boolean {
  if (!error) return false;
  if (error.isAbort || error.name === 'AbortError') return false;

  const status = Number(error.status || error.response?.code || 0);
  // Transport, timeout, and server outage errors (status 0, 408, >= 500) are never schema errors
  if (status === 0 || status === 408 || status >= 500) return false;

  const message = String(error.message || error.response?.message || error.responseText || '').toLowerCase();
  if (message.includes('failed to fetch') || message.includes('network error') || message.includes('timeout') || message.includes('networkerror')) {
    return false;
  }

  // 404 means the requested collection or record does not exist on this backend
  if (status === 404) return true;

  if (status === 400 || status === 422) {
    const dataStr = JSON.stringify(error.response?.data || error.data || '').toLowerCase();
    const fullText = `${message} ${dataStr}`;

    // Standard PocketBase error strings and schema mismatch indicators
    if (
      message.includes('something went wrong while processing your request') ||
      message.includes("the requested resource wasn't found") ||
      /(?:collection|field|relation|expand|filter|sort|unknown|missing|invalid|syntax|does not exist|not found|validation)/.test(fullText)
    ) {
      return true;
    }
  }

  return false;
}

let cachedMessageExpand = 'sender,reply_to,attachments(message),private_attachments(message)';

export function mergeUserRecord(existing: User | null | undefined, updated: Partial<User> | null | undefined): User {
  if (!existing && !updated) {
    return {
      id: '',
      username: 'User',
      email: '',
      role: 'user',
      status: 'offline'
    };
  }
  if (!existing) return updated as User;
  if (!updated) return existing;

  const existingLastSeen = existing.last_seen ? new Date(existing.last_seen).getTime() : 0;
  const updatedLastSeen = updated.last_seen ? new Date(updated.last_seen).getTime() : 0;

  // Preserve the newer heartbeat timestamp to prevent race conditions or stale event downgrades
  const effectiveLastSeen = updatedLastSeen >= existingLastSeen
    ? (updated.last_seen || existing.last_seen)
    : existing.last_seen;

  return {
    ...existing,
    ...updated,
    last_seen: effectiveLastSeen
  };
}

export function getEffectiveUserStatus(user: User | null | undefined, isCurrentUser: boolean = false): 'online' | 'offline' | 'away' | 'dnd' {
  if (!user) return 'offline';
  
  const rawStatus = user.status as 'online' | 'offline' | 'away' | 'dnd' | undefined;
  
  // Invisible or explicit offline status means offline
  if (rawStatus === 'offline') {
    return 'offline';
  }

  // Active current user logged into browser
  if (isCurrentUser) {
    return rawStatus || 'online';
  }

  // For other users, if status is not explicitly set to online/away/dnd, they are offline
  if (!rawStatus || (rawStatus !== 'online' && rawStatus !== 'away' && rawStatus !== 'dnd')) {
    return 'offline';
  }
  
  // Real-time connectivity check ONLY using actual heartbeat timestamp (last_seen).
  // CRITICAL: NEVER use user.updated! user.updated changes when messages, notifications, or edits occur.
  const lastHeartbeatMs = user.last_seen ? new Date(user.last_seen).getTime() : 0;

  if (!lastHeartbeatMs || isNaN(lastHeartbeatMs) || lastHeartbeatMs <= 0) {
    return 'offline';
  }

  // Use the same expiry window as the periodic member-list refresh. A single
  // policy avoids the same user appearing online in one surface and offline
  // in another.
  if (isUserPresenceExpired(user)) {
    return 'offline';
  }

  return rawStatus;
}

export function extractCooldown(text: string | undefined): { cleanText: string; cooldown: number } {
  if (!text) return { cleanText: '', cooldown: 0 };
  const match = text.match(/\[cooldown:(\d+)\]/);
  if (match) {
    const cooldown = parseInt(match[1], 10);
    const cleanText = text.replace(/\[cooldown:\d+\]/, '').trim();
    return { cleanText, cooldown };
  }
  return { cleanText: text, cooldown: 0 };
}

export function injectCooldown(text: string | undefined, cooldown: number): string {
  const { cleanText } = extractCooldown(text);
  if (cooldown <= 0) return cleanText;
  return cleanText ? `${cleanText} [cooldown:${cooldown}]` : `[cooldown:${cooldown}]`;
}

export function getFileUrl(collection: string, recordId: string, filename: string, queryParams?: string): string {
  if (!filename) return '';
  if (filename.startsWith('data:') || filename.startsWith('blob:') || filename.startsWith('http')) {
    return filename;
  }
  return APP_URLS.getFileUrl(pbService.getServerUrl(), collection, recordId, filename, queryParams);
}

export function normalizeAttachmentRecords(pubAtts: any[] = [], privAtts: any[] = []): Attachment[] {
  const normalizedPub = pubAtts.map((a) => ({
    ...a,
    collectionName: a.collectionName || a['@collectionName'] || 'attachments',
    type: inferMimeType(a.file, a.type)
  }));
  const normalizedPriv = privAtts.map((a) => ({
    ...a,
    collectionName: a.collectionName || a['@collectionName'] || 'private_attachments',
    isPrivate: true,
    type: inferMimeType(a.file, a.type)
  }));
  const seen = new Set<string>();
  const combined: Attachment[] = [];
  for (const item of [...normalizedPub, ...normalizedPriv]) {
    if (!item) continue;
    const key = item.id || item.file;
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(item);
    }
  }
  return combined;
}

export function getAttachmentUrl(recordIdOrAttach: any, filename?: string, collectionName?: string): string {
  if (typeof recordIdOrAttach === 'object' && recordIdOrAttach !== null) {
    const recordId = recordIdOrAttach.id;
    const fn = recordIdOrAttach.file || filename || '';
    if (recordIdOrAttach.url && (recordIdOrAttach.url.startsWith('blob:') || recordIdOrAttach.url.startsWith('data:'))) {
      return recordIdOrAttach.url;
    }
    const coll =
      recordIdOrAttach.collectionName ||
      recordIdOrAttach['@collectionName'] ||
      (recordIdOrAttach.isPrivate ? 'private_attachments' : null) ||
      collectionName ||
      'attachments';
    if (!recordId || !fn) return '';
    if (fn.startsWith('data:') || fn.startsWith('blob:') || fn.startsWith('http://') || fn.startsWith('https://')) {
      return fn;
    }
    return getFileUrl(coll, recordId, fn);
  }

  const recordId = recordIdOrAttach;
  const fn = filename || '';
  if (!recordId || !fn) return '';
  if (fn.startsWith('data:') || fn.startsWith('blob:') || fn.startsWith('http://') || fn.startsWith('https://')) {
    return fn;
  }
  const coll = collectionName || 'attachments';
  return getFileUrl(coll, recordId, fn);
}

export function getUserAvatarUrl(user: User | null | undefined): string {
  if (!user || !user.avatar || user.avatar === 'REMOVE') return '';
  return getFileUrl('users', user.id, user.avatar);
}

export function getUserBannerUrl(user: User | null | undefined): string {
  if (!user || !user.banner || user.banner === 'REMOVE') return '';
  return getFileUrl('users', user.id, user.banner);
}

export function getServerIconUrl(server: Server | null | undefined): string {
  if (!server) return '';
  const localIcon = localStorage.getItem(`server_icon_${server.id}`);
  if (localIcon) return localIcon;
  if (!server.icon) return '';
  return getFileUrl('servers', server.id, server.icon);
}

export function getServerBannerUrl(server: Server | null | undefined): string {
  if (!server) return '';
  const localBanner = localStorage.getItem(`server_banner_${server.id}`);
  if (localBanner) return localBanner;
  if (!server.banner) return '';
  return getFileUrl('servers', server.id, server.banner);
}

export function getServerMemberDisplayName(member: ServerMember | null | undefined, user: User | null | undefined, serverId?: string): string {
  const uId = user?.id || member?.user || member?.id;
  const sId = serverId || (serverId === null ? undefined : member?.server);
  const isSelf = typeof localStorage !== 'undefined' && uId && (pbService.getCurrentUser()?.id === uId);

  if (serverId && sId && uId && isSelf) {
    const local = localStorage.getItem(`server_name_${sId}_${uId}`);
    if (local && local.trim()) return local.trim();
  }
  if (serverId && member?.member_name && member.member_name.trim()) return member.member_name.trim();
  if (serverId && member?.nickname && member.nickname.trim()) return member.nickname.trim();
  if (user) return user.display_name || user.username;
  if (member?.member_name && member.member_name.trim()) return member.member_name.trim();
  if (member?.nickname && member.nickname.trim()) return member.nickname.trim();
  return 'User';
}

export function getServerMemberAvatarUrl(member: ServerMember | null | undefined, user: User | null | undefined, serverId?: string): string {
  const uId = user?.id || member?.user || member?.id;
  const sId = serverId || member?.server;
  const isSelf = typeof localStorage !== 'undefined' && uId && (pbService.getCurrentUser()?.id === uId);

  if (sId && uId && isSelf) {
    const local = localStorage.getItem(`server_avatar_${sId}_${uId}`);
    if (local && local !== 'REMOVE') return local;
    if (local === 'REMOVE') {
      if (user?.avatar && user.avatar !== 'REMOVE') {
        if (user.avatar.startsWith('data:') || user.avatar.startsWith('blob:') || user.avatar.startsWith('http')) {
          return user.avatar;
        }
        return `${pbService.getServerUrl()}/api/files/users/${user.id}/${user.avatar}`;
      }
      return '';
    }
  }
  if (member?.server_avatar && member.server_avatar !== 'REMOVE') {
    if (member.server_avatar.startsWith('data:') || member.server_avatar.startsWith('blob:') || member.server_avatar.startsWith('http')) {
      return member.server_avatar;
    }
    return `${pbService.getServerUrl()}/api/files/server_members/${member.id}/${member.server_avatar}`;
  }
  if (user?.avatar && user.avatar !== 'REMOVE') {
    if (user.avatar.startsWith('data:') || user.avatar.startsWith('blob:') || user.avatar.startsWith('http')) {
      return user.avatar;
    }
    return `${pbService.getServerUrl()}/api/files/users/${user.id}/${user.avatar}`;
  }
  return '';
}

export function getServerMemberBannerUrl(member: ServerMember | null | undefined, user: User | null | undefined, serverId?: string): string {
  const uId = user?.id || member?.user || member?.id;
  const sId = serverId || member?.server;
  const isSelf = typeof localStorage !== 'undefined' && uId && (pbService.getCurrentUser()?.id === uId);

  if (sId && uId && isSelf) {
    const local = localStorage.getItem(`server_banner_${sId}_${uId}`);
    if (local && local !== 'REMOVE') return local;
    if (local === 'REMOVE') {
      if (user?.banner && user.banner !== 'REMOVE') {
        if (user.banner.startsWith('data:') || user.banner.startsWith('blob:') || user.banner.startsWith('http')) {
          return user.banner;
        }
        return `${pbService.getServerUrl()}/api/files/users/${user.id}/${user.banner}`;
      }
      return '';
    }
  }
  if (member?.server_banner && member.server_banner !== 'REMOVE') {
    if (member.server_banner.startsWith('data:') || member.server_banner.startsWith('blob:') || member.server_banner.startsWith('http')) {
      return member.server_banner;
    }
    return `${pbService.getServerUrl()}/api/files/server_members/${member.id}/${member.server_banner}`;
  }
  if (user?.banner && user.banner !== 'REMOVE') {
    if (user.banner.startsWith('data:') || user.banner.startsWith('blob:') || user.banner.startsWith('http')) {
      return user.banner;
    }
    return `${pbService.getServerUrl()}/api/files/users/${user.id}/${user.banner}`;
  }
  return '';
}

export function getServerMemberProfileSettings(member: ServerMember | null | undefined, serverId?: string, userId?: string): { cardColor?: string; cardColor2?: string; avatarFrameColor?: string; bio?: string } {
  let settings: any = {};
  if (member?.server_profile_settings) {
    if (typeof member.server_profile_settings === 'string') {
      try { settings = JSON.parse(member.server_profile_settings); } catch {}
    } else if (typeof member.server_profile_settings === 'object') {
      settings = member.server_profile_settings;
    }
  }

  const sId = serverId || member?.server;
  const uId = userId || member?.user || member?.id;
  const isSelf = typeof localStorage !== 'undefined' && uId && (pbService.getCurrentUser()?.id === uId);

  if (sId && uId && isSelf) {
    try {
      const localStr = localStorage.getItem(`server_profile_settings_${sId}_${uId}`);
      if (localStr) {
        settings = { ...settings, ...JSON.parse(localStr) };
      }
    } catch {}
  }
  return settings || {};
}

export interface EffectiveProfile {
  displayName: string;
  avatarUrl: string;
  bannerUrl: string;
  bio: string;
  cardColor1: string;
  cardColor2: string;
  avatarFrameColor: string;
  serverMemberRecord: ServerMember | null;
  hasCustomServerProfile: boolean;
}

export function getEffectiveProfile(
  user: User | null | undefined,
  serverId?: string | null,
  overrideMember?: ServerMember | null
): EffectiveProfile {
  if (!user) {
    return {
      displayName: 'User',
      avatarUrl: '',
      bannerUrl: '',
      bio: '',
      cardColor1: 'var(--accent-color)',
      cardColor2: 'var(--accent-color)',
      avatarFrameColor: 'var(--accent-color)',
      serverMemberRecord: null,
      hasCustomServerProfile: false,
    };
  }

  let member: ServerMember | null = serverId ? (overrideMember || null) : null;
  if (!member && serverId) {
    member = pbService.getCachedServerMember(serverId, user.id);
  }

  let userSettings: any = user.settings;
  if (typeof userSettings === 'string') {
    try { userSettings = JSON.parse(userSettings); } catch { userSettings = {}; }
  }

  // If user is currently logged in, check local settings cache as well
  const isCurrentAuthUser = typeof localStorage !== 'undefined' && (pbService.getCurrentUser()?.id === user.id);
  const localCache = isCurrentAuthUser ? (() => {
    try {
      const raw = localStorage.getItem('sirver_user_settings_cache_v2');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  })() : null;

  const globalColor1 =
    userSettings?.appearance?.cardColor ||
    userSettings?.appearance?.cardColor1 ||
    localCache?.appearance?.cardColor ||
    localCache?.appearance?.cardColor1 ||
    userSettings?.cardColor ||
    userSettings?.cardColor1 ||
    userSettings?.card_color ||
    userSettings?.color1 ||
    user.settings?.cardColor ||
    user.settings?.cardColor1 ||
    (user as any).cardColor ||
    (user as any).cardColor1 ||
    (user as any).card_color ||
    (user as any).color1 ||
    (user as any).color_1 ||
    (isCurrentAuthUser ? localStorage.getItem('user_card_color1') : null) ||
    'var(--accent-color)';

  const globalColor2 =
    userSettings?.appearance?.cardColor2 ||
    localCache?.appearance?.cardColor2 ||
    userSettings?.cardColor2 ||
    userSettings?.card_color2 ||
    userSettings?.color2 ||
    user.settings?.cardColor2 ||
    (user as any).cardColor2 ||
    (user as any).card_color2 ||
    (user as any).color2 ||
    (user as any).color_2 ||
    (isCurrentAuthUser ? localStorage.getItem('user_card_color2') : null) ||
    globalColor1;

  const globalFrameColor =
    userSettings?.appearance?.avatarFrameColor ||
    localCache?.appearance?.avatarFrameColor ||
    userSettings?.avatarFrameColor ||
    userSettings?.avatar_frame_color ||
    userSettings?.frameColor ||
    user.settings?.avatarFrameColor ||
    (user as any).avatarFrameColor ||
    (user as any).avatar_frame_color ||
    (user as any).frameColor ||
    (isCurrentAuthUser ? localStorage.getItem('user_frame_color') : null) ||
    globalColor1;

  const displayName = getServerMemberDisplayName(member, user, serverId || undefined);
  const avatarUrl = getServerMemberAvatarUrl(member, user, serverId || undefined);
  const bannerUrl = getServerMemberBannerUrl(member, user, serverId || undefined);

  const serverSettings = getServerMemberProfileSettings(member, serverId || undefined, user.id);
  const serverColor1 = serverSettings.cardColor || (serverId && isCurrentAuthUser ? localStorage.getItem(`server_color1_${serverId}_${user.id}`) : null);
  const serverColor2 = serverSettings.cardColor2 || (serverId && isCurrentAuthUser ? localStorage.getItem(`server_color2_${serverId}_${user.id}`) : null);
  const serverFrameColor = serverSettings.avatarFrameColor || (serverId && isCurrentAuthUser ? localStorage.getItem(`server_frame_color_${serverId}_${user.id}`) : null);
  const serverBio = serverSettings.bio || (serverId && isCurrentAuthUser ? localStorage.getItem(`server_bio_${serverId}_${user.id}`) : null);

  const cardColor1 = (serverId && (serverColor1 || serverSettings.cardColor)) ? (serverColor1 || globalColor1) : globalColor1;
  const cardColor2 = (serverId && (serverColor2 || serverSettings.cardColor2)) ? (serverColor2 || globalColor2) : globalColor2;
  const avatarFrameColor = (serverId && (serverFrameColor || serverSettings.avatarFrameColor)) ? (serverFrameColor || globalFrameColor) : globalFrameColor;
  const bio = (serverId && serverBio !== null && serverBio !== undefined) ? serverBio : (user.bio || '');

  const hasCustomServerProfile = Boolean(
    serverId && (
      member?.member_name ||
      (member?.server_avatar && member.server_avatar !== 'REMOVE') ||
      (member?.server_banner && member.server_banner !== 'REMOVE') ||
      serverSettings?.bio ||
      (isCurrentAuthUser && (
        localStorage.getItem(`server_name_${serverId}_${user.id}`) ||
        localStorage.getItem(`server_avatar_${serverId}_${user.id}`) ||
        localStorage.getItem(`server_banner_${serverId}_${user.id}`) ||
        localStorage.getItem(`server_color1_${serverId}_${user.id}`) ||
        localStorage.getItem(`server_color2_${serverId}_${user.id}`) ||
        localStorage.getItem(`server_frame_color_${serverId}_${user.id}`) ||
        localStorage.getItem(`server_bio_${serverId}_${user.id}`)
      ))
    )
  );

  return {
    displayName,
    avatarUrl,
    bannerUrl,
    bio,
    cardColor1,
    cardColor2,
    avatarFrameColor,
    serverMemberRecord: member,
    hasCustomServerProfile,
  };
}

export interface PrimaryRole {
  id: string;
  name: string;
  color?: string;
  emoji?: string;
  priority: number;
}

export function getPrimaryServerRole(
  memberRoleRaw: string | string[] | any,
  serverRoles: ServerRole[],
  isOwner: boolean = false,
  userGlobalRole?: string,
  lang: 'en' | 'ar' = 'en'
): PrimaryRole {
  let roleTokens: string[] = [];
  if (Array.isArray(memberRoleRaw)) {
    roleTokens = memberRoleRaw.map((r: any) => typeof r === 'string' ? r : (r.id || r.name)).filter(Boolean);
  } else if (typeof memberRoleRaw === 'string' && memberRoleRaw.trim()) {
    roleTokens = memberRoleRaw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  roleTokens = roleTokens.filter((t) => t !== 'owner' && t !== 'Owner' && t !== 'المالك');

  // Check assigned roles for the highest role with a valid custom color
  if (roleTokens.length > 0 && serverRoles.length > 0) {
    for (let i = roleTokens.length - 1; i >= 0; i--) {
      const tok = roleTokens[i];
      const sRole = serverRoles.find((r) => r.id === tok || r.name === tok || r.name.toLowerCase() === tok.toLowerCase());
      const roleColor = sRole?.color || (sRole as any)?.role_settings?.color;
      if (sRole && roleColor && roleColor !== 'inherit' && roleColor !== 'transparent') {
        const sIdx = serverRoles.findIndex((r) => r.id === sRole.id);
        return {
          id: sRole.id,
          name: sRole.name,
          color: roleColor,
          emoji: sRole.emoji || (sRole as any)?.role_settings?.emoji || '🛡️',
          priority: sIdx >= 0 ? sIdx : 0
        };
      }
    }

    // Fallback if roles are assigned but none have a custom color
    for (let i = roleTokens.length - 1; i >= 0; i--) {
      const tok = roleTokens[i];
      const sRole = serverRoles.find((r) => r.id === tok || r.name === tok || r.name.toLowerCase() === tok.toLowerCase());
      if (sRole) {
        const sIdx = serverRoles.findIndex((r) => r.id === sRole.id);
        return {
          id: sRole.id,
          name: sRole.name,
          color: undefined,
          emoji: sRole.emoji || (sRole as any)?.role_settings?.emoji || '🛡️',
          priority: sIdx >= 0 ? sIdx : 0
        };
      }
    }
  }

  if (isOwner) {
    return {
      id: 'owner',
      name: lang === 'ar' ? 'المالك' : 'Owner',
      color: '#f59e0b',
      emoji: '👑',
      priority: -100
    };
  }

  if (roleTokens.length > 0) {
    const lastTok = roleTokens[roleTokens.length - 1];
    return {
      id: lastTok,
      name: lastTok,
      color: '#3b82f6',
      emoji: '🛡️',
      priority: 50
    };
  }

  if (userGlobalRole === 'admin') {
    return {
      id: 'admin',
      name: lang === 'ar' ? 'المسؤولين' : 'Admins',
      color: '#ef4444',
      emoji: '⭐',
      priority: 900
    };
  }

  return {
    id: 'members',
    name: lang === 'ar' ? 'الأعضاء' : 'Members',
    color: undefined,
    emoji: undefined,
    priority: 999
  };
}

class PocketBaseService {
  private pb: PocketBase;
  private serverUrl: string = APP_URLS.API_BASE_URL;
  private isDemo: boolean = false;
  private demoListeners: Set<(event: any) => void> = new Set();
  private pinnedCache: Map<string, string[]> = new Map();
  private serverMembersCache: Map<string, Map<string, ServerMember>> = new Map();
  private usersCache: User[] | null = null;
  private lastUsersFetch: number = 0;
  // Multiple panels can ask for the directory during login. Share one
  // request instead of opening a PocketBase connection for each caller.
  private usersFetchPromise: Promise<User[]> | null = null;
  private usersByIdsPromises: Map<string, Promise<User[]>> = new Map();
  private privateChatServerCache: Map<string, any> = new Map();
  private privateChatServerPromises: Map<string, Promise<any>> = new Map();
  private dmMessagesCache: Map<string, Message[]> = new Map();
  // Realtime attachment records arrive separately from their parent message.
  // Keep a small record cache so an attachment can be merged locally without
  // issuing a second getOne() request for every upload.
  private messageRecordCache: Map<string, Message> = new Map();
  private messageRecordCachedAt: Map<string, number> = new Map();
  private messageReadPromises: Map<string, Promise<Message>> = new Map();
  private serverChannelsCache: Map<string, Channel[]> = new Map();
  private dmChannelsCache: Map<string, Channel[]> = new Map();
  private channelMetaCache: Map<string, { record: any; timestamp: number }> = new Map();
  private serverOwnerCache: Map<string, { owner: string; timestamp: number }> = new Map();
  private memberRoleCache: Map<string, { roles: string[]; timestamp: number }> = new Map();
  private serverRolesSnapshotCache: Map<string, { items: ServerRole[]; timestamp: number }> = new Map();
  private serverRolesPromises: Map<string, Promise<ServerRole[]>> = new Map();
  private serverMembersSnapshotCache: Map<string, { items: ServerMember[]; timestamp: number }> = new Map();
  private serverMembersPromises: Map<string, Promise<ServerMember[]>> = new Map();
  private activeReadDeadlineAborts: Map<string, (error: any) => void> = new Map();
  private loginCooldownUntil: number = 0;
  private messageRetryTimeout: any = null;
  private privateMessageRetryTimeout: any = null;
  private usersRetryTimeout: any = null;

  private clearRealtimeRetryTimeouts() {
    if (this.messageRetryTimeout) {
      clearTimeout(this.messageRetryTimeout);
      this.messageRetryTimeout = null;
    }
    if (this.privateMessageRetryTimeout) {
      clearTimeout(this.privateMessageRetryTimeout);
      this.privateMessageRetryTimeout = null;
    }
    if (this.usersRetryTimeout) {
      clearTimeout(this.usersRetryTimeout);
      this.usersRetryTimeout = null;
    }
  }

  getLoginCooldownRemaining(): number {
    const remaining = this.loginCooldownUntil - Date.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  clearLoginCooldown(): void {
    this.loginCooldownUntil = 0;
  }

  /**
   * PocketBase's fetch does not impose a short deadline by default. Reads on
   * the critical startup/chat path therefore need an explicit bound so a
   * sleeping VPS or dead tunnel cannot leave the UI spinning indefinitely.
   * The request key is cancelled when possible; the race also settles even
   * when an older SDK ignores cancellation.
   * Default timeout is 15000ms (matching backendAvailability client), giving
   * adequate headroom for high latency VPS/Cloudflare tunnels while avoiding
   * indefinite hanging.
   */
  private withReadDeadline<T>(operation: () => Promise<T>, requestKey?: string, timeoutMs = 15000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (requestKey) {
          this.activeReadDeadlineAborts.delete(requestKey);
        }
      };

      if (requestKey) {
        this.activeReadDeadlineAborts.set(requestKey, (cancelErr) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          try { (this.pb as any).cancelRequest?.(requestKey); } catch {}
          reject(cancelErr);
        });
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        if (requestKey) {
          try { (this.pb as any).cancelRequest?.(requestKey); } catch {}
        }
        const timeout = new Error(`Request timed out after ${timeoutMs}ms`) as Error & { status?: number; code?: string };
        timeout.status = 408;
        timeout.code = 'TIMEOUT';
        reject(timeout);
      }, Math.max(250, timeoutMs));

      Promise.resolve().then(operation).then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(value);
      }).catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(error);
      });
    });
  }

  private cacheMessageRecord(message: Message | null | undefined): void {
    if (!message?.id) return;
    this.messageRecordCache.set(message.id, message);
    this.messageRecordCachedAt.set(message.id, Date.now());
    // Realtime is long-lived; bound this auxiliary cache independently from
    // the conversation history caches so it cannot grow without limit.
    if (this.messageRecordCache.size > 1200) {
      const oldestKey = this.messageRecordCache.keys().next().value;
      if (oldestKey) {
        this.messageRecordCache.delete(oldestKey);
        this.messageRecordCachedAt.delete(oldestKey);
      }
    }
  }

  getCachedPrivateChatServer(recipientId: string): any {
    if (!recipientId) return null;
    const inMem = this.privateChatServerCache.get(recipientId);
    if (inMem) return inMem;
    const currentId = this.pb.authStore.model?.id;
    if (currentId) {
      try {
        const raw = localStorage.getItem(`cached_pcs_${currentId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            const match = parsed.find((s: any) => {
              const users = s.users || [s.user1, s.user2].filter(Boolean);
              return users.includes(recipientId) || s.id === recipientId;
            });
            if (match) {
              this.privateChatServerCache.set(recipientId, match);
              this.privateChatServerCache.set(match.id, match);
              return match;
            }
          }
        }
      } catch (e) {}
    }
    return null;
  }

  setCachedPrivateChatServer(recipientIdOrServerId: string, server: any): void {
    if (!recipientIdOrServerId || !server) return;
    this.privateChatServerCache.set(recipientIdOrServerId, server);
    if (server.id) this.privateChatServerCache.set(server.id, server);
    const users = server.users || [server.user1, server.user2].filter(Boolean);
    users.forEach((u: string) => {
      if (u) this.privateChatServerCache.set(u, server);
    });
  }

  getCachedChannels(serverId: string): Channel[] {
    if (!serverId) return [];
    const inMem = this.serverChannelsCache.get(serverId);
    if (inMem && inMem.length > 0) return inMem;

    try {
      const raw = localStorage.getItem(`cached_channels_${serverId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.serverChannelsCache.set(serverId, parsed);
          return parsed;
        }
      }
    } catch (e) {}
    return [];
  }

  setCachedChannels(serverId: string, channels: Channel[]): void {
    if (!serverId || !Array.isArray(channels)) return;
    this.serverChannelsCache.set(serverId, channels);
    channels.forEach((c) => {
      if (c && c.id) {
        this.channelMetaCache.set(c.id, { record: c, timestamp: Date.now() });
      }
    });
    try {
      localStorage.setItem(`cached_channels_${serverId}`, JSON.stringify(channels));
    } catch (e) {}
  }

  getCachedDmChannels(userId: string): Channel[] {
    if (!userId) return [];
    const inMem = this.dmChannelsCache.get(userId);
    if (inMem && inMem.length > 0) return inMem;

    try {
      const raw = localStorage.getItem(`cached_dm_channels_${userId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.dmChannelsCache.set(userId, parsed);
          return parsed;
        }
      }
    } catch (e) {}
    return [];
  }

  setCachedDmChannels(userId: string, channels: Channel[]): void {
    if (!userId || !Array.isArray(channels)) return;
    this.dmChannelsCache.set(userId, channels);
    try {
      localStorage.setItem(`cached_dm_channels_${userId}`, JSON.stringify(channels));
    } catch (e) {}
  }

  getCachedServers(userId?: string): Server[] {
    const uId = userId || this.getCurrentUser()?.id;
    if (uId) {
      try {
        const raw = localStorage.getItem(`offline_servers_${uId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch (e) {}
    }
    return [];
  }

  getCachedUsers(): User[] {
    if (this.usersCache && this.usersCache.length > 0) {
      return this.usersCache;
    }
    try {
      const raw = localStorage.getItem('cached_all_users');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.usersCache = parsed;
          return parsed;
        }
      }
    } catch (e) {}
    return [];
  }

  getCachedServerMembers(serverId: string): ServerMember[] {
    if (!serverId) return [];
    const sMap = this.serverMembersCache.get(serverId);
    if (sMap && sMap.size > 0) {
      return Array.from(sMap.values());
    }
    try {
      const raw = localStorage.getItem(`cached_server_members_${serverId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          if (!this.serverMembersCache.has(serverId)) {
            this.serverMembersCache.set(serverId, new Map());
          }
          const targetMap = this.serverMembersCache.get(serverId)!;
          parsed.forEach((m: ServerMember) => {
            const uId = m.user || (m as any).expand?.user?.id || m.id;
            if (uId) targetMap.set(uId, m);
          });
          return parsed;
        }
      }
    } catch (e) {}
    return [];
  }

  getCachedServerRoles(serverId: string): ServerRole[] {
    if (!serverId) return [];
    try {
      const stored = localStorage.getItem(`server_roles_${serverId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {}
    return [];
  }

  getCachedUser(userId: string): User | null {
    if (!userId) return null;
    if (this.usersCache) {
      const found = this.usersCache.find((u) => u.id === userId);
      if (found) return found;
    }
    return null;
  }

  getCachedServerMember(serverId: string, userId: string): ServerMember | null {
    if (!serverId || !userId) return null;

    const localIsMember = localStorage.getItem(`is_member_${serverId}_${userId}`);
    const localStatus = localStorage.getItem(`membership_status_${serverId}_${userId}`);
    const localLeftAt = localStorage.getItem(`left_at_${serverId}_${userId}`);

    const sMap = this.serverMembersCache.get(serverId);
    if (sMap && sMap.has(userId)) {
      const cached = sMap.get(userId)!;
      if (localStatus) cached.membership_status = localStatus as any;
      if (localIsMember === 'false') cached.is_member = false;
      if (localIsMember === 'true') cached.is_member = true;
      if (localLeftAt) cached.left_at = localLeftAt;
      return cached;
    }

    const name = localStorage.getItem(`server_name_${serverId}_${userId}`);
    const avatar = localStorage.getItem(`server_avatar_${serverId}_${userId}`);
    const banner = localStorage.getItem(`server_banner_${serverId}_${userId}`);
    const role = localStorage.getItem(`member_role_${serverId}_${userId}`);
    const settingsStr = localStorage.getItem(`server_profile_settings_${serverId}_${userId}`);

    if (name || avatar || banner || role || settingsStr || localStatus) {
      let isMember = localIsMember !== 'false' && localStatus !== 'left' && localStatus !== 'banned' && localStatus !== 'kicked';
      const syntheticMember: ServerMember = {
        id: `cached-${serverId}-${userId}`,
        server: serverId,
        user: userId,
        member_name: name || undefined,
        nickname: name || undefined,
        server_avatar: avatar || undefined,
        server_banner: banner || undefined,
        role: role || undefined,
        server_profile_settings: settingsStr || undefined,
        is_member: isMember,
        membership_status: (localStatus as any) || (isMember ? 'active' : 'left'),
        left_at: localLeftAt || null
      };
      if (!this.serverMembersCache.has(serverId)) {
        this.serverMembersCache.set(serverId, new Map());
      }
      this.serverMembersCache.get(serverId)!.set(userId, syntheticMember);
      return syntheticMember;
    }
    return null;
  }

  getFileUrl(record: { id: string; collectionId?: string; collectionName?: string }, filename: string): string {
    if (!filename) return '';
    if (filename.startsWith('http://') || filename.startsWith('https://') || filename.startsWith('blob:') || filename.startsWith('data:')) {
      return filename;
    }
    const collection = record.collectionName || record.collectionId || 'messages';
    return `${this.getServerUrl()}/api/files/${collection}/${record.id}/${filename}`;
  }

  async banMember(serverId: string, userId: string): Promise<boolean> {
    this.serverMembersSnapshotCache.delete(serverId);
    const leftAt = new Date().toISOString();
    localStorage.setItem(`is_member_${serverId}_${userId}`, 'false');
    localStorage.setItem(`membership_status_${serverId}_${userId}`, 'banned');
    localStorage.setItem(`left_at_${serverId}_${userId}`, leftAt);

    if (this.serverMembersCache.has(serverId)) {
      const cached = this.serverMembersCache.get(serverId)?.get(userId);
      if (cached) {
        cached.is_member = false;
        cached.banned = true;
        cached.left_at = leftAt;
        cached.membership_status = 'banned';
      }
    }

    if (this.isDemo) {
      window.dispatchEvent(new CustomEvent('server-member-updated', {
        detail: { serverId, userId, is_member: false, membership_status: 'banned' }
      }));
      return true;
    }

    try {
      const record = await this.pb.collection('server_members').getFirstListItem(
        `server="${serverId}" && user="${userId}"`
      );
      if (record) {
        await this.pb.collection('server_members').update(record.id, {
          is_member: false,
          banned: true,
          left_at: leftAt,
          membership_status: 'banned'
        });
      }
    } catch (e) {
      console.warn('Failed to ban server member:', e);
    }

    window.dispatchEvent(new CustomEvent('server-member-updated', {
      detail: { serverId, userId, is_member: false, membership_status: 'banned' }
    }));
    return true;
  }

  private initPbInstance(pbInstance: PocketBase) {
    pbInstance.autoCancellation(false);
    pbInstance.beforeSend = (url, options) => {
      if (url.includes('/api/files/')) {
        options.headers = {
          ...options.headers,
          'Cache-Control': 'public, max-age=31536000, immutable',
        };
      } else {
        options.headers = {
          ...options.headers,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        };
      }
      return { url, options };
    };

    pbInstance.afterSend = (response, data) => {
      const isAuthMismatch =
        response.status === 400 &&
        typeof data?.message === 'string' &&
        data.message.includes("authorization don't match");

      if (isAuthMismatch) {
        try {
          pbInstance.realtime.unsubscribe().catch(() => {});
        } catch (e) {}
        try {
          pbInstance.cancelAllRequests();
        } catch (e) {}
        if (this.pb.authStore.isValid && this.pb.authStore.token) {
          setTimeout(() => {
            this.resubscribeAllRealtime();
          }, 100);
        }
      }
      return data;
    };

    pbInstance.authStore.onChange(() => {
      this.clearRealtimeRetryTimeouts();
      try {
        pbInstance.cancelAllRequests();
      } catch (e) {}
      try {
        pbInstance.realtime.unsubscribe().catch(() => {});
      } catch (e) {}
      // Automatically re-establish subscriptions only when we have valid credentials
      if (pbInstance.authStore.isValid && pbInstance.authStore.token) {
        setTimeout(() => {
          this.resubscribeAllRealtime();
        }, 100);
      }
    });
  }

  public resubscribeAllRealtime() {
    this.clearRealtimeRetryTimeouts();
    this.messagesSubscribed = false;
    this.attachmentsSubscribed = false;
    this.privateMessagesSubscribed = false;
    this.privateAttachmentsSubscribed = false;
    this.usersSubscribed = false;

    if (!this.pb.authStore.isValid || !this.pb.authStore.token) {
      return;
    }

    if (this.messageListeners.size > 0) {
      this.setupMessagesSubscription();
    }
    if (this.privateMessageListeners.size > 0) {
      this.setupPrivateMessagesSubscription();
    }
    if (this.userListeners.size > 0) {
      this.setupUsersSubscription();
    }
  }

  constructor() {
    const savedUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('sirver_pb_url') : null;
    if (savedUrl && savedUrl !== ENDPOINTS.MAIN_DOMAIN) {
      this.serverUrl = savedUrl;
    } else {
      this.serverUrl = ENDPOINTS.API_BASE_URL;
      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem('sirver_pb_url', ENDPOINTS.API_BASE_URL); } catch {}
      }
    }
    this.pb = new PocketBase(this.serverUrl);
    this.initPbInstance(this.pb);
  }

  setServerUrl(url: string) {
    this.serverUrl = url;
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem('sirver_pb_url', url); } catch {}
    }
    this.pb = new PocketBase(url);
    this.initPbInstance(this.pb);
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  getPbInstance(): PocketBase {
    return this.pb;
  }

  /** Cancel an obsolete history read when the user changes conversations. */
  cancelMessageHistory(channelId: string, kind: 'channel' | 'dm' = 'channel'): void {
    if (!channelId) return;
    const rawId = channelId.startsWith('dm-server-') ? channelId.slice('dm-server-'.length) : channelId;
    const prefixes = [
      `history:${kind}:${channelId}`,
      `history:${kind}:${rawId}`,
      `history:channel:${channelId}`,
      `history:dm:${channelId}`,
      `history:dm:${rawId}`,
      `pcs:${rawId}`,
      `pcs:${channelId}`,
    ];

    const abortError = Object.assign(new Error('The request was autocancelled.'), {
      name: 'AbortError',
      isAbort: true,
      status: 0,
    });

    for (const [key, abortFn] of Array.from(this.activeReadDeadlineAborts.entries())) {
      if (prefixes.some((p) => key === p || key.startsWith(`${p}:`))) {
        try { abortFn(abortError); } catch {}
        try { (this.pb as any).cancelRequest?.(key); } catch {}
        this.activeReadDeadlineAborts.delete(key);
      }
    }

    prefixes.forEach((key) => {
      try {
        (this.pb as any).cancelRequest?.(key);
      } catch {}
    });
  }

  getIsDemo(): boolean {
    return this.isDemo;
  }

  updatePinnedCache(channelId: string, pinnedIds: string[]): void {
    this.pinnedCache.set(channelId, pinnedIds);
    try {
      localStorage.setItem(`pinned_msgs_${channelId}`, JSON.stringify(pinnedIds));
    } catch (e) {}
  }

  isDemoMode(): boolean {
    return false;
  }

  setDemoMode(val: boolean) {
    this.isDemo = false;
  }

  // --- AUTH SERVICES ---

  async login(identity: string, password: string): Promise<User> {
    if (this.isDemo) {
      const mockUser: User = {
        id: 'demo-user-id',
        username: identity.split('@')[0],
        email: identity.includes('@') ? identity : `${identity}@example.com`,
        role: 'admin',
        display_name: identity.charAt(0).toUpperCase() + identity.slice(1),
        status: 'online',
        bio: 'Just another Sirver enthusiast!',
        language: 'en'
      };
      localStorage.setItem('demo_user', JSON.stringify(mockUser));
      return mockUser;
    }

    const cleanIdentity = (identity || '').trim();
    const cleanPassword = password || '';
    const isEmail = cleanIdentity.includes('@');

    const cooldownRemaining = this.getLoginCooldownRemaining();
    if (cooldownRemaining > 0) {
      const cooldownErr = new Error(`Rate limit active. Please wait ${cooldownRemaining}s before trying again.`);
      (cooldownErr as any).status = 429;
      (cooldownErr as any).cooldownSeconds = cooldownRemaining;
      throw cooldownErr;
    }

    try {
      const authData = await this.pb.collection('users').authWithPassword(cleanIdentity, cleanPassword);
      this.clearLoginCooldown();
      return authData.record as any as User;
    } catch (err: any) {
      const isRateLimit =
        err?.status === 429 ||
        String(err?.message || '').toLowerCase().includes('too many') ||
        String(err?.message || '').toLowerCase().includes('quota') ||
        String(err?.data?.message || '').toLowerCase().includes('too many');

      if (isRateLimit) {
        // Enforce 30-second client-side cooldown so repeated clicks don't reset server ban window
        this.loginCooldownUntil = Date.now() + 30000;
        console.warn('PocketBase login rate limit hit. 30s cooldown activated.');
        throw err;
      }

      // If user entered mixed/uppercase username and login failed, attempt lowercased username as fallback
      if (!isEmail && cleanIdentity.toLowerCase() !== cleanIdentity) {
        try {
          const authData = await this.pb.collection('users').authWithPassword(cleanIdentity.toLowerCase(), cleanPassword);
          this.clearLoginCooldown();
          return authData.record as any as User;
        } catch (retryErr) {
          // Fall through to original error handling
        }
      }
      console.warn('PocketBase login failed:', err);
      throw err;
    }
  }

  async refreshAuth(): Promise<User | null> {
    if (this.isDemo) {
      return this.getCurrentUser();
    }
    if (!this.pb.authStore.isValid || !this.pb.authStore.token) {
      return null;
    }
    try {
      const authData = await this.pb.collection('users').authRefresh();
      return authData.record as any as User;
    } catch (err: any) {
      const isAuthError =
        err?.status === 401 ||
        err?.status === 403 ||
        err?.status === 400 ||
        err?.status === 404 ||
        String(err?.message || '').toLowerCase().includes('authenticate') ||
        String(err?.message || '').toLowerCase().includes('something went wrong');

      if (isAuthError) {
        this.logout();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('auth-session-expired'));
        }
      }
      return null;
    }
  }

  async signup(formData: FormData): Promise<User> {
    if (this.isDemo) {
      const username = formData.get('username') as string;
      const email = formData.get('email') as string;
      const displayName = formData.get('display_name') as string;
      const mockUser: User = {
        id: 'demo-user-id-' + Math.random().toString(36).substr(2, 9),
        username,
        email,
        role: 'user',
        display_name: displayName || username,
        status: 'online',
        bio: 'Hello, I just registered!',
        language: 'en'
      };
      localStorage.setItem('demo_user', JSON.stringify(mockUser));
      return mockUser;
    }

    try {
      const userRecord = await this.pb.collection('users').create(formData);
      return userRecord as any as User;
    } catch (err) {
      console.error('PocketBase register failed:', err);
      throw err;
    }
  }

  logout() {
    if (this.isDemo) {
      localStorage.removeItem('demo_user');
      return;
    }
    this.clearRealtimeRetryTimeouts();
    this.messagesSubscribed = false;
    this.attachmentsSubscribed = false;
    this.privateMessagesSubscribed = false;
    this.privateAttachmentsSubscribed = false;
    this.usersSubscribed = false;
    this.messageListeners.clear();
    this.privateMessageListeners.clear();
    this.userListeners.clear();

    try {
      this.pb.cancelAllRequests();
    } catch (e) {}
    try {
      this.pb.realtime.unsubscribe().catch(() => {});
    } catch (e) {}
    this.pb.authStore.clear();
  }

  async requestPasswordReset(email: string): Promise<boolean> {
    if (this.isDemo) {
      return true;
    }
    try {
      await this.pb.collection('users').requestPasswordReset(email.trim());
      return true;
    } catch (err) {
      console.warn('PocketBase requestPasswordReset error:', err);
      // Always return true to avoid revealing registered email existence
      return true;
    }
  }

  async confirmPasswordReset(token: string, password: string, passwordConfirm: string): Promise<boolean> {
    if (this.isDemo) {
      if (password !== passwordConfirm) {
        throw new Error('Passwords do not match');
      }
      return true;
    }
    await this.pb.collection('users').confirmPasswordReset(token, password, passwordConfirm);
    return true;
  }

  async updateUser(userId: string, data: any): Promise<User> {
    if (this.isDemo) {
      const current = this.getCurrentUser();
      const updated = { ...current, ...data };
      localStorage.setItem('demo_user', JSON.stringify(updated));
      return updated as User;
    }
    const record = await this.pb.collection('users').update(userId, data);
    return record as any as User;
  }

  async blockUser(targetUserId: string): Promise<User> {
    const currentUser = this.getCurrentUser();
    if (!currentUser) throw new Error('Not logged in');
    if (currentUser.id === targetUserId) return currentUser;

    const currentBlocked = Array.isArray(currentUser.blocked_users) ? currentUser.blocked_users : [];
    if (currentBlocked.includes(targetUserId)) {
      return currentUser;
    }

    const updatedBlocked = [...currentBlocked, targetUserId];
    const updatedUser = await this.updateUser(currentUser.id, {
      blocked_users: updatedBlocked,
    });
    if (this.pb.authStore.model) {
      (this.pb.authStore.model as any).blocked_users = updatedBlocked;
    }
    return updatedUser;
  }

  async unblockUser(targetUserId: string): Promise<User> {
    const currentUser = this.getCurrentUser();
    if (!currentUser) throw new Error('Not logged in');

    const currentBlocked = Array.isArray(currentUser.blocked_users) ? currentUser.blocked_users : [];
    if (!currentBlocked.includes(targetUserId)) {
      return currentUser;
    }

    const updatedBlocked = currentBlocked.filter((id) => id !== targetUserId);
    const updatedUser = await this.updateUser(currentUser.id, {
      blocked_users: updatedBlocked,
    });
    if (this.pb.authStore.model) {
      (this.pb.authStore.model as any).blocked_users = updatedBlocked;
    }
    return updatedUser;
  }

  async createReport(params: {
    reportedUserId: string;
    reason: string;
    details?: string;
    serverId?: string;
    channelId?: string;
    messageId?: string;
    targetType?: 'admin' | 'owner';
  }): Promise<any> {
    const currentUser = this.getCurrentUser();
    if (!currentUser) throw new Error('Not logged in');

    const reportData = {
      reporter: currentUser.id,
      reporter_name: currentUser.display_name || currentUser.username,
      reported_user: params.reportedUserId,
      reason: params.reason,
      details: params.details || '',
      server: params.serverId || '',
      channel: params.channelId || '',
      message: params.messageId || '',
      target_type: params.targetType || 'admin',
      status: 'pending',
      created: new Date().toISOString(),
    };

    try {
      return await this.pb.collection('reports').create(reportData);
    } catch (err) {
      console.warn('Failed to save report to server collection, storing locally:', err);
      const localReports = JSON.parse(localStorage.getItem('reports_fallback') || '[]');
      localReports.push({ id: `report_${Date.now()}`, ...reportData });
      localStorage.setItem('reports_fallback', JSON.stringify(localReports));
      return reportData;
    }
  }

  getCurrentUser(): User | null {
    if (this.isDemo) {
      const saved = localStorage.getItem('demo_user');
      return saved ? JSON.parse(saved) : null;
    }
    if (this.pb.authStore.isValid && this.pb.authStore.model) {
      return this.pb.authStore.model as any as User;
    }
    return null;
  }

  // --- FETCH CHANNELS & SERVERS ---

  async fetchServers(): Promise<Server[]> {
    if (this.isDemo) {
      return [
        { id: 'demo-server-1', name: 'General Lounge', description: 'Hangout and chat with friends!' },
        { id: 'demo-server-2', name: 'Developers Area', description: 'Tech discussions, bots, and programming.' },
        { id: 'demo-server-3', name: 'Voice & Gaming', description: 'Active match streams and multiplayer queues.' }
      ];
    }

    const currentUserId = this.pb.authStore.model?.id;
    if (!currentUserId) return [];

    const isDmServer = (s: any) =>
      s.name === 'Direct Messages' ||
      s.name === 'الرسائل الخاصة' ||
      s.description === 'Private Direct Messages' ||
      s.type === 'dm';

    try {
      // 1. FAST-PATH: Query users collection with expanded in_servers relation
      try {
        const userRec = await this.withReadDeadline(
          () => this.pb.collection('users').getOne(currentUserId, {
            expand: 'in_servers',
            requestKey: 'bootstrap:servers:user',
          }),
          'bootstrap:servers:user',
        );
        if (userRec && userRec.expand && Array.isArray(userRec.expand.in_servers) && userRec.expand.in_servers.length > 0) {
          const directInServers = (userRec.expand.in_servers as Server[]).filter((s) => !isDmServer(s));
          if (directInServers.length > 0) {
            directInServers.forEach((s) => {
              const { cleanText, cooldown } = extractCooldown(s.description);
              s.description = cleanText;
              s.cooldown = cooldown || this.getLocalServerCooldown(s.id);
            });
            return directInServers;
          }
        }
      } catch (fastErr: any) {
        if (!isSchemaCompatibilityError(fastErr)) throw fastErr;
        // The legacy users.in_servers expansion is unavailable; continue to
        // the indexed server_members query only for this confirmed mismatch.
      }

      let records: any[] = [];
      try {
        records = await this.withReadDeadline(
          () => this.pb.collection('server_members').getFullList({
            filter: `user = "${currentUserId}"`,
            expand: 'server',
            requestKey: 'bootstrap:servers:members',
          }),
          'bootstrap:servers:members',
        );
      } catch (innerErr: any) {
        if (!isSchemaCompatibilityError(innerErr)) throw innerErr;
        // Fallback: fetch directly from 'servers' collection
        let directServers: any[] = [];
        try {
          directServers = await this.withReadDeadline(
            () => this.pb.collection('servers').getFullList({
              sort: '-created',
              requestKey: 'bootstrap:servers:direct',
            }),
            'bootstrap:servers:direct',
          );
        } catch (sortErr: any) {
          if (isSchemaCompatibilityError(sortErr)) {
            directServers = await this.withReadDeadline(
              () => this.pb.collection('servers').getFullList({
                requestKey: 'bootstrap:servers:direct:unsorted',
              }),
              'bootstrap:servers:direct:unsorted',
            );
          } else {
            throw sortErr;
          }
        }
        const list = directServers as any as Server[];
        list.forEach((s) => {
          const { cleanText, cooldown } = extractCooldown(s.description);
          s.description = cleanText;
          s.cooldown = cooldown || this.getLocalServerCooldown(s.id);
        });
        return list.filter((s) => !isDmServer(s));
      }

      const servers = records
        .filter((r) => r.expand && r.expand.server && r.is_member !== false && r.membership_status !== 'left' && r.membership_status !== 'banned')
        .map((r) => r.expand!.server as any as Server)
        .filter((s) => !isDmServer(s));
      
      // If user has no servers joined on this real instance, join a default one or fetch available servers
      if (servers.length === 0) {
        // Fetch all public servers
        try {
          const publicServers = await this.withReadDeadline(
            () => this.pb.collection('servers').getList(1, 10, { requestKey: 'bootstrap:servers:public' }),
            'bootstrap:servers:public',
          );
          const validPublicServers = publicServers.items.filter((s) => !isDmServer(s));
          if (validPublicServers.length > 0) {
            // Join first public server
            const firstServer = validPublicServers[0];
            try {
              await this.joinServer(firstServer.id);
            } catch (joinErr) {
              // Silently ignore auto-join failures
            }
            const list = validPublicServers as any as Server[];
            list.forEach((s) => {
              const { cleanText, cooldown } = extractCooldown(s.description);
              s.description = cleanText;
              s.cooldown = cooldown || this.getLocalServerCooldown(s.id);
            });
            return list;
          }
        } catch (e) {
          // Public servers query fallback silently
        }
      }
      servers.forEach((s) => {
        const { cleanText, cooldown } = extractCooldown(s.description);
        s.description = cleanText;
        s.cooldown = cooldown || this.getLocalServerCooldown(s.id);
      });
      return servers.filter((s) => !isDmServer(s));
    } catch (err: any) {
      return [];
    }
  }

  async getServerById(id: string): Promise<Server> {
    if (this.isDemo) {
      return { id, name: 'Demo Server', description: '' };
    }
    const record = await this.pb.collection('servers').getOne(id);
    const server = record as any as Server;
    const { cleanText, cooldown } = extractCooldown(server.description);
    server.description = cleanText;
    server.cooldown = cooldown || this.getLocalServerCooldown(server.id);
    return server;
  }

  async getChannelById(id: string): Promise<Channel> {
    if (this.isDemo) {
      return { id, name: 'demo-channel', server: 'demo', type: 'text' };
    }
    const record = await this.pb.collection('channels').getOne(id);
    return record as any as Channel;
  }

  async joinServer(serverId: string): Promise<ServerMember> {
    this.serverMembersSnapshotCache.delete(serverId);
    if (this.isDemo) {
      return { id: 'mock-member-id', server: serverId, user: 'demo-user-id', is_member: true, membership_status: 'active' };
    }
    const currentUserId = this.pb.authStore.model?.id;
    if (!currentUserId) throw new Error('Not authenticated');

    localStorage.setItem(`is_member_${serverId}_${currentUserId}`, 'true');
    localStorage.setItem(`membership_status_${serverId}_${currentUserId}`, 'active');
    localStorage.removeItem(`left_at_${serverId}_${currentUserId}`);

    // Check if member record already exists (user left/kicked previously)
    try {
      const existing = await this.pb.collection('server_members').getFullList({
        filter: `server = "${serverId}" && user = "${currentUserId}"`
      });

      if (existing.length > 0) {
        const rec = existing[0];
        if (rec.membership_status === 'banned' || rec.banned) {
          throw new Error('You are banned from this server.');
        }

        const updated = await this.pb.collection('server_members').update(rec.id, {
          is_member: true,
          membership_status: 'active',
          left_at: null
        });

        if (this.serverMembersCache.has(serverId)) {
          const cached = this.serverMembersCache.get(serverId)?.get(currentUserId);
          if (cached) {
            cached.is_member = true;
            cached.membership_status = 'active';
            cached.left_at = null;
          }
        }

        window.dispatchEvent(new CustomEvent('server-member-updated', {
          detail: { serverId, userId: currentUserId, is_member: true, membership_status: 'active' }
        }));

        this.markInviteJoined(serverId, currentUserId).catch(() => {});

        return updated as any as ServerMember;
      }
    } catch (err: any) {
      if (err?.message?.includes('banned')) throw err;
      console.warn('Check existing member record failed, creating new record:', err);
    }

    // Resolve server's automatic/default role
    let defaultRoleId = localStorage.getItem(`default_role_${serverId}`);
    if (!defaultRoleId) {
      try {
        const rolesList = await this.pb.collection('server_roles').getFullList({
          filter: `server = "${serverId}" && is_default = true`
        }).catch(() => []);
        if (rolesList && rolesList.length > 0) {
          defaultRoleId = rolesList[0].id;
          localStorage.setItem(`default_role_${serverId}`, defaultRoleId);
        }
      } catch (err) {
        console.warn('Failed to query default server role:', err);
      }
    }

    const data: any = {
      user: currentUserId,
      server: serverId,
      joined_at: new Date().toISOString(),
      is_member: true,
      membership_status: 'active',
      left_at: null
    };
    if (defaultRoleId) {
      data.role = defaultRoleId;
      data.role_id = defaultRoleId;
    }
    const record = await this.pb.collection('server_members').create(data);
    
    if (currentUserId && defaultRoleId) {
      try {
        localStorage.setItem(`member_role_${serverId}_${currentUserId}`, defaultRoleId);
      } catch (e) {}
    }

    // Auto-mark invite as joined if waiting for this user
    if (currentUserId) {
      this.markInviteJoined(serverId, currentUserId).catch(() => {});
    }

    window.dispatchEvent(new CustomEvent('server-member-updated', {
      detail: { serverId, userId: currentUserId, is_member: true, membership_status: 'active' }
    }));

    // Sync in_servers on user record
    if (currentUserId) {
      try {
        const user = await this.pb.collection('users').getOne(currentUserId);
        const existingInServers: string[] = Array.isArray(user.in_servers) ? user.in_servers : [];
        if (!existingInServers.includes(serverId)) {
          this.pb.collection('users').update(currentUserId, {
            in_servers: [...existingInServers, serverId]
          }).catch(() => {});
        }
      } catch (e) {}
    }

    return record as any as ServerMember;
  }

  async leaveServer(serverId: string, userId: string): Promise<boolean> {
    const leftAt = new Date().toISOString();
    localStorage.setItem(`is_member_${serverId}_${userId}`, 'false');
    localStorage.setItem(`membership_status_${serverId}_${userId}`, 'left');
    localStorage.setItem(`left_at_${serverId}_${userId}`, leftAt);

    if (this.serverMembersCache.has(serverId)) {
      const cached = this.serverMembersCache.get(serverId)?.get(userId);
      if (cached) {
        cached.is_member = false;
        cached.left_at = leftAt;
        cached.membership_status = 'left';
      }
    }

    if (this.isDemo) {
      window.dispatchEvent(new CustomEvent('server-member-updated', {
        detail: { serverId, userId, is_member: false, membership_status: 'left' }
      }));
      return true;
    }

    try {
      const records = await this.pb.collection('server_members').getFullList({
        filter: `server = "${serverId}" && user = "${userId}"`
      });
      if (records.length > 0) {
        await this.pb.collection('server_members').update(records[0].id, {
          is_member: false,
          left_at: leftAt,
          membership_status: 'left'
        });
      } else {
        await this.pb.collection('server_members').create({
          server: serverId,
          user: userId,
          is_member: false,
          left_at: leftAt,
          membership_status: 'left'
        });
      }
    } catch (err) {
      console.warn('PocketBase leaveServer update failed, local fallback applied:', err);
    }

    // Remove serverId from user's in_servers
    if (userId) {
      try {
        const user = await this.pb.collection('users').getOne(userId);
        const existingInServers: string[] = Array.isArray(user.in_servers) ? user.in_servers : [];
        if (existingInServers.includes(serverId)) {
          this.pb.collection('users').update(userId, {
            in_servers: existingInServers.filter((id) => id !== serverId)
          }).catch(() => {});
        }
      } catch (e) {}
    }

    window.dispatchEvent(new CustomEvent('server-member-updated', {
      detail: { serverId, userId, is_member: false, membership_status: 'left' }
    }));
    return true;
  }

  async getServerMembers(serverId: string): Promise<{ id: string; user: User; is_member: boolean; role?: string }[]> {
    if (!serverId) return [];
    if (this.isDemo) {
      const all = await this.fetchAllUsers();
      return all.map((u) => ({
        id: `mem-${u.id}`,
        user: u,
        is_member: true
      }));
    }

    try {
      const requestKey = `members:server:${serverId}`;
      const records = await this.withReadDeadline(
        () => this.pb.collection('server_members').getFullList({
          filter: `server = "${serverId.replace(/"/g, '\\"')}"`,
          expand: 'user',
          requestKey,
        }),
        requestKey,
      );

      // The membership query already gives us the exact user IDs needed for
      // this server. Avoid downloading the entire user directory just to
      // render the member list.
      const unresolvedUserIds = records
        .map((rec) => rec.expand?.user?.id || rec.user)
        .filter((id: string | undefined): id is string => Boolean(id));
      const fetchedUsers = await this.fetchUsersByIds(unresolvedUserIds);
      const allUsersMap = new Map(fetchedUsers.map((u) => [u.id, u]));
      const result: { id: string; user: User; is_member: boolean; role?: string }[] = [];

      for (const rec of records) {
        if (rec.is_member === false || rec.membership_status === 'left') continue;
        const userId = rec.user || rec.expand?.user?.id;
        let u: User | undefined = rec.expand?.user;
        if (!u && userId) {
          u = allUsersMap.get(userId);
        }
        if (u) {
          result.push({
            id: rec.id,
            user: mergeUserRecord(u, {}),
            is_member: rec.is_member !== false,
            role: rec.role
          });
        }
      }

      return result;
    } catch (err) {
      console.warn('Failed to fetch server_members in pbService.getServerMembers:', err);
      // A membership read failure is not evidence that every directory user
      // belongs to this server.  The old fallback downloaded the entire users
      // collection (and could expose unrelated people) whenever the VPS or
      // tunnel was unavailable.  Keep any already-cached members visible and
      // let the caller retry after the backend recovers; only confirmed schema
      // incompatibilities should ever use a compatibility path.
      const cachedMembers = this.serverMembersCache.get(serverId);
      if (cachedMembers && cachedMembers.size > 0) {
        return Array.from(cachedMembers.values())
          .filter((member) => member.is_member !== false && member.membership_status !== 'left')
          .map((member) => ({
            id: member.id || `mem-${member.user}`,
            user: (member as any).expand?.user || (this.getCachedUsers().find((u) => u.id === member.user) as User),
            is_member: member.is_member !== false,
            role: member.role,
          }))
          .filter((member) => Boolean(member.user));
      }
      return [];
    }
  }

  async transferServerOwnership(serverId: string, newOwnerId: string): Promise<Server> {
    if (!serverId || !newOwnerId) {
      throw new Error('Server ID and new owner ID are required for ownership transfer');
    }

    if (this.isDemo) {
      const updated: Server = { id: serverId, name: 'Demo Server', owner: newOwnerId };
      window.dispatchEvent(new CustomEvent('server-updated', {
        detail: { serverId, owner: newOwnerId, server: updated }
      }));
      return updated;
    }

    const currentUserId = this.pb.authStore.model?.id;
    if (!currentUserId) {
      throw new Error('Not authenticated');
    }

    // Backend verification: Only current owner can transfer ownership
    const serverRecord = await this.pb.collection('servers').getOne(serverId);
    if (!serverRecord || serverRecord.owner !== currentUserId) {
      throw new Error('Unauthorized: Only the current server owner can transfer ownership.');
    }

    try {
      localStorage.setItem(`server_owner_${serverId}`, newOwnerId);
      localStorage.removeItem(`member_role_${serverId}_${currentUserId}`);
      const updated = await this.updateServer(serverId, { owner: newOwnerId });

      // Broadcast real-time ownership update events
      window.dispatchEvent(new CustomEvent('server-updated', {
        detail: { serverId, owner: newOwnerId, newOwnerId, server: updated }
      }));
      window.dispatchEvent(new CustomEvent('server-member-updated', {
        detail: { serverId, userId: newOwnerId, is_member: true, role: 'owner' }
      }));

      return updated;
    } catch (err) {
      console.error('Failed to transfer server ownership in pbService:', err);
      throw err;
    }
  }

  async createServer(name: string, description: string, iconFile?: File): Promise<Server> {
    if (this.isDemo) {
      return { id: 'demo-server-' + Math.random().toString(36).substr(2, 9), name, description };
    }

    const formData = new FormData();
    formData.append('name', name);
    formData.append('description', description);
    formData.append('owner', this.pb.authStore.model?.id || '');
    if (iconFile) {
      formData.append('icon', iconFile);
    }

    const serverRecord = await this.pb.collection('servers').create(formData);
    
    // Auto join creator as member
    await this.joinServer(serverRecord.id);

    // Create default text & voice channel
    await this.createChannel(serverRecord.id, 'general', 'text', 'Welcome channel!');
    await this.createChannel(serverRecord.id, 'Lobby Voice', 'voice');

    return serverRecord as any as Server;
  }

  async fetchChannels(serverId: string): Promise<Channel[]> {
    if (this.isDemo) {
      if (serverId === 'demo-server-1') {
        return [
          { id: 'demo-chan-1', name: 'general', server: serverId, type: 'text', topic: 'Hang out and stay friendly!' },
          { id: 'demo-chan-2', name: 'announcements', server: serverId, type: 'text', topic: 'Official server announcements.' },
          { id: 'demo-chan-3', name: 'Music & Vibes 🎵', server: serverId, type: 'voice' },
          { id: 'demo-chan-4', name: 'Gaming Lounge 🎮', server: serverId, type: 'voice' }
        ];
      } else if (serverId === 'demo-server-2') {
        return [
          { id: 'demo-chan-5', name: 'general-dev', server: serverId, type: 'text', topic: 'Coding talk and debugging.' },
          { id: 'demo-chan-6', name: 'showcase-projects', server: serverId, type: 'text', topic: 'Share screenshots of your work.' },
          { id: 'demo-chan-7', name: 'Standup Room', server: serverId, type: 'voice' }
        ];
      } else {
        return [
          { id: 'demo-chan-8', name: 'game-clips', server: serverId, type: 'text', topic: 'Show off your highlight clips.' },
          { id: 'demo-chan-9', name: 'Squad Chat 1', server: serverId, type: 'voice' },
          { id: 'demo-chan-10', name: 'Squad Chat 2', server: serverId, type: 'voice' }
        ];
      }
    }

    try {
      try {
        const list = await this.withReadDeadline(
          () => this.pb.collection('channels').getFullList({
            filter: `server = "${serverId}"`,
            sort: 'position,created',
            requestKey: `bootstrap:channels:${serverId}`,
          }),
          `bootstrap:channels:${serverId}`,
        );
        const channels = list as any as Channel[];
        channels.forEach((c) => {
          const { cleanText, cooldown } = extractCooldown(c.topic);
          c.topic = cleanText;
          c.cooldown = cooldown || this.getLocalChannelCooldown(c.id);
          this.channelMetaCache.set(c.id, { record: c, timestamp: Date.now() });
        });
        this.setCachedChannels(serverId, channels);
        return channels;
      } catch (e) {
        if (!isSchemaCompatibilityError(e)) throw e;
        let list: any[] = [];
        try {
          list = await this.withReadDeadline(
            () => this.pb.collection('channels').getFullList({
              filter: `server = "${serverId}"`,
              sort: 'created',
              requestKey: `bootstrap:channels:${serverId}:legacy`,
            }),
            `bootstrap:channels:${serverId}:legacy`,
          );
        } catch (e2) {
          if (!isSchemaCompatibilityError(e2)) throw e2;
          list = await this.withReadDeadline(
            () => this.pb.collection('channels').getFullList({
              filter: `server = "${serverId}"`,
              requestKey: `bootstrap:channels:${serverId}:raw`,
            }),
            `bootstrap:channels:${serverId}:raw`,
          );
        }
        const channels = list as any as Channel[];
        channels.forEach((c) => {
          const { cleanText, cooldown } = extractCooldown(c.topic);
          c.topic = cleanText;
          c.cooldown = cooldown || this.getLocalChannelCooldown(c.id);
          this.channelMetaCache.set(c.id, { record: c, timestamp: Date.now() });
        });
        this.setCachedChannels(serverId, channels);
        return channels;
      }
    } catch (err: any) {
      // Preserve cached channels without changing the global gateway status.
      return this.getCachedChannels(serverId);
    }
  }

  async createChannel(serverId: string, name: string, type: 'text' | 'voice' | 'stream', topic: string = ''): Promise<Channel> {
    if (this.isDemo) {
      return { id: 'demo-chan-' + Math.random().toString(36).substr(2, 9), name, server: serverId, type, topic };
    }
    const data = {
      name: name.toLowerCase().replace(/\s+/g, '-'),
      server: serverId,
      type,
      topic,
      position: '0'
    };
    const record = await this.pb.collection('channels').create(data);
    return record as any as Channel;
  }

  // --- FETCH & SEND MESSAGES ---

  /**
   * Cursor based server-channel history.  This is deliberately separate from
   * the legacy page API below so older clients remain compatible while the
   * current UI can fetch exactly one bounded page per navigation/scroll.
   */
  async fetchMessagesPage(
    channelId: string,
    cursor: MessageCursor | null = null,
    limit: number = INITIAL_MESSAGE_PAGE_SIZE,
    options?: { timeoutMs?: number },
  ): Promise<MessagePage<Message>> {
    if (!channelId) return { items: [], nextCursor: null, hasMore: false };
    if (this.isDemo) {
      const legacy = await this.fetchMessages(channelId, 1, limit);
      const items = legacy.items.slice(-limit);
      return { items, nextCursor: cursorFromMessage(items[0]), hasMore: false };
    }

    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const filter = buildOlderMessageFilter(`channel = "${channelId.replace(/"/g, '\\"')}"`, cursor);
    const cursorKey = cursor ? `${cursor.created}_${cursor.id}` : 'initial';
    const requestKey = `history:channel:${channelId}:${cursorKey}`;
    // PocketBase cancels an in-flight request with the same request key. This
    // matters when a user switches away and back before the old page returns;
    // the generation guard in App.tsx remains the final stale-result barrier.
    (this.pb as any).cancelRequest?.(requestKey);
    let records: any;
    try {
      const query = (expand: string) => this.pb.collection('messages').getList(1, safeLimit + 1, {
        filter,
        sort: '-created,-id',
        expand,
        requestKey,
      });
      try {
        records = await this.withReadDeadline(
          () => query(cachedMessageExpand),
          requestKey,
          options?.timeoutMs,
        );
      } catch (schemaError) {
        if (!isSchemaCompatibilityError(schemaError)) throw schemaError;
        const fallbackExpand = cachedMessageExpand.includes('attachments(')
          ? 'sender,reply_to,attachments_via_message,private_attachments_via_message'
          : 'sender,reply_to,attachments(message),private_attachments(message)';
        records = await this.withReadDeadline(
          () => query(fallbackExpand),
          requestKey,
          options?.timeoutMs,
        );
        cachedMessageExpand = fallbackExpand;
      }
    } catch (err: any) {
      throw new PocketBaseUnavailableError(
        err?.message || 'The chat service is temporarily unavailable',
        err?.status,
      );
    }

    const rawItems = (records.items as any as Message[]).filter((message) => {
      if (message.deleted || message.deleted_at || MessageDeletionService.isMessageDeleted(message.id)) return false;
      return true;
    });
    const hasMore = records.items.length > safeLimit;
    const pageItems = rawItems.slice(0, safeLimit).reverse();
    pageItems.forEach((message) => this.cacheMessageRecord(message));
    const nextCursor = pageItems.length > 0 ? cursorFromMessage(pageItems[0]) : null;
    return { items: pageItems, nextCursor, hasMore };
  }

  /** Cursor based direct-message history using the private chat server index. */
  async fetchDirectMessagesPage(
    recipientId: string,
    chatServerId?: string,
    cursor: MessageCursor | null = null,
    limit: number = INITIAL_MESSAGE_PAGE_SIZE,
    options?: { timeoutMs?: number },
  ): Promise<MessagePage<Message>> {
    if (this.isDemo) return { items: [], nextCursor: null, hasMore: false };
    let targetServerId = chatServerId;
    if (!targetServerId && recipientId) {
      targetServerId = this.getCachedPrivateChatServer(recipientId)?.id;
    }
    if (!targetServerId && recipientId) {
      const server = await this.getOrCreatePrivateChatServer(recipientId);
      targetServerId = server?.id;
    }
    if (!targetServerId) return { items: [], nextCursor: null, hasMore: false };

    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const filter = buildOlderMessageFilter(`chat_server = "${targetServerId.replace(/"/g, '\\"')}"`, cursor);
    const cursorKey = cursor ? `${cursor.created}_${cursor.id}` : 'initial';
    const requestKey = `history:dm:${targetServerId}:${cursorKey}`;
    (this.pb as any).cancelRequest?.(requestKey);
    let records: any;
    try {
      const query = (expand: string) => this.pb.collection('private_messages').getList(1, safeLimit + 1, {
        filter,
        sort: '-created,-id',
        expand,
        requestKey,
      });
      try {
        records = await this.withReadDeadline(
          () => query(cachedMessageExpand),
          requestKey,
          options?.timeoutMs,
        );
      } catch (schemaError) {
        if (!isSchemaCompatibilityError(schemaError)) throw schemaError;
        const fallbackExpand = cachedMessageExpand.includes('attachments(')
          ? 'sender,reply_to,attachments_via_message,private_attachments_via_message'
          : 'sender,reply_to,attachments(message),private_attachments(message)';
        records = await this.withReadDeadline(
          () => query(fallbackExpand),
          requestKey,
          options?.timeoutMs,
        );
        cachedMessageExpand = fallbackExpand;
      }
    } catch (err: any) {
      throw new PocketBaseUnavailableError(
        err?.message || 'The chat service is temporarily unavailable',
        err?.status,
      );
    }

    const rawItems = (records.items as any as Message[]).map((message) => {
      const expanded = message.expand || {};
      const attachments = normalizeAttachmentRecords(
        [
          ...(expanded['attachments(message)'] || []),
          ...(expanded.attachments_via_message || []),
        ],
        [
          ...(expanded['private_attachments(message)'] || []),
          ...(expanded.private_attachments_via_message || []),
        ],
      );
      if (attachments.length > 0) {
        message.expand = {
          ...expanded,
          'attachments(message)': attachments,
          'private_attachments(message)': attachments,
        };
      }
      return message;
    }).filter((message) => {
      if (message.deleted || message.deleted_at || MessageDeletionService.isMessageDeleted(message.id)) return false;
      return true;
    });
    const pageItems = rawItems.slice(0, safeLimit).reverse();
    pageItems.forEach((message) => this.cacheMessageRecord(message));
    return {
      items: pageItems,
      nextCursor: pageItems.length > 0 ? cursorFromMessage(pageItems[0]) : null,
      hasMore: records.items.length > safeLimit,
    };
  }

  async fetchMessages(channelId: string, page: number = 1, perPage: number = 35, beforeCreated?: string, beforeId?: string): Promise<{ items: Message[]; totalPages: number; totalItems: number }> {
    if (this.isDemo) {
      // Return beautiful high-quality demo message list
      const mockSender1: User = { id: 'demo-sender-1', username: 'alex_dev', email: 'alex@example.com', display_name: 'Alex Developer', role: 'admin', status: 'online' };
      const mockSender2: User = { id: 'demo-sender-2', username: 'sarah_m', email: 'sarah@example.com', display_name: 'Sarah Musician', role: 'user', status: 'away' };

      const items = [
        {
          id: 'msg-demo-1',
          content: 'Hello everyone! Welcome to the Sirver PocketBase workspace 🚀',
          sender: mockSender1.id,
          channel: channelId,
          created: new Date(Date.now() - 3600000 * 2).toISOString(),
          expand: { sender: mockSender1 }
        },
        {
          id: 'msg-demo-2',
          content: 'We have full cross-platform capabilities, voice streaming, and responsive file uploads!',
          sender: mockSender1.id,
          channel: channelId,
          created: new Date(Date.now() - 3600000).toISOString(),
          expand: { sender: mockSender1 }
        },
        {
          id: 'msg-demo-3',
          content: 'This sounds incredibly cool! Checking out the Arabic translation options in the top corner too, it swaps dynamically!',
          sender: mockSender2.id,
          channel: channelId,
          created: new Date(Date.now() - 1800000).toISOString(),
          expand: { sender: mockSender2 }
        }
      ];

      return {
        items: page === 1 ? items : [],
        totalPages: 1,
        totalItems: items.length
      };
    }

    try {
      let filterExpr = `channel = "${channelId}"`;
      if (beforeCreated) {
        const formattedBefore = beforeCreated.includes('T') ? beforeCreated.replace('T', ' ') : beforeCreated;
        filterExpr += ` && created < "${formattedBefore}"`;
      }

      const records = await this.pb.collection('messages').getList(page, perPage, {
        filter: filterExpr,
        sort: '-created', // Recent messages first!
        expand: 'sender,reply_to,attachments(message)',
        requestKey: null
      });
      
      const rawItems = (records.items as any as Message[]);
      const readyItems = rawItems.filter((m) => {
        if (m.deleted || Boolean(m.deleted_at && m.deleted_at !== '') || MessageDeletionService.isMessageDeleted(m.id)) {
          return false;
        }
        return true;
      });

      // Reverse so inside this page they are chronological (oldest first)
      const items = [...readyItems].reverse();
      
      return {
        items,
        totalPages: records.totalPages,
        totalItems: records.totalItems
      };
    } catch (err: any) {
      // A transport/5xx failure is not an empty conversation. Let callers keep
      // their cached content and expose a retryable unavailable state instead
      // of marking remote history exhausted.
      console.warn('Network error fetching messages:', err);
      throw new PocketBaseUnavailableError(
        err?.message || 'The chat service is temporarily unavailable',
        err?.status,
      );
    }
  }

  async getMessageById(messageId: string, options: { forceRefresh?: boolean } = {}): Promise<Message> {
    if (!options.forceRefresh) {
      const cached = this.messageRecordCache.get(messageId);
      const cachedAt = this.messageRecordCachedAt.get(messageId) || 0;
      if (cached && Date.now() - cachedAt < 30_000) return cached;
    }
    const pending = this.messageReadPromises.get(messageId);
    if (pending) return pending;

    const request = this.fetchMessageByIdUncached(messageId)
      .finally(() => {
        if (this.messageReadPromises.get(messageId) === request) {
          this.messageReadPromises.delete(messageId);
        }
      });
    this.messageReadPromises.set(messageId, request);
    return request;
  }

  private async fetchMessageByIdUncached(messageId: string): Promise<Message> {
    if (this.isDemo) {
      let reactions: any = [];
      try {
        reactions = JSON.parse(localStorage.getItem(`demo_reactions_${messageId}`) || '[]');
      } catch {}
      return {
        id: messageId,
        content: 'Demo message',
        sender: 'demo-sender-1',
        channel: 'demo-channel',
        created: new Date().toISOString(),
        reactions
      };
    }

    let publicError: any;
    const readPublicMessage = async (expand: string, requestKey: string): Promise<Message> => {
      const record = await this.withReadDeadline(
        () => this.pb.collection('messages').getOne(messageId, { expand, requestKey }),
        requestKey,
      );
      return record as any as Message;
    };

    try {
      let message: Message;
      try {
        message = await readPublicMessage(
          'sender,reply_to,reply_to.sender,attachments_via_message,private_attachments_via_message',
          `message:${messageId}`,
        );
      } catch (preferredError: any) {
        publicError = preferredError;
        if (!isSchemaCompatibilityError(preferredError)) throw preferredError;
        // Confirmed old schemas may not expose the reverse relation name yet;
        // retry that same public record with the legacy expansion only.
        message = await readPublicMessage(
          'sender,reply_to,reply_to.sender,attachments(message),private_attachments(message)',
          `message:${messageId}:legacy`,
        );
      }
      this.cacheMessageRecord(message);
      return message;
    } catch (err: any) {
      publicError = err || publicError;
      const status = Number(err?.status || err?.response?.code || 0);
      const message = String(err?.message || '').toLowerCase();
      // A missing public record can legitimately be a private message. Do
      // not fall through to the private collection for transport/timeout/
      // 5xx errors, which previously created a retry waterfall during an
      // outage.
      const missingPublicRecord = status === 404 || /not found|wasn't found|does not exist|missing/i.test(message);
      if (!missingPublicRecord) {
        throw new PocketBaseUnavailableError(
          err?.message || 'The chat service is temporarily unavailable',
          err?.status,
        );
      }
    }

    try {
      let pmRecord: any;
      try {
        pmRecord = await this.withReadDeadline(
          () => this.pb.collection('private_messages').getOne(messageId, {
            expand: 'sender,user,private_attachments_via_message,attachments_via_message',
            requestKey: `private-message:${messageId}`,
          }),
          `private-message:${messageId}`,
        );
      } catch (preferredError: any) {
        if (!isSchemaCompatibilityError(preferredError)) throw preferredError;
        pmRecord = await this.withReadDeadline(
          () => this.pb.collection('private_messages').getOne(messageId, {
            expand: 'sender,user,private_attachments(message),attachments(message)',
            requestKey: `private-message:${messageId}:legacy`,
          }),
          `private-message:${messageId}:legacy`,
        );
      }
      const expanded = (pmRecord as any).expand || {};
      const attachments = normalizeAttachmentRecords(
        expanded['attachments(message)'] || expanded.attachments_via_message || [],
        expanded['private_attachments(message)'] || expanded.private_attachments_via_message || [],
      );
      if (attachments.length > 0) {
        (pmRecord as any).expand = {
          ...expanded,
          'attachments(message)': attachments,
          'private_attachments(message)': attachments,
        };
      }
      const message = pmRecord as any as Message;
      this.cacheMessageRecord(message);
      return message;
    } catch (privateError: any) {
      const isNotFound =
        privateError?.status === 404 ||
        publicError?.status === 404 ||
        /not found|wasn't found|does not exist|missing/i.test(privateError?.message || '') ||
        /not found|wasn't found|does not exist|missing/i.test(publicError?.message || '');
      if (!isNotFound) {
        console.warn('Failed to fetch message by id:', messageId, publicError);
      }
      throw privateError || publicError;
    }
  }

  async touchMessage(messageId: string): Promise<void> {
    if (this.isDemo) return;
    try {
      await this.pb.collection('messages').update(messageId, {
        has_attachment: true
      });
    } catch (err) {
      try {
        await this.pb.collection('private_messages').update(messageId, {
          has_attachment: true
        });
      } catch (e) {
        console.warn('Failed to touch message:', e);
      }
    }
  }

  async fetchServerMessages(serverId: string): Promise<Message[]> {
    if (this.isDemo) {
      return [];
    }
    try {
      const records = await this.pb.collection('messages').getList(1, 100, {
        filter: `channel.server = "${serverId}"`,
        expand: 'sender,reply_to,attachments(message)',
        sort: '-created',
        requestKey: null
      });
      const rawItems = (records.items as any as Message[]);
      return rawItems.filter((m) => {
        if (m.deleted || Boolean(m.deleted_at && m.deleted_at !== '') || MessageDeletionService.isMessageDeleted(m.id)) {
          return false;
        }
        return true;
      });
    } catch (err) {
      console.warn('Failed to fetch server messages:', err);
      return [];
    }
  }

  async sendMessage(channelId: string, content: string, replyToId?: string, hasAttachment: boolean = false): Promise<Message> {
    if (this.isDemo) {
      const curUser = this.getCurrentUser()!;
      const msg: Message = {
        id: 'msg-demo-' + Math.random().toString(36).substr(2, 9),
        content,
        sender: curUser.id,
        channel: channelId,
        reply_to: replyToId,
        has_attachment: hasAttachment,
        created: new Date().toISOString(),
        expand: { sender: curUser }
      };
      
      // Notify listeners for simulated reactive updates
      setTimeout(() => {
        this.triggerDemoListeners({
          action: 'create',
          record: msg
        });
      }, 100);

      return msg;
    }

    const data: any = {
      content: content.trim() === '' ? '  ' : content,
      sender: this.pb.authStore.model?.id,
      channel: channelId,
      has_attachment: hasAttachment
    };
    if (replyToId) {
      data.reply_to = replyToId;
    }

    const record = await this.pb.collection('messages').create(data, {
      expand: 'sender,reply_to'
    });
    const msg = record as any as Message;
    this.cacheMessageRecord(msg);

    // Broadcast message created event over WebSocket / BroadcastChannel for instant multi-client delivery
    try {
      wsService.send({
        type: 'message_delivery',
        action: 'create',
        record: msg,
        channelId: channelId,
        userId: this.pb.authStore.model?.id
      });
    } catch (wsErr) {}

    return msg;
  }

  // --- FILE & ATTACHMENT UPLOADS ---

  async uploadAttachment(messageId: string, file: File): Promise<Attachment> {
    return this.uploadAttachmentWithProgress(messageId, file);
  }

  async uploadAttachmentWithProgress(
    messageId: string,
    file: File,
    onProgress?: (pct: number) => void,
    abortSignal?: AbortSignal,
    isPrivate: boolean = false,
    thumbnail?: GeneratedThumbnailFile | null,
  ): Promise<Attachment> {
    if (this.isDemo) {
      return new Promise((resolve, reject) => {
        let p = 0;
        const interval = setInterval(() => {
          if (abortSignal?.aborted) {
            clearInterval(interval);
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          p += 25;
          if (onProgress) onProgress(Math.min(p, 100));
          if (p >= 100) {
            clearInterval(interval);
            resolve({
              id: 'attachment-demo-' + Math.random().toString(36).substr(2, 9),
              file: URL.createObjectURL(file),
              uploader: this.getCurrentUser()?.id,
              message: messageId,
              type: file.type,
              size: `${Math.round(file.size / 1024)} KB`,
              created: new Date().toISOString()
            });
          }
        }, 120);

        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            clearInterval(interval);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      });
    }

    const primaryCollection = isPrivate ? 'private_attachments' : 'attachments';
    const secondaryCollection = isPrivate ? 'attachments' : 'private_attachments';

    // Generate a separate feed thumbnail once per upload. The original file is
    // always appended as `file` unchanged; thumbnail generation is best effort
    // so older PocketBase schemas and non-browser runtimes remain compatible.
    let thumbnailPayload = thumbnail || null;
    let thumbnailProcessor: typeof import('./services/attachmentProcessor').AttachmentProcessor | null = null;
    if (!thumbnailPayload && (file.type?.startsWith('image/') || file.type?.startsWith('video/'))) {
      try {
        thumbnailProcessor = (await import('./services/attachmentProcessor')).AttachmentProcessor;
      } catch {
        // Thumbnail generation is an enhancement; legacy upload remains valid
        // when a native WebView cannot load the optional processor chunk.
      }
    }
    if (!thumbnailPayload && file.type?.startsWith('image/')) {
      thumbnailPayload = await thumbnailProcessor?.generateImageThumbnailFile(file, 480).catch(() => null) || null;
    } else if (!thumbnailPayload && file.type?.startsWith('video/')) {
      // Upload a small poster separately. The original video remains the
      // `file` field and is never downloaded merely to paint the feed.
      thumbnailPayload = await thumbnailProcessor?.generateVideoThumbnailFile(file, 480).catch(() => null) || null;
    }

    const tryUploadToCollection = (collectionName: string, includeThumbnail = true): Promise<Attachment> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const url = `${this.getServerUrl()}/api/collections/${collectionName}/records`;

        xhr.open('POST', url, true);

        const token = this.pb.authStore.token;
        if (token) {
          xhr.setRequestHeader('Authorization', token);
        }

        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            xhr.abort();
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) {
            const pct = Math.round((e.loaded / e.total) * 100);
            onProgress(pct);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const res = JSON.parse(xhr.responseText);
              if (onProgress) onProgress(100);
              resolve({ ...res, collectionName } as Attachment);
            } catch (err) {
              reject(err);
            }
          } else {
            const error = new Error(`Upload failed with status ${xhr.status}`) as Error & {
              status?: number;
              responseText?: string;
            };
            error.status = xhr.status;
            error.responseText = xhr.responseText;
            reject(error);
          }
        };

        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));

        const formData = new FormData();
        formData.append('file', file);
        formData.append('uploader', this.pb.authStore.model?.id || '');
        if (messageId) formData.append('message', messageId);
        formData.append('type', file.type);
        formData.append('size', `${file.size}`);
        if (includeThumbnail && thumbnailPayload?.file) {
          formData.append('thumbnail', thumbnailPayload.file);
          formData.append('thumbnail_width', `${thumbnailPayload.width}`);
          formData.append('thumbnail_height', `${thumbnailPayload.height}`);
          formData.append('thumbnail_mime', thumbnailPayload.mime);
          formData.append('thumbnail_size', `${thumbnailPayload.size}`);
        }

        xhr.send(formData);
      });
    };

    // Thumbnail fields are additive and may not exist yet on an older
    // PocketBase collection. Retry that same collection once without the
    // optional fields when PocketBase rejects the multipart schema, while
    // preserving the original file and the legacy collection fallback.
    const tryUploadWithThumbnailCompatibility = async (collectionName: string): Promise<Attachment> => {
      try {
        return await tryUploadToCollection(collectionName, true);
      } catch (error: any) {
        const status = Number(error?.status || 0);
        const responseText = String(error?.responseText || '').toLowerCase();
        const looksLikeSchemaRejection = thumbnailPayload &&
          (status === 400 || status === 422) &&
          /thumbnail|unknown field|invalid field|no such field|does not exist/.test(responseText);
        if (!looksLikeSchemaRejection) throw error;
        console.warn(`Thumbnail fields are not accepted by ${collectionName}; retrying original-only upload.`);
        return await tryUploadToCollection(collectionName, false);
      }
    };

    try {
      return await tryUploadWithThumbnailCompatibility(primaryCollection);
    } catch (e) {
      // A second collection is a schema compatibility path only. Retrying on
      // a tunnel outage/530/5xx doubles upload traffic and can create partial
      // records, so transport failures are surfaced to the caller.
      if (!isSchemaCompatibilityError(e)) throw e;
      console.warn(`Upload to ${primaryCollection} failed, trying ${secondaryCollection}:`, e);
      return await tryUploadWithThumbnailCompatibility(secondaryCollection);
    }
  }

  async linkAttachmentToMessage(attachmentId: string, messageId: string, isPrivate: boolean = false): Promise<void> {
    if (this.isDemo) return;
    const primaryCollection = isPrivate ? 'private_attachments' : 'attachments';
    const fallbackCollection = isPrivate ? 'attachments' : 'private_attachments';
    try {
      await this.pb.collection(primaryCollection).update(attachmentId, { message: messageId });
    } catch (e) {
      try {
        await this.pb.collection(fallbackCollection).update(attachmentId, { message: messageId });
      } catch (e2) {
        console.warn('Could not update attachment message field:', e2);
      }
    }
  }

  async deleteAttachmentRecord(attachmentId: string, isPrivate: boolean = false, force: boolean = false): Promise<void> {
    if (this.isDemo || !attachmentId) return;
    const primaryCollection = isPrivate ? 'private_attachments' : 'attachments';
    const fallbackCollection = isPrivate ? 'attachments' : 'private_attachments';

    const tryDelete = async (collName: string): Promise<boolean> => {
      try {
        const record = await this.pb.collection(collName).getOne(attachmentId).catch(() => null);
        if (record) {
          // Safety Check: Never delete an attachment that is linked to a sent message unless explicitly forced
          if (!force && record.message && record.message !== '') {
            return true;
          }
          await this.pb.collection(collName).delete(attachmentId);
          return true;
        }
      } catch (err) {
        // Record may not exist or already deleted
      }
      return false;
    };

    const deleted = await tryDelete(primaryCollection);
    if (!deleted) {
      await tryDelete(fallbackCollection);
    }
  }

  async deleteUnlinkedAttachments(attachmentIds: string[], isPrivate: boolean = false): Promise<void> {
    if (!attachmentIds || attachmentIds.length === 0) return;
    await Promise.all(attachmentIds.map((id) => this.deleteAttachmentRecord(id, isPrivate)));
  }

  // --- CALLS & VOICE CHANNELS ---

  async fetchActiveCalls(channelId: string): Promise<Call[]> {
    if (this.isDemo) {
      return [];
    }
    try {
      const records = await this.pb.collection('calls').getFullList({
        filter: `channel = "${channelId}"`
      });
      return records as any as Call[];
    } catch (err) {
      console.warn('Could not fetch active calls:', err);
      return [];
    }
  }

  async startOrJoinCall(channelId: string): Promise<Call> {
    if (this.isDemo) {
      return {
        id: 'demo-call-' + Math.random().toString(36).substr(2, 9),
        channel: channelId,
        started_by: this.getCurrentUser()?.id || 'demo-user-id'
      };
    }

    // Try finding existing call for channel
    const active = await this.fetchActiveCalls(channelId);
    if (active.length > 0) {
      return active[0];
    }

    const data = {
      channel: channelId,
      started_by: this.pb.authStore.model?.id || '',
      call: `webrtc-room-${channelId}`
    };
    const record = await this.pb.collection('calls').create(data);
    return record as any as Call;
  }

  // --- REAL-TIME VOICE PRESENCE PERSISTENCE & SUBSCRIPTION ---
  private memoryVoicePresences: Map<string, any> = new Map();

  async syncVoicePresence(info: any): Promise<void> {
    if (!info || !info.userId || !info.channelId) return;
    this.memoryVoicePresences.set(info.userId, {
      ...info,
      updatedAt: Date.now()
    });

    if (this.isDemo) return;

    // 1. Sync via voice_presences collection
    try {
      const existing = await this.pb.collection('voice_presences').getList(1, 1, {
        filter: `user = "${info.userId}"`
      }).catch(() => null);

      const payload = {
        user: info.userId,
        channel: info.channelId,
        server: info.serverId || '',
        display_name: info.displayName || '',
        avatar: info.avatar || '',
        is_muted: !!info.isMuted,
        is_deafened: !!info.isDeafened,
        is_camera_enabled: !!info.isCameraEnabled,
        is_screen_sharing: !!info.isScreenSharing,
        is_speaking: !!info.isSpeaking,
        joined_at: info.joinedAt || Date.now(),
        last_heartbeat: Date.now()
      };

      if (existing && existing.items && existing.items.length > 0) {
        await this.pb.collection('voice_presences').update(existing.items[0].id, payload);
      } else {
        await this.pb.collection('voice_presences').create(payload);
      }
    } catch (e) {}

    // 2. Sync via calls collection (guaranteed working collection)
    try {
      const callPayload = {
        channel: info.channelId,
        started_by: info.userId,
        call: JSON.stringify({
          channelId: info.channelId,
          serverId: info.serverId || '',
          userId: info.userId,
          userRef: info.userRef,
          displayName: info.displayName,
          avatar: info.avatar,
          isMuted: info.isMuted,
          isDeafened: info.isDeafened || false,
          isCameraEnabled: info.isCameraEnabled,
          isScreenSharing: info.isScreenSharing,
          isSpeaking: info.isSpeaking,
          joinedAt: info.joinedAt || Date.now(),
          lastHeartbeat: Date.now()
        })
      };

      const existingCalls = await this.pb.collection('calls').getList(1, 10, {
        filter: `started_by = "${info.userId}"`
      }).catch(() => null);

      if (existingCalls && existingCalls.items && existingCalls.items.length > 0) {
        await this.pb.collection('calls').update(existingCalls.items[0].id, callPayload);
      } else {
        await this.pb.collection('calls').create(callPayload);
      }
    } catch (e) {}
  }

  async deleteVoicePresence(userId: string): Promise<void> {
    if (!userId) return;
    this.memoryVoicePresences.delete(userId);
    if (this.isDemo) return;

    try {
      const existing = await this.pb.collection('voice_presences').getFullList({
        filter: `user = "${userId}"`
      }).catch(() => null);

      if (existing && existing.length > 0) {
        await Promise.all(
          existing.map((item: any) => this.pb.collection('voice_presences').delete(item.id).catch(() => {}))
        );
      }
    } catch (e) {}

    try {
      const existingCalls = await this.pb.collection('calls').getFullList({
        filter: `started_by = "${userId}"`
      }).catch(() => null);

      if (existingCalls && existingCalls.length > 0) {
        await Promise.all(
          existingCalls.map((item: any) => this.pb.collection('calls').delete(item.id).catch(() => {}))
        );
      }
    } catch (e) {}
  }

  async fetchVoicePresences(): Promise<any[]> {
    if (this.isDemo) {
      return Array.from(this.memoryVoicePresences.values());
    }

    const presences: any[] = [];
    const now = Date.now();
    const MAX_AGE_MS = 20000; // 20 seconds max age for voice presences

    try {
      const records = await this.pb.collection('voice_presences').getFullList({
        sort: '-updated'
      });
      if (records && records.length > 0) {
        records.forEach((r: any) => {
          const updatedAt = new Date(r.updated || r.created || Date.now()).getTime();
          if (now - updatedAt < MAX_AGE_MS) {
            presences.push({
              channelId: r.channel,
              serverId: r.server,
              userId: r.user,
              displayName: r.display_name,
              avatar: r.avatar,
              isMuted: r.is_muted,
              isDeafened: r.is_deafened,
              isCameraEnabled: r.is_camera_enabled,
              isScreenSharing: r.is_screen_sharing,
              isSpeaking: r.is_speaking,
              joinedAt: r.joined_at,
              lastHeartbeat: updatedAt,
            });
          } else {
            // Asynchronously delete stale presence record from DB
            this.pb.collection('voice_presences').delete(r.id).catch(() => {});
          }
        });
      }
    } catch (err) {}

    try {
      const callRecords = await this.pb.collection('calls').getFullList({
        sort: '-updated'
      });
      if (callRecords && callRecords.length > 0) {
        callRecords.forEach((r: any) => {
          const updatedAt = new Date(r.updated || r.created || Date.now()).getTime();
          if (now - updatedAt < MAX_AGE_MS) {
            if (r.call && r.call.startsWith('{')) {
              try {
                const parsed = JSON.parse(r.call);
                if (parsed && parsed.userId && parsed.channelId) {
                  if (!presences.some((p) => p.userId === parsed.userId)) {
                    presences.push({
                      ...parsed,
                      lastHeartbeat: updatedAt,
                    });
                  }
                }
              } catch (e) {}
            }
          } else {
            // Asynchronously delete stale call record from DB
            this.pb.collection('calls').delete(r.id).catch(() => {});
          }
        });
      }
    } catch (e) {}

    return presences;
  }

  subscribeToVoicePresences(callback: (event: any) => void): () => void {
    if (this.isDemo) {
      return () => {};
    }

    const unsubs: Array<() => void> = [];

    try {
      this.pb.collection('voice_presences').subscribe('*', (e: any) => {
        const r = e.record;
        if (e.action === 'delete') {
          callback({
            status: 'left',
            userId: r?.user,
            channelId: r?.channel,
            serverId: r?.server
          });
        } else {
          callback({
            status: e.action === 'create' ? 'joined' : 'updated',
            channelId: r?.channel,
            serverId: r?.server,
            userId: r?.user,
            displayName: r?.display_name,
            avatar: r?.avatar,
            isMuted: r?.is_muted,
            isDeafened: r?.is_deafened,
            isCameraEnabled: r?.is_camera_enabled,
            isScreenSharing: r?.is_screen_sharing,
            isSpeaking: r?.is_speaking,
            joinedAt: r?.joined_at,
            lastHeartbeat: new Date(r?.updated || Date.now()).getTime(),
          });
        }
      }).catch(() => {});

      unsubs.push(() => {
        this.pb.collection('voice_presences').unsubscribe('*').catch(() => {});
      });
    } catch (e) {}

    try {
      this.pb.collection('calls').subscribe('*', (e: any) => {
        const r = e.record;
        if (e.action === 'delete') {
          callback({
            status: 'left',
            userId: r?.started_by,
            channelId: r?.channel,
          });
        } else if (r?.call && r.call.startsWith('{')) {
          try {
            const parsed = JSON.parse(r.call);
            if (parsed && parsed.userId && parsed.channelId) {
              callback({
                status: e.action === 'create' ? 'joined' : 'updated',
                ...parsed,
                lastHeartbeat: new Date(r.updated || Date.now()).getTime(),
              });
            }
          } catch (err) {}
        }
      }).catch(() => {});

      unsubs.push(() => {
        this.pb.collection('calls').unsubscribe('*').catch(() => {});
      });
    } catch (e) {}

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }

  // --- REALTIME SUBSCRIPTIONS ---
  private messageListeners = new Set<{ channelId: string; callback: (event: any) => void }>();
  private messagesSubscribed = false;
  private attachmentsSubscribed = false;

  private setupMessagesSubscription() {
    if (this.messagesSubscribed || this.isDemo || !this.pb.authStore.isValid || !this.pb.authStore.token) return;
    this.messagesSubscribed = true;

    try {
      this.pb.collection('messages').subscribe('*', (e) => {
        // Emit exactly one normalized event. PocketBase realtime records carry
        // the message payload; callers resolve optional relations from their
        // local user/message caches instead of refetching the same record.
        this.messageListeners.forEach(({ channelId, callback }) => {
          if (channelId === '*' || e.record?.channel === channelId) {
            try {
              const record = e.record ? {
                ...e.record,
                expand: e.record.expand || {},
              } : e.record;
              this.cacheMessageRecord(record as unknown as Message);
              callback({ ...e, record });
            } catch (cbErr) {}
          }
        });
      }).catch((err) => {
        this.messagesSubscribed = false;
        if (!this.pb.authStore.isValid || !this.pb.authStore.token) return;
        if (this.messageRetryTimeout) clearTimeout(this.messageRetryTimeout);
        this.messageRetryTimeout = setTimeout(() => {
          if (this.messageListeners.size > 0 && !this.messagesSubscribed && this.pb.authStore.isValid && this.pb.authStore.token) {
            this.setupMessagesSubscription();
          }
        }, 5000);
      });
    } catch (err) {
      this.messagesSubscribed = false;
      if (!this.pb.authStore.isValid || !this.pb.authStore.token) return;
      if (this.messageRetryTimeout) clearTimeout(this.messageRetryTimeout);
      this.messageRetryTimeout = setTimeout(() => {
        if (this.messageListeners.size > 0 && !this.messagesSubscribed && this.pb.authStore.isValid && this.pb.authStore.token) {
          this.setupMessagesSubscription();
        }
      }, 5000);
    }

    // Attachments arrive as separate records in PocketBase. Merge them into
    // the most recent parent message locally; never perform a getOne() for
    // every upload just to rediscover the message we already received.
    if (!this.attachmentsSubscribed && this.pb.authStore.isValid && this.pb.authStore.token) {
      this.attachmentsSubscribed = true;
      try {
        this.pb.collection('attachments').subscribe('*', (e) => {
          const attachment = e.record;
          const messageId = attachment?.message;
          if (!messageId) return;
          const parent = this.messageRecordCache.get(messageId);
          if (!parent) return;
          const expanded = parent.expand || {};
          const nextAttachments = normalizeAttachmentRecords(
            [...(expanded['attachments(message)'] || []), attachment],
            expanded['private_attachments(message)'] || [],
          );
          const record = {
            ...parent,
            has_attachment: true,
            expand: {
              ...expanded,
              'attachments(message)': nextAttachments,
              'private_attachments(message)': nextAttachments,
              attachments_via_message: nextAttachments,
              private_attachments_via_message: nextAttachments,
            },
          } as Message;
          this.cacheMessageRecord(record);
          this.messageListeners.forEach(({ channelId, callback }) => {
            if (channelId === '*' || record.channel === channelId) {
              try { callback({ action: 'update', record }); } catch (cbErr) {}
            }
          });
        }).catch((err) => {
          this.attachmentsSubscribed = false;
        });
      } catch (err) {
        this.attachmentsSubscribed = false;
      }
    }
  }

  subscribeToMessages(channelId: string, callback: (event: any) => void): () => void {
    if (this.isDemo) {
      const listener = (event: any) => {
        if (event.record && event.record.channel === channelId) {
          callback(event);
        }
      };
      this.demoListeners.add(listener);
      return () => {
        this.demoListeners.delete(listener);
      };
    }

    const listenerObj = { channelId, callback };
    this.messageListeners.add(listenerObj);
    if (this.pb.authStore.isValid && this.pb.authStore.token) {
      this.setupMessagesSubscription();
    }

    return () => {
      this.messageListeners.delete(listenerObj);
      if (this.messageListeners.size === 0) {
        if (this.messageRetryTimeout) {
          clearTimeout(this.messageRetryTimeout);
          this.messageRetryTimeout = null;
        }
        this.messagesSubscribed = false;
        try {
          this.pb.collection('messages').unsubscribe('*').catch(() => {});
        } catch (e) {}
      }
    };
  }

  public triggerDemoListeners(event: any) {
    this.demoListeners.forEach((listener) => listener(event));
  }

  // --- TRANSLATION & LOCALIZATION SERVICES ---

  async fetchTranslations(): Promise<Translation[]> {
    if (this.isDemo) {
      return [
        { key: 'username', en: 'Username', ar: 'اسم المستخدم' },
        { key: 'password', en: 'Password', ar: 'كلمة المرور' },
        { key: 'login', en: 'Log In', ar: 'تسجيل الدخول' },
        { key: 'signup', en: 'Create Account', ar: 'إنشاء حساب' },
        { key: 'logout', en: 'Sign Out', ar: 'تسجيل الخروج' },
        { key: 'display_name', en: 'Display Name', ar: 'الاسم المستعار' },
        { key: 'status', en: 'Status', ar: 'الحالة' },
        { key: 'bio', en: 'About Me', ar: 'نبذة عني' },
        { key: 'settings', en: 'Settings', ar: 'الإعدادات' },
        { key: 'channels', en: 'Channels', ar: 'القنوات' },
        { key: 'text_channels', en: 'Text Channels', ar: 'القنوات النصية' },
        { key: 'voice_channels', en: 'Voice Channels', ar: 'القنوات الصوتية' },
        { key: 'general_server', en: 'Servers', ar: 'السيرفرات' },
        { key: 'reply', en: 'Reply', ar: 'رد' },
        { key: 'send', en: 'Send', ar: 'إرسال' },
        { key: 'mute', en: 'Mute', ar: 'كتم' },
        { key: 'unmute', en: 'Unmute', ar: 'إلغاء الكتم' },
        { key: 'deafen', en: 'Deafen', ar: 'تعطيل الصوت' },
        { key: 'undeafen', en: 'Undeafen', ar: 'تمكين الصوت' },
        { key: 'voice_connected', en: 'Voice Connected', ar: 'تم الاتصال بالصوت' },
        { key: 'leave_call', en: 'Disconnect', ar: 'قطع الاتصال' },
        { key: 'attachment', en: 'Attachment', ar: 'مرفق' },
        { key: 'server_url', en: 'PocketBase Server URL', ar: 'رابط سيرفر PocketBase' },
        { key: 'create_server', en: 'Create New Server', ar: 'إنشاء سيرفر جديد' },
        { key: 'create_channel', en: 'Create New Channel', ar: 'إنشاء قناة جديدة' },
        { key: 'joined', en: 'Joined', ar: 'انضم' },
        { key: 'role', en: 'Role', ar: 'الرتبة' },
        { key: 'language', en: 'Language', ar: 'اللغة' }
      ];
    }

    try {
      const records = await this.pb.collection('translations').getFullList({
        perPage: 500
      });
      return records as any as Translation[];
    } catch (err) {
      return [];
    }
  }

  // --- USER PROFILE SETTINGS SYNC ---

  async getUserById(userId: string): Promise<User | null> {
    if (this.isDemo) {
      const cur = this.getCurrentUser();
      if (cur && cur.id === userId) return cur;
      return null;
    }
    try {
      const record = await this.pb.collection('users').getOne(userId);
      return record as any as User;
    } catch (err) {
      console.warn('Failed to fetch user by id:', userId, err);
      return null;
    }
  }

  async updateProfile(userId: string, data: Partial<User>, avatarFile?: File, bannerFile?: File): Promise<User> {
    if (this.isDemo) {
      const current = this.getCurrentUser()!;
      const updated = { ...current, ...data };
      if (data.avatar === 'REMOVE' || data.avatar === null) {
        updated.avatar = '';
      } else if (avatarFile) {
        updated.avatar = URL.createObjectURL(avatarFile);
      }
      if (data.banner === 'REMOVE' || data.banner === null) {
        updated.banner = '';
      } else if (bannerFile) {
        updated.banner = URL.createObjectURL(bannerFile);
      }
      localStorage.setItem('demo_user', JSON.stringify(updated));
      return updated;
    }

    const formData = new FormData();
    Object.keys(data).forEach((key) => {
      const val = (data as any)[key];
      if (key === 'avatar' && (val === 'REMOVE' || val === null)) {
        formData.append('avatar', '');
      } else if (key === 'banner' && (val === 'REMOVE' || val === null)) {
        formData.append('banner', '');
      } else if (key === 'friends' && Array.isArray(val)) {
        val.forEach((fId) => formData.append('friends', fId));
      } else if (typeof val === 'object' && val !== null) {
        formData.append(key, JSON.stringify(val));
      } else {
        formData.append(key, val);
      }
    });
    if (avatarFile) {
      formData.append('avatar', avatarFile);
    }
    if (bannerFile) {
      formData.append('banner', bannerFile);
    }

    const record = await this.pb.collection('users').update(userId, formData);
    if (this.pb.authStore.model && this.pb.authStore.model.id === userId) {
      this.pb.authStore.save(this.pb.authStore.token, record);
    }
    return record as any as User;
  }

  getLocalServerCooldown(serverId: string): number {
    const val = localStorage.getItem(`server_cooldown_${serverId}`);
    return val ? parseInt(val, 10) : 0;
  }

  getLocalChannelCooldown(channelId: string): number {
    const val = localStorage.getItem(`channel_cooldown_${channelId}`);
    return val ? parseInt(val, 10) : 0;
  }

  async updateServer(serverId: string, data: Partial<Server>): Promise<Server> {
    if (this.isDemo) {
      return { id: serverId, name: 'Demo Server', ...data };
    }
    try {
      const existing = await this.pb.collection('servers').getOne(serverId);
      let desc = data.description !== undefined ? data.description : existing.description || '';
      
      let finalCooldown = data.cooldown;
      if (finalCooldown !== undefined) {
        localStorage.setItem(`server_cooldown_${serverId}`, finalCooldown.toString());
        desc = injectCooldown(desc, finalCooldown);
      } else {
        const { cooldown: parsedCool } = extractCooldown(desc);
        finalCooldown = parsedCool || this.getLocalServerCooldown(serverId);
      }
      
      const toSend: any = { ...data };
      toSend.description = desc;
      delete toSend.cooldown;

      const record = await this.pb.collection('servers').update(serverId, toSend);
      const server = record as any as Server;
      const { cleanText, cooldown } = extractCooldown(server.description);
      server.description = cleanText;
      server.cooldown = cooldown || finalCooldown;
      return server;
    } catch (err) {
      console.warn('PocketBase servers update failed, utilizing fallback:', err);
      if (data.cooldown !== undefined) {
        localStorage.setItem(`server_cooldown_${serverId}`, data.cooldown.toString());
      }
      try {
        const record = await this.pb.collection('servers').getOne(serverId);
        const server = record as any as Server;
        const { cleanText, cooldown } = extractCooldown(server.description);
        server.description = cleanText;
        server.cooldown = cooldown || this.getLocalServerCooldown(serverId);
        return server;
      } catch (inner) {
        return { id: serverId, ...data } as any as Server;
      }
    }
  }

  async updateChannel(channelId: string, data: Partial<Channel>): Promise<Channel> {
    if (this.isDemo) {
      return { id: channelId, name: 'Demo Channel', server: 'demo-server-1', type: 'text', ...data };
    }
    try {
      const existing = await this.pb.collection('channels').getOne(channelId);
      let top = data.topic !== undefined ? data.topic : existing.topic || '';
      
      let finalCooldown = data.cooldown;
      if (finalCooldown !== undefined) {
        localStorage.setItem(`channel_cooldown_${channelId}`, finalCooldown.toString());
        top = injectCooldown(top, finalCooldown);
      } else {
        const { cooldown: parsedCool } = extractCooldown(top);
        finalCooldown = parsedCool || this.getLocalChannelCooldown(channelId);
      }
      
      const toSend: any = { ...data };
      toSend.topic = top;
      delete toSend.cooldown;

      if (toSend.channel_options) {
        const jsonStr = typeof toSend.channel_options === 'string'
          ? toSend.channel_options
          : JSON.stringify(toSend.channel_options);
        toSend.channel_options = jsonStr;
        try {
          localStorage.setItem(`channel_options_${channelId}`, jsonStr);
        } catch (e) {}
      }

      let record;
      try {
        record = await this.pb.collection('channels').update(channelId, toSend);
      } catch (err) {
        if (toSend.channel_options !== undefined) {
          delete toSend.channel_options;
          record = await this.pb.collection('channels').update(channelId, toSend);
        } else {
          throw err;
        }
      }
      const channel = record as any as Channel;
      const { cleanText, cooldown } = extractCooldown(channel.topic);
      channel.topic = cleanText;
      channel.cooldown = cooldown || finalCooldown;
      return channel;
    } catch (err) {
      console.warn('PocketBase channels update failed, utilizing fallback:', err);
      if (data.cooldown !== undefined) {
        localStorage.setItem(`channel_cooldown_${channelId}`, data.cooldown.toString());
      }
      try {
        const record = await this.pb.collection('channels').getOne(channelId);
        const channel = record as any as Channel;
        const { cleanText, cooldown } = extractCooldown(channel.topic);
        channel.topic = cleanText;
        channel.cooldown = cooldown || this.getLocalChannelCooldown(channelId);
        return channel;
      } catch (inner) {
        return { id: channelId, name: 'Channel', server: '', type: 'text', ...data } as any as Channel;
      }
    }
  }

  async editMessage(messageId: string, content: string): Promise<Message> {
    const now = new Date().toISOString();
    if (this.isDemo) {
      const msg: any = { id: messageId, content, updated: now, edited_at: now, edited: true };
      this.triggerDemoListeners({
        action: 'update',
        record: msg
      });
      return msg;
    }
    let record: any;
    try {
      record = await this.pb.collection('messages').update(messageId, { content, edited: true, edited_at: now }, {
        expand: 'sender,reply_to,attachments(message)'
      });
    } catch {
      record = await this.pb.collection('messages').update(messageId, { content }, {
        expand: 'sender,reply_to,attachments(message)'
      });
    }
    const msg = record as any as Message;
    this.cacheMessageRecord(msg);
    msg.updated = now;
    msg.edited_at = now;
    msg.edited = true;
    return msg;
  }

  async deleteMessage(messageId: string, options?: DeleteMessageOptions): Promise<boolean> {
    return MessageDeletionService.deleteMessage(messageId, options);
  }

  async toggleMessageReaction(messageId: string, emoji: string, isDm: boolean = false): Promise<{ emoji: string; users: string[] }[]> {
    const currentUserId = this.getCurrentUser()?.id;
    if (!currentUserId) throw new Error("Authentication required to add reaction");

    const collectionName = isDm ? 'private_messages' : 'messages';
    const expandQuery = isDm
      ? 'sender,recipient,reply_to,attachments(message),private_attachments(message)'
      : 'sender,reply_to,attachments(message)';

    if (this.isDemo) {
      const demoKey = `demo_reactions_${messageId}`;
      let currentRaw: any = [];
      try {
        currentRaw = JSON.parse(localStorage.getItem(demoKey) || '[]');
      } catch {}
      const updatedList = toggleReactionInList(currentRaw, emoji, currentUserId);
      localStorage.setItem(demoKey, JSON.stringify(updatedList));
      this.triggerDemoListeners({
        action: 'update',
        record: { id: messageId, reactions: updatedList }
      });
      return updatedList;
    }

    try {
      let record: any;
      try {
        record = await this.pb.collection(collectionName).getOne(messageId, { requestKey: null });
      } catch (e1) {
        if (!isDm) {
          try {
            record = await this.pb.collection('private_messages').getOne(messageId, { requestKey: null });
            return this.toggleMessageReaction(messageId, emoji, true);
          } catch {}
        } else {
          try {
            record = await this.pb.collection('messages').getOne(messageId, { requestKey: null });
            return this.toggleMessageReaction(messageId, emoji, false);
          } catch {}
        }
        throw e1;
      }

      const rawReactions = (record as any).reactions ?? (record as any).expand?.reactions ?? (record as any).reactions_list ?? (record as any).message_reactions;
      const updatedList = toggleReactionInList(rawReactions, emoji, currentUserId);

      try {
        await this.pb.collection(collectionName).update(messageId, {
          reactions: updatedList
        }, {
          expand: expandQuery,
          requestKey: null
        });
      } catch (err2) {
        await this.pb.collection(collectionName).update(messageId, {
          reactions: JSON.stringify(updatedList)
        }, {
          expand: expandQuery,
          requestKey: null
        });
      }

      return updatedList;
    } catch (err) {
      console.warn('Failed to toggle reaction on message:', err);
      throw err;
    }
  }

  async deleteChannel(channelId: string): Promise<boolean> {
    if (this.isDemo) {
      return true;
    }
    // Try direct deletion first (fast path)
    try {
      await this.pb.collection('channels').delete(channelId);
      return true;
    } catch (e1) {
      console.warn('Direct channel deletion failed, running background cleanup:', e1);
    }

    // Fallback parallel cleanup if direct delete failed due to FK references
    try {
      const msgs = await this.pb.collection('messages').getFullList({ filter: `channel = "${channelId}"` }).catch(() => []);
      if (msgs.length > 0) {
        await Promise.all(msgs.map((msg) => this.pb.collection('messages').delete(msg.id).catch(() => {})));
      }
    } catch (e) {
      console.warn('Error deleting channel messages:', e);
    }

    try {
      await this.pb.collection('channels').delete(channelId);
      return true;
    } catch (err) {
      console.warn('Final channel delete call resulted in error (may already be deleted):', err);
      return true;
    }
  }

  async deleteServer(serverId: string): Promise<boolean> {
    if (this.isDemo) {
      return true;
    }
    // Try direct deletion first (fast path)
    try {
      await this.pb.collection('servers').delete(serverId);
      return true;
    } catch (e1) {
      console.warn('Direct server deletion failed, running background cascading cleanup:', e1);
    }

    // Fallback parallel cleanup if direct delete failed due to FK constraints
    try {
      const channels = await this.pb.collection('channels').getFullList({ filter: `server = "${serverId}"` }).catch(() => []);
      await Promise.all(channels.map((ch) => this.deleteChannel(ch.id).catch(() => {})));

      const members = await this.pb.collection('server_members').getFullList({ filter: `server = "${serverId}"` }).catch(() => []);
      await Promise.all(members.map((m) => this.pb.collection('server_members').delete(m.id).catch(() => {})));

      const roles = await this.pb.collection('roles').getFullList({ filter: `server = "${serverId}"` }).catch(() => []);
      await Promise.all(roles.map((r) => this.pb.collection('roles').delete(r.id).catch(() => {})));

      const options = await this.pb.collection('server_options').getFullList({ filter: `server = "${serverId}"` }).catch(() => []);
      await Promise.all(options.map((o) => this.pb.collection('server_options').delete(o.id).catch(() => {})));
    } catch (e) {
      console.warn('Error during server cascading cleanup:', e);
    }

    try {
      await this.pb.collection('servers').delete(serverId);
      return true;
    } catch (err) {
      console.warn('Final server delete call resulted in error (may already be deleted):', err);
      return true;
    }
  }

  async searchUsers(query: string): Promise<User[]> {
    if (this.isDemo) {
      return [
        { id: 'demo-u1', username: 'john_doe', email: 'john@gmail.com', display_name: 'John Doe', role: 'user', status: 'online' },
        { id: 'demo-u2', username: 'mari_smith', email: 'mari@gmail.com', display_name: 'Mari Smith', role: 'user', status: 'away' }
      ];
    }
    try {
      const records = await this.pb.collection('users').getList(1, 25, {
        filter: `username ~ "${query}" || display_name ~ "${query}"`,
      });
      return records.items as any as User[];
    } catch (e) {
      console.warn('Failed to search PocketBase users:', e);
      return [];
    }
  }

  async fetchAllUsers(forceRefresh = false): Promise<User[]> {
    if (this.isDemo) return [];
    if (!this.usersCache || this.usersCache.length === 0) {
      this.getCachedUsers();
    }
    if (!forceRefresh && this.usersCache && this.usersCache.length > 0 && (Date.now() - this.lastUsersFetch < 120000)) {
      return this.usersCache;
    }
    if (this.usersFetchPromise) return this.usersFetchPromise;

    const request = (async (): Promise<User[]> => {
      try {
        const records = await this.pb.collection('users').getFullList({
          sort: '-created',
          requestKey: null
        });
        this.usersCache = records as any as User[];
        this.lastUsersFetch = Date.now();
        try {
          localStorage.setItem('cached_all_users', JSON.stringify(this.usersCache));
        } catch (err) {}
        return this.usersCache;
      } catch (e) {
        // A second users query is a schema compatibility fallback only. Do
        // not repeat a timed-out/offline request with a different pagination
        // shape; cached profiles remain sufficient for the read-only shell.
        if (!isSchemaCompatibilityError(e)) {
          if (this.usersCache) return this.usersCache;
          return [];
        }
        try {
          const pageRecords = await this.pb.collection('users').getList(1, 200, { requestKey: null });
          this.usersCache = pageRecords.items as any as User[];
          this.lastUsersFetch = Date.now();
          try {
            localStorage.setItem('cached_all_users', JSON.stringify(this.usersCache));
          } catch (err) {}
          return this.usersCache;
        } catch (innerErr) {
          if (this.usersCache) return this.usersCache;
          return [];
        }
      }
    })();

    this.usersFetchPromise = request;
    try {
      return await request;
    } finally {
      if (this.usersFetchPromise === request) {
        this.usersFetchPromise = null;
      }
    }
  }

  /**
   * Resolve only the profiles needed by a visible DM/member list.  The old
   * login path downloaded the entire users collection even when a user had a
   * single DM, which made a slow home connection block the first chat.  Keep
   * the existing directory cache as a fast path and coalesce identical ID
   * batches so concurrent panels share one request.
   */
  async fetchUsersByIds(userIds: string[]): Promise<User[]> {
    const ids = Array.from(new Set(userIds.map((id) => String(id || '').trim()).filter(Boolean)));
    if (ids.length === 0) return [];

    const cachedUsers = this.getCachedUsers();
    const cachedById = new Map(cachedUsers.map((user) => [user.id, user]));
    const missing = ids.filter((id) => !cachedById.has(id));
    if (missing.length === 0) {
      return ids.map((id) => cachedById.get(id)).filter(Boolean) as User[];
    }

    const key = ids.slice().sort().join(',');
    const existing = this.usersByIdsPromises.get(key);
    if (existing) return existing;

    const request = (async () => {
      try {
        // PocketBase accepts an OR filter over record IDs. Keep batches small
        // enough for proxy URL/filter limits while still avoiding one request
        // per DM.
        const fetched: User[] = [];
        for (let offset = 0; offset < missing.length; offset += 40) {
          const batch = missing.slice(offset, offset + 40);
          const filter = batch
            .map((id) => `id = "${id.replace(/"/g, '\\"')}"`)
            .join(' || ');
          const requestKey = `users:ids:${key}:${offset}`;
          const records = await this.withReadDeadline(
            () => this.pb.collection('users').getFullList({
              filter,
              requestKey,
            }),
            requestKey,
          );
          fetched.push(...(records as any as User[]));
        }

        const merged = new Map<string, User>(cachedUsers.map((user) => [user.id, user]));
        fetched.forEach((user) => merged.set(user.id, user));
        this.usersCache = Array.from(merged.values());
        this.lastUsersFetch = Date.now();
        try {
          localStorage.setItem('cached_all_users', JSON.stringify(this.usersCache));
        } catch (err) {}
        return ids.map((id) => merged.get(id)).filter(Boolean) as User[];
      } catch (error) {
        // A profile read is an enhancement. Never replace a usable cached DM
        // list with a broad fallback after a network/tunnel failure.
        // User profiles are enrichment data. Do not let a failed background
        // profile read change the v2 gateway availability indicator.
        return ids.map((id) => cachedById.get(id)).filter(Boolean) as User[];
      }
    })();

    this.usersByIdsPromises.set(key, request);
    try {
      return await request;
    } finally {
      if (this.usersByIdsPromises.get(key) === request) {
        this.usersByIdsPromises.delete(key);
      }
    }
  }

  async fetchUserById(userId: string): Promise<User | null> {
    if (this.isDemo) return null;
    if (this.usersCache) {
      const cached = this.usersCache.find((u) => u.id === userId);
      if (cached) return cached;
    }
    try {
      const record = await this.pb.collection('users').getOne(userId);
      const user = record as any as User;
      if (this.usersCache) {
        const idx = this.usersCache.findIndex((u) => u.id === userId);
        if (idx >= 0) this.usersCache[idx] = user;
        else this.usersCache.push(user);
      }
      return user;
    } catch (e) {
      console.warn(`Failed to fetch user by ID (${userId}):`, e);
      return null;
    }
  }

  async fetchAllServers(): Promise<Server[]> {
    if (this.isDemo) return [];
    try {
      const records = await this.pb.collection('servers').getFullList();
      return records as any as Server[];
    } catch (e) {
      return [];
    }
  }

  async fetchAppUpdates(channel: string = 'stable', platform: string = 'windows'): Promise<AppUpdateRecord[]> {
    if (this.isDemo) return [];
    try {
      const records = await this.pb.collection('app_updates').getFullList({
        filter: `published = true && platform = "${platform}" && channel = "${channel}"`,
        sort: '-created'
      });
      return records as any as AppUpdateRecord[];
    } catch (e) {
      return [];
    }
  }

  async kickMember(serverId: string, userId: string): Promise<boolean> {
    this.serverMembersSnapshotCache.delete(serverId);
    const leftAt = new Date().toISOString();
    localStorage.setItem(`is_member_${serverId}_${userId}`, 'false');
    localStorage.setItem(`membership_status_${serverId}_${userId}`, 'kicked');
    localStorage.setItem(`left_at_${serverId}_${userId}`, leftAt);

    if (this.serverMembersCache.has(serverId)) {
      const cached = this.serverMembersCache.get(serverId)!.get(userId);
      if (cached) {
        cached.is_member = false;
        cached.left_at = leftAt;
        cached.membership_status = 'kicked';
      }
    }

    if (this.isDemo) {
      window.dispatchEvent(new CustomEvent('server-member-updated', {
        detail: { serverId, userId, is_member: false, membership_status: 'kicked' }
      }));
      return true;
    }

    try {
      const record = await this.pb.collection('server_members').getFirstListItem(
        `server="${serverId}" && user="${userId}"`
      );
      if (record) {
        await this.pb.collection('server_members').update(record.id, {
          is_member: false,
          left_at: leftAt,
          membership_status: 'kicked'
        });
      }
    } catch (e) {
      console.warn('Failed to update kicked server member:', e);
    }

    window.dispatchEvent(new CustomEvent('server-member-updated', {
      detail: { serverId, userId, is_member: false, membership_status: 'kicked' }
    }));
    return true;
  }

  getPinnedMessageIds(channelId: string): string[] {
    if (this.pinnedCache.has(channelId)) {
      return this.pinnedCache.get(channelId)!;
    }
    try {
      const stored = localStorage.getItem(`pinned_msgs_${channelId}`);
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  }

  async fetchPinnedMessageIds(channelId: string): Promise<string[]> {
    if (this.isDemo) {
      return this.getPinnedMessageIds(channelId);
    }
    // DMs do not support pinned messages
    if (!channelId || channelId.startsWith('dm-') || channelId.startsWith('chat-') || channelId.startsWith('private-')) {
      return [];
    }
    try {
      const record = await this.pb.collection('channels').getOne(channelId);
      let rawPins = (record as any).Pinned_messages || (record as any).pinned_messages || [];
      if (!Array.isArray(rawPins)) rawPins = [];
      const ids: string[] = rawPins.map((item: any) => typeof item === 'string' ? item : item?.id).filter(Boolean);
      this.pinnedCache.set(channelId, ids);
      try {
        localStorage.setItem(`pinned_msgs_${channelId}`, JSON.stringify(ids));
      } catch (e) {}
      return ids;
    } catch (e) {
      return this.getPinnedMessageIds(channelId);
    }
  }

  async togglePinMessage(channelId: string, messageId: string, isDm: boolean = false): Promise<boolean> {
    if (isDm || !channelId || channelId.startsWith('dm-') || channelId.startsWith('chat-') || channelId.startsWith('private-')) {
      return false;
    }

    if (this.isDemo) {
      const pinned = this.getPinnedMessageIds(channelId);
      const isPinned = pinned.includes(messageId);
      const updated = isPinned ? pinned.filter((id) => id !== messageId) : [...pinned, messageId];
      this.pinnedCache.set(channelId, updated);
      try {
        localStorage.setItem(`pinned_msgs_${channelId}`, JSON.stringify(updated));
      } catch (e) {}
      return !isPinned;
    }

    try {
      const channelRec = await this.pb.collection('channels').getOne(channelId);
      let rawPins = (channelRec as any).Pinned_messages || (channelRec as any).pinned_messages || [];
      if (!Array.isArray(rawPins)) rawPins = [];
      const existing: string[] = rawPins.map((item: any) => typeof item === 'string' ? item : item?.id).filter(Boolean);

      const isPinned = existing.includes(messageId);
      const updatedPins = isPinned ? existing.filter((id) => id !== messageId) : [...existing, messageId];

      try {
        await this.pb.collection('channels').update(channelId, {
          Pinned_messages: updatedPins
        });
      } catch (e1) {
        try {
          await this.pb.collection('channels').update(channelId, {
            pinned_messages: updatedPins
          });
        } catch (e2) {}
      }

      this.pinnedCache.set(channelId, updatedPins);
      try {
        localStorage.setItem(`pinned_msgs_${channelId}`, JSON.stringify(updatedPins));
      } catch (e) {}

      return !isPinned;
    } catch (e) {
      return false;
    }
  }

  // --- DEDICATED DIRECT MESSAGES & PRIVATE CHAT MEMBERS ---

  async notifyServerUsersDeleted(serverId: string, serverName: string, senderId?: string, lang: string = 'en'): Promise<void> {
    if (this.isDemo) return;
    try {
      const members = await this.pb.collection('server_members').getFullList({
        filter: `server = "${serverId}"`
      }).catch(() => []);

      const targetUserIds = new Set<string>();
      for (const m of members) {
        if (m.user) targetUserIds.add(m.user);
      }

      // Also notify all users if members filter is empty
      if (targetUserIds.size === 0) {
        const allUsers = await this.fetchAllUsers();
        for (const u of allUsers) {
          targetUserIds.add(u.id);
        }
      }

      const notifMessage = lang === 'ar'
        ? `تم حذف السيرفر "${serverName}" بواسطة مسؤول ولن يكون متاحاً بعد الآن.`
        : `Server "${serverName}" has been deleted by an admin and won't be accessible anymore.`;

      const notifItem: NotificationItem = {
        id: `notif-del-${serverId}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        type: 'system',
        server_id: serverId,
        sender_id: senderId || 'admin',
        sender_name: 'Admin / System',
        message: notifMessage,
        created: new Date().toISOString(),
        read: false
      };

      for (const userId of targetUserIds) {
        await this.addNotificationToUser(userId, notifItem).catch(() => {});
      }
    } catch (e) {
      console.warn('Failed to notify users of server deletion:', e);
    }
  }

  async getUserPrivateChatServers(): Promise<any[]> {
    if (this.isDemo) return [];
    const currentId = this.pb.authStore.model?.id;
    if (!currentId) return [];

    // 0. Check fast in-memory / local storage cache first. This list is also
    // the safe result for a transport outage; do not turn a failed read into
    // a sequence of broader scans.
    let cachedServers: any[] = [];
    try {
      const raw = localStorage.getItem(`cached_pcs_${currentId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          cachedServers = parsed;
          parsed.forEach((s: any) => {
            const users = s.users || [s.user1, s.user2].filter(Boolean);
            const otherId = users.find((u: string) => u !== currentId) || users[0];
            if (otherId) this.privateChatServerCache.set(otherId, s);
            this.privateChatServerCache.set(s.id, s);
          });
        }
      }
    } catch (e) {}

    // 1. Query the normalized membership collection first. This is indexed
    // and avoids scanning the multiselect `users` relation for every login.
    let membershipSchemaAvailable = true;
    try {
      const myMemberships = await this.withReadDeadline(
        () => this.pb.collection('private_chat_members').getFullList({
          filter: `user = "${currentId}"`,
          requestKey: 'bootstrap:dms:members',
        }),
        'bootstrap:dms:members',
      );
      const serverIds = Array.from(new Set(myMemberships.map((m) => m.chat_server).filter(Boolean)));
      if (serverIds.length === 0) return [];
      // Fetch the records in bounded batches instead of issuing one request per
      // DM. The membership query already gives us the complete ID set, so an
      // indexed OR filter is both faster and gentler on PocketBase.
      const servers: any[] = [];
      for (let offset = 0; offset < serverIds.length; offset += 40) {
        const batch = serverIds.slice(offset, offset + 40);
        const filter = batch
          .map((id) => `id = "${String(id).replace(/"/g, '\\"')}"`)
          .join(' || ');
        const page = await this.withReadDeadline(
          () => this.pb.collection('private_chat_servers').getList(1, batch.length, {
            filter,
            requestKey: `bootstrap:dms:servers:${offset}`,
          }),
          `bootstrap:dms:servers:${offset}`,
        );
        servers.push(...(page.items || []));
      }
      const validServers = servers.filter(Boolean);
      validServers.forEach((s: any) => {
        const users = s.users || [s.user1, s.user2].filter(Boolean);
        const otherId = users.find((u: string) => u !== currentId) || users[0];
        if (otherId) this.privateChatServerCache.set(otherId, s);
        this.privateChatServerCache.set(s.id, s);
      });
      try { localStorage.setItem(`cached_pcs_${currentId}`, JSON.stringify(validServers)); } catch (e) {}
      return validServers;
    } catch (membershipError) {
      if (!isSchemaCompatibilityError(membershipError)) {
        return cachedServers;
      }
      membershipSchemaAvailable = false;
    }

    if (!membershipSchemaAvailable) {
      // 2. Compatibility fallback for installations predating
      // private_chat_members. It is only reached for a confirmed schema
      // mismatch, never for a network/530/5xx error.
      let list: any[] = [];
      try {
        list = await this.withReadDeadline(
          () => this.pb.collection('private_chat_servers').getFullList({
            filter: `users ~ "${currentId}"`,
            requestKey: 'bootstrap:dms:legacy-users',
          }),
          'bootstrap:dms:legacy-users',
        );
      } catch (usersFilterErr) {
        if (!isSchemaCompatibilityError(usersFilterErr)) {
          return cachedServers;
        }
        try {
          list = await this.withReadDeadline(
            () => this.pb.collection('private_chat_servers').getFullList({
              filter: `user1 = "${currentId}" || user2 = "${currentId}"`,
              requestKey: 'bootstrap:dms:legacy-columns',
            }),
            'bootstrap:dms:legacy-columns',
          );
        } catch (userColumnsErr) {
          if (!isSchemaCompatibilityError(userColumnsErr)) {
            return cachedServers;
          }
        }
      }
      list.forEach((s: any) => {
        const users = s.users || [s.user1, s.user2].filter(Boolean);
        const otherId = users.find((u: string) => u !== currentId) || users[0];
        if (otherId) this.privateChatServerCache.set(otherId, s);
        this.privateChatServerCache.set(s.id, s);
      });
      try { localStorage.setItem(`cached_pcs_${currentId}`, JSON.stringify(list)); } catch (e) {}
      return list;
    }

    return cachedServers;
  }

  /** Coalesce concurrent DM opens so two UI paths cannot create duplicate chats. */
  async getOrCreatePrivateChatServer(recipientId: string): Promise<any> {
    if (!recipientId) throw new Error('Recipient is required');
    const inFlight = this.privateChatServerPromises.get(recipientId);
    if (inFlight) return inFlight;
    const request = this.withReadDeadline(
      () => this.getOrCreatePrivateChatServerUncoalesced(recipientId),
      `pcs:${recipientId}`,
      8000,
    );
    this.privateChatServerPromises.set(recipientId, request);
    try {
      return await request;
    } finally {
      if (this.privateChatServerPromises.get(recipientId) === request) {
        this.privateChatServerPromises.delete(recipientId);
      }
    }
  }

  private async getOrCreatePrivateChatServerUncoalesced(recipientId: string): Promise<any> {
    if (this.isDemo) {
      return { id: 'demo-chat-server-' + recipientId, users: [this.getCurrentUser()?.id, recipientId] };
    }
    const currentId = this.pb.authStore.model?.id;
    if (!currentId) throw new Error('Not logged in');

    const cachedServer = this.getCachedPrivateChatServer(recipientId);
    if (cachedServer) {
      return cachedServer;
    }

    // 1. Check existing private_chat_servers for recipient & current user.
    // The user1/user2 query is a schema fallback only; a network/5xx error
    // must stop here so an outage can never create a duplicate chat server.
    let existingList: any[] = [];
    try {
      existingList = await this.pb.collection('private_chat_servers').getFullList({
        filter: `users ~ "${currentId}" && users ~ "${recipientId}"`,
        requestKey: null
      });
    } catch (usersError) {
      if (!isSchemaCompatibilityError(usersError)) throw usersError;
      try {
        existingList = await this.pb.collection('private_chat_servers').getFullList({
          filter: `(user1 = "${currentId}" && user2 = "${recipientId}") || (user1 = "${recipientId}" && user2 = "${currentId}")`,
          requestKey: null
        });
      } catch (userColumnsError) {
        if (!isSchemaCompatibilityError(userColumnsError)) throw userColumnsError;
        existingList = [];
      }
    }

    if (existingList.length > 0) {
      const s = existingList[0];
      this.setCachedPrivateChatServer(recipientId, s);
      return s;
    }

    // 2. Parallel membership check. Memberships are a compatibility fallback
    // for deployments that do not expose the multiselect users relation.
    try {
      const [myMemberships, otherMemberships] = await Promise.all([
        this.pb.collection('private_chat_members').getFullList({
          filter: `user = "${currentId}"`,
          requestKey: null
        }),
        this.pb.collection('private_chat_members').getFullList({
          filter: `user = "${recipientId}"`,
          requestKey: null
        })
      ]);
      const myServerIds = new Set(myMemberships.map((m) => m.chat_server));
      const sharedMembership = otherMemberships.find((m) => myServerIds.has(m.chat_server));
      if (sharedMembership) {
        const chatServerRecord = await this.pb.collection('private_chat_servers').getOne(sharedMembership.chat_server, { requestKey: null });
        if (chatServerRecord) {
          this.setCachedPrivateChatServer(recipientId, chatServerRecord);
          return chatServerRecord;
        }
      }
    } catch (membershipError) {
      if (!isSchemaCompatibilityError(membershipError)) throw membershipError;
      // An old installation may not have private_chat_members. Use the
      // bounded compatibility scan below only in that case.
    }

    // 3. Bounded fallback scan matching servers. It is intentionally not
    // attempted after a transport error.
    let matched: any;
    try {
      matched = await this.pb.collection('private_chat_servers').getList(1, 20, {
        requestKey: null
      });
    } catch (scanError) {
      if (!isSchemaCompatibilityError(scanError)) throw scanError;
      matched = { items: [] };
    }
    const found = (matched.items || []).find((cs: any) => {
      const u = cs.users || [];
      return (u.includes(currentId) && u.includes(recipientId)) ||
             (cs.user1 === currentId && cs.user2 === recipientId) ||
             (cs.user1 === recipientId && cs.user2 === currentId);
    });
    if (found) {
      this.setCachedPrivateChatServer(recipientId, found);
      return found;
    }

    // 4. Only if NO existing server is found, create a new server
    const newChatServer = await this.pb.collection('private_chat_servers').create({
      users: [currentId, recipientId],
      user1: currentId,
      user2: recipientId,
      private_chat_options: {}
    }, { requestKey: null });

    this.setCachedPrivateChatServer(recipientId, newChatServer);

    // Non-blocking membership creation
    Promise.all([
      this.pb.collection('private_chat_members').create({ user: currentId, chat_server: newChatServer.id }, { requestKey: null }).catch(() => {}),
      this.pb.collection('private_chat_members').create({ user: recipientId, chat_server: newChatServer.id }, { requestKey: null }).catch(() => {})
    ]).catch(() => {});

    return newChatServer;
  }

  async fetchDirectMessages(recipientId: string, chatServerId?: string, forceRefresh: boolean = false): Promise<Message[]> {
    if (this.isDemo) return [];
    const currentId = this.pb.authStore.model?.id;
    try {
      let targetServerId = chatServerId;
      if (!targetServerId) {
        const server = await this.getOrCreatePrivateChatServer(recipientId);
        targetServerId = server.id;
      }

      if (targetServerId && !forceRefresh && this.dmMessagesCache.has(targetServerId)) {
        const cached = this.dmMessagesCache.get(targetServerId)!;
        // Background sync
        const filterStr = currentId && recipientId
          ? `chat_server = "${targetServerId}" || (sender="${currentId}" && user="${recipientId}") || (sender="${recipientId}" && user="${currentId}")`
          : `chat_server = "${targetServerId}"`;

        this.pb.collection('private_messages').getFullList({
          filter: filterStr,
          sort: 'created',
          expand: 'sender,reply_to,attachments(message),private_attachments(message)',
          requestKey: null
        }).then((records) => {
          const raw = records as any as Message[];
          const processed = raw.map((m) => {
            const pubAtts = m.expand?.['attachments(message)'] || [];
            const privAtts = m.expand?.['private_attachments(message)'] || [];
            const combined = normalizeAttachmentRecords(pubAtts, privAtts);
            if (combined.length > 0) {
              if (!m.expand) m.expand = {};
              m.expand['attachments(message)'] = combined;
              m.expand['private_attachments(message)'] = combined;
            }
            return m;
          }).filter((m) => {
            if (m.deleted || Boolean(m.deleted_at && m.deleted_at !== '') || MessageDeletionService.isMessageDeleted(m.id)) {
              return false;
            }
            return true;
          });
          this.dmMessagesCache.set(targetServerId!, processed);
        }).catch(() => {});
        return cached;
      }

      const filterStr = currentId && recipientId
        ? `chat_server = "${targetServerId}" || (sender="${currentId}" && user="${recipientId}") || (sender="${recipientId}" && user="${currentId}")`
        : `chat_server = "${targetServerId}"`;

      const records = await this.pb.collection('private_messages').getFullList({
        filter: filterStr,
        sort: 'created',
        expand: 'sender,reply_to,attachments(message),private_attachments(message)',
        requestKey: null
      });
      const raw = records as any as Message[];
      const processed = raw.map((m) => {
        const pubAtts = m.expand?.['attachments(message)'] || [];
        const privAtts = m.expand?.['private_attachments(message)'] || [];
        const combined = normalizeAttachmentRecords(pubAtts, privAtts);
        if (combined.length > 0) {
          if (!m.expand) m.expand = {};
          m.expand['attachments(message)'] = combined;
          m.expand['private_attachments(message)'] = combined;
        }
        return m;
      }).filter((m) => {
        if (m.deleted || Boolean(m.deleted_at && m.deleted_at !== '') || MessageDeletionService.isMessageDeleted(m.id)) {
          return false;
        }
        return true;
      });

      if (targetServerId) {
        this.dmMessagesCache.set(targetServerId, processed);
      }
      return processed;
    } catch (err) {
      if (!currentId || !recipientId) return [];
      try {
        const fallback = await this.pb.collection('private_messages').getFullList({
          filter: `(sender="${currentId}" && user="${recipientId}") || (sender="${recipientId}" && user="${currentId}")`,
          sort: 'created',
          expand: 'sender,reply_to,attachments(message),private_attachments(message)',
          requestKey: null
        });
        const raw = fallback as any as Message[];
        return raw.map((m) => {
          const pubAtts = m.expand?.['attachments(message)'] || [];
          const privAtts = m.expand?.['private_attachments(message)'] || [];
          const combined = normalizeAttachmentRecords(pubAtts, privAtts);
          if (combined.length > 0) {
            if (!m.expand) m.expand = {};
            m.expand['attachments(message)'] = combined;
            m.expand['private_attachments(message)'] = combined;
          }
          return m;
        }).filter((m) => {
          if (m.deleted || Boolean(m.deleted_at && m.deleted_at !== '') || MessageDeletionService.isMessageDeleted(m.id)) {
            return false;
          }
          return true;
        });
      } catch (err2) {
        return [];
      }
    }
  }

  async sendDirectMessage(recipientId: string, content: string, replyToId?: string, chatServerId?: string, hasAttachment: boolean = false): Promise<Message> {
    if (this.isDemo) {
      return {
        id: 'dm-' + Math.random().toString(36).substr(2, 9),
        content,
        sender: this.getCurrentUser()?.id || '',
        has_attachment: hasAttachment,
        created: new Date().toISOString()
      } as any;
    }
    const currentId = this.pb.authStore.model?.id;
    let targetServerId = chatServerId;
    if (!targetServerId) {
      const server = await this.getOrCreatePrivateChatServer(recipientId);
      targetServerId = server.id;
    }

    const data: any = {
      chat_server: targetServerId,
      sender: currentId,
      user: currentId,
      content: content.trim() === '' ? '  ' : content,
      has_attachment: hasAttachment
    };
    if (replyToId) {
      data.reply_to = replyToId;
    }

    const record = await this.pb.collection('private_messages').create(data, {
      expand: 'sender,reply_to'
    });

    const msg = record as any as Message;
    this.cacheMessageRecord(msg);
    if (!msg.expand?.sender && this.getCurrentUser()) {
      if (!msg.expand) msg.expand = {};
      msg.expand.sender = this.getCurrentUser()!;
    }

    if (targetServerId) {
      const existing = this.dmMessagesCache.get(targetServerId) || [];
      if (!existing.some((m) => m.id === msg.id)) {
        this.dmMessagesCache.set(targetServerId, [...existing, msg]);
      }
    }

    // Broadcast DM created event over WebSocket / BroadcastChannel for instant delivery
    try {
      wsService.send({
        type: 'message_delivery',
        action: 'create',
        record: msg,
        channelId: targetServerId,
        userId: currentId
      });
    } catch (wsErr) {}

    return msg;
  }

  private privateMessageListeners = new Set<{ chatServerId: string; callback: (event: any) => void }>();
  private privateMessagesSubscribed = false;
  private privateAttachmentsSubscribed = false;

  private setupPrivateMessagesSubscription() {
    if (this.privateMessagesSubscribed || this.isDemo || !this.pb.authStore.isValid || !this.pb.authStore.token) return;
    this.privateMessagesSubscribed = true;

    try {
      this.pb.collection('private_messages').subscribe('*', (e) => {
        // As with public messages, deliver one event only. This avoids the
        // raw+expanded+delayed fetch waterfall that previously amplified DM
        // traffic on every create.
        this.privateMessageListeners.forEach(({ chatServerId, callback }) => {
          if (chatServerId === '*' || e.record?.chat_server === chatServerId) {
            try {
              const record = e.record ? { ...e.record, expand: e.record.expand || {} } : e.record;
              this.cacheMessageRecord(record as unknown as Message);
              callback({ ...e, record });
            } catch (cbErr) {}
          }
        });
      }).catch((err) => {
        this.privateMessagesSubscribed = false;
        if (!this.pb.authStore.isValid || !this.pb.authStore.token) return;
        if (this.privateMessageRetryTimeout) clearTimeout(this.privateMessageRetryTimeout);
        this.privateMessageRetryTimeout = setTimeout(() => {
          if (this.privateMessageListeners.size > 0 && !this.privateMessagesSubscribed && this.pb.authStore.isValid && this.pb.authStore.token) {
            this.setupPrivateMessagesSubscription();
          }
        }, 5000);
      });
    } catch (e) {
      this.privateMessagesSubscribed = false;
      if (!this.pb.authStore.isValid || !this.pb.authStore.token) return;
      if (this.privateMessageRetryTimeout) clearTimeout(this.privateMessageRetryTimeout);
      this.privateMessageRetryTimeout = setTimeout(() => {
        if (this.privateMessageListeners.size > 0 && !this.privateMessagesSubscribed && this.pb.authStore.isValid && this.pb.authStore.token) {
          this.setupPrivateMessagesSubscription();
        }
      }, 5000);
    }

    if (!this.privateAttachmentsSubscribed && this.pb.authStore.isValid && this.pb.authStore.token) {
      this.privateAttachmentsSubscribed = true;
      try {
        this.pb.collection('private_attachments').subscribe('*', (e) => {
          const attachment = e.record;
          const messageId = attachment?.message;
          if (!messageId) return;
          const parent = this.messageRecordCache.get(messageId);
          if (!parent) return;
          const expanded = parent.expand || {};
          const nextAttachments = normalizeAttachmentRecords(
            expanded['attachments(message)'] || [],
            [...(expanded['private_attachments(message)'] || []), attachment],
          );
          const record = {
            ...parent,
            has_attachment: true,
            expand: {
              ...expanded,
              'attachments(message)': nextAttachments,
              'private_attachments(message)': nextAttachments,
              attachments_via_message: nextAttachments,
              private_attachments_via_message: nextAttachments,
            },
          } as Message;
          this.cacheMessageRecord(record);
          this.privateMessageListeners.forEach(({ chatServerId, callback }) => {
            if (chatServerId === '*' || (record as any).chat_server === chatServerId) {
              try { callback({ action: 'update', record }); } catch (cbErr) {}
            }
          });
        }).catch((err) => {
          this.privateAttachmentsSubscribed = false;
        });
      } catch (err) {
        this.privateAttachmentsSubscribed = false;
      }
    }
  }

  subscribeToPrivateMessages(chatServerId: string, callback: (event: any) => void): () => void {
    if (this.isDemo) return () => {};

    const listenerObj = { chatServerId, callback };
    this.privateMessageListeners.add(listenerObj);
    if (this.pb.authStore.isValid && this.pb.authStore.token) {
      this.setupPrivateMessagesSubscription();
    }

    return () => {
      this.privateMessageListeners.delete(listenerObj);
      if (this.privateMessageListeners.size === 0) {
        if (this.privateMessageRetryTimeout) {
          clearTimeout(this.privateMessageRetryTimeout);
          this.privateMessageRetryTimeout = null;
        }
        this.privateMessagesSubscribed = false;
        try {
          this.pb.collection('private_messages').unsubscribe('*').catch(() => {});
        } catch (e) {}
      }
    };
  }

  // --- USER NOTIFICATIONS FIELD SYNC ---

  async addNotificationToUser(targetUserId: string, notification: NotificationItem): Promise<void> {
    if (this.isDemo || !targetUserId) return;
    try {
      const userRecord = await this.pb.collection('users').getOne(targetUserId);
      let existingNotifications: NotificationItem[] = [];
      if (userRecord.notifications) {
        if (typeof userRecord.notifications === 'string') {
          try {
            existingNotifications = JSON.parse(userRecord.notifications);
          } catch (e) {
            existingNotifications = [];
          }
        } else if (Array.isArray(userRecord.notifications)) {
          existingNotifications = userRecord.notifications;
        }
      }

      // Avoid duplicate notification IDs and keep existing read & unread notifications up to 50 items
      const filtered = existingNotifications.filter(n => n.id !== notification.id);
      const updated = [notification, ...filtered].slice(0, 50);

      await this.pb.collection('users').update(targetUserId, {
        notifications: updated
      });
    } catch (err) {
      console.warn('Failed to add notification to user:', err);
    }
  }

  async updateUserNotifications(userId: string, notifications: NotificationItem[]): Promise<void> {
    if (this.isDemo || !userId) return;
    try {
      const cleanNotifications = notifications.slice(0, 50);
      await this.pb.collection('users').update(userId, {
        notifications: cleanNotifications
      });
    } catch (err) {
      console.warn('Failed to update user notifications in database:', err);
    }
  }

  async getUserNotifications(userId: string): Promise<NotificationItem[]> {
    if (this.isDemo || !userId) return [];
    try {
      const userRecord = await this.pb.collection('users').getOne(userId);
      if (userRecord.notifications) {
        let list: NotificationItem[] = [];
        if (typeof userRecord.notifications === 'string') {
          try {
            list = JSON.parse(userRecord.notifications);
          } catch (e) {
            list = [];
          }
        } else if (Array.isArray(userRecord.notifications)) {
          list = userRecord.notifications;
        }
        return list.slice(0, 50);
      }
    } catch (err) {
      // Return empty notifications fallback silently
    }
    return [];
  }

  async cancelFriendRequest(senderId: string, targetUserId: string): Promise<void> {
    if (this.isDemo || !senderId || !targetUserId) return;
    try {
      // 1. Clean up Sender's profile settings (remove outgoing request)
      const senderRecord = await this.pb.collection('users').getOne(senderId);
      if (senderRecord) {
        let sSettings = senderRecord.settings;
        if (typeof sSettings === 'string') {
          try { sSettings = JSON.parse(sSettings); } catch { sSettings = {}; }
        }
        if (!sSettings) sSettings = {};

        const currentReqs = sSettings.friend_requests || [];
        const updatedReqs = currentReqs.filter((r: any) => r.targetId !== targetUserId && r.id !== targetUserId);
        sSettings.friend_requests = updatedReqs;

        await this.pb.collection('users').update(senderId, {
          settings: sSettings
        });
      }

      // 2. Clean up Target/Recipient's profile settings & notifications (remove incoming request & notification)
      try {
        const targetRecord = await this.pb.collection('users').getOne(targetUserId);
        if (targetRecord) {
          let tSettings = targetRecord.settings;
          if (typeof tSettings === 'string') {
            try { tSettings = JSON.parse(tSettings); } catch { tSettings = {}; }
          }
          if (!tSettings) tSettings = {};

          const tReqs = tSettings.friend_requests || [];
          const updatedTReqs = tReqs.filter((r: any) => r.targetId !== senderId && r.id !== senderId);
          tSettings.friend_requests = updatedTReqs;

          // Clean up notifications for target user
          let tNotifs: NotificationItem[] = [];
          if (targetRecord.notifications) {
            if (typeof targetRecord.notifications === 'string') {
              try { tNotifs = JSON.parse(targetRecord.notifications); } catch { tNotifs = []; }
            } else if (Array.isArray(targetRecord.notifications)) {
              tNotifs = targetRecord.notifications;
            }
          }

          const updatedNotifs = tNotifs.filter(
            (n) => !(n.type === 'friend_request' && n.sender_id === senderId)
          );

          await this.pb.collection('users').update(targetUserId, {
            settings: tSettings,
            notifications: updatedNotifs
          });
        }
      } catch (err) {
        console.warn('Target user cleanup during friend request cancellation:', err);
      }
    } catch (err) {
      console.error('Failed to cancel friend request:', err);
      throw err;
    }
  }

  // --- APP CONFIG & DATABASE URL SYNC ---

  async updateAppConfigDatabaseUrl(url: string): Promise<void> {
    if (this.isDemo) return;
    try {
      const records = await this.pb.collection('app_config').getFullList();
      if (records.length > 0) {
        const first = records[0];
        let langData: any = {};
        if (first.language_data) {
          langData = typeof first.language_data === 'string' ? JSON.parse(first.language_data) : first.language_data;
        }
        langData.db_url = url;
        await this.pb.collection('app_config').update(first.id, {
          language_data: langData
        });
      } else {
        await this.pb.collection('app_config').create({
          language_data: { db_url: url },
          language: 'en'
        });
      }
    } catch (e) {
      console.warn('Failed to update app_config database URL:', e);
    }
  }

  // --- ADMIN GLOBAL APP THEME & LAYOUT SETTINGS ---

  async getAdminAppSettings(): Promise<any> {
    if (this.isDemo) return null;
    try {
      let records = await this.pb.collection('app_settings_admin').getFullList({ filter: 'key = "admin_settings"' }).catch(() => []);
      if (records.length === 0) {
        records = await this.pb.collection('app_settings_admin').getFullList().catch(() => []);
      }
      if (records.length > 0) {
        const item = records[0];
        const raw = item.admin_settings ?? item.config_data;
        if (raw !== undefined && raw !== null) {
          return typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
        return item;
      }
    } catch (e) {
      // Fallback silently if admin settings collection not available
    }
    return null;
  }

  async saveAdminAppSettings(data: any): Promise<boolean> {
    if (this.isDemo) return false;
    try {
      let records = await this.pb.collection('app_settings_admin').getFullList({ filter: 'key = "admin_settings"' }).catch(() => []);
      if (records.length === 0) {
        records = await this.pb.collection('app_settings_admin').getFullList().catch(() => []);
      }

      const fullPayload = {
        key: 'admin_settings',
        admin_settings: data,
        config_data: JSON.stringify(data),
      };

      if (records.length > 0) {
        const recordId = records[0].id;
        try {
          await this.pb.collection('app_settings_admin').update(recordId, fullPayload);
        } catch (err) {
          try {
            await this.pb.collection('app_settings_admin').update(recordId, { key: 'admin_settings', admin_settings: data });
          } catch (err2) {
            await this.pb.collection('app_settings_admin').update(recordId, { admin_settings: data });
          }
        }
      } else {
        try {
          await this.pb.collection('app_settings_admin').create(fullPayload);
        } catch (err) {
          try {
            await this.pb.collection('app_settings_admin').create({ key: 'admin_settings', admin_settings: data });
          } catch (err2) {
            await this.pb.collection('app_settings_admin').create({ admin_settings: data });
          }
        }
      }
      return true;
    } catch (e) {
      console.warn('Failed saving app_settings_admin:', e);
      return false;
    }
  }

  subscribeAdminAppSettings(callback: (data: any) => void): () => void {
    if (this.isDemo) return () => {};
    let unsubFunc: any = null;
    this.pb.collection('app_settings_admin').subscribe('*', (e: any) => {
      if (e && e.record) {
        const raw = e.record.admin_settings ?? e.record.config_data;
        if (raw !== undefined && raw !== null) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          callback(parsed);
        }
      }
    }).then((unsub) => {
      unsubFunc = unsub;
    }).catch(() => {});

    return () => {
      if (unsubFunc) unsubFunc();
      this.pb.collection('app_settings_admin').unsubscribe('*').catch(() => {});
    };
  }

  // --- SERVER ROLES & MEMBERS ---

  async fetchServerRoles(serverId: string, options: { forceRefresh?: boolean } = {}): Promise<ServerRole[]> {
    if (this.isDemo || !serverId) return [];
    const cached = this.serverRolesSnapshotCache.get(serverId);
    if (!options.forceRefresh && cached && Date.now() - cached.timestamp < 30_000) {
      return cached.items;
    }
    const pending = this.serverRolesPromises.get(serverId);
    if (pending) return pending;
    const request = this.fetchServerRolesUncached(serverId)
      .then((items) => {
        this.serverRolesSnapshotCache.set(serverId, { items, timestamp: Date.now() });
        return items;
      })
      .finally(() => {
        if (this.serverRolesPromises.get(serverId) === request) {
          this.serverRolesPromises.delete(serverId);
        }
      });
    this.serverRolesPromises.set(serverId, request);
    return request;
  }

  private async fetchServerRolesUncached(serverId: string): Promise<ServerRole[]> {
    if (this.isDemo || !serverId) return [];

    let storedLocal: ServerRole[] = [];
    try {
      const stored = localStorage.getItem(`server_roles_${serverId}`);
      if (stored) storedLocal = JSON.parse(stored);
    } catch (err) {}

    try {
      const records = await this.pb.collection('roles').getFullList({
        filter: `server = "${serverId}"`,
        sort: '-created'
      });
      const remoteRoles: ServerRole[] = records.map((r: any) => {
        const localMatch = storedLocal.find((item) => item.id === r.id || item.name === r.name);

        let roleSettings: any = {};
        if (r.role_settings) {
          if (typeof r.role_settings === 'string') {
            try {
              roleSettings = JSON.parse(r.role_settings);
            } catch (e) {}
          } else if (typeof r.role_settings === 'object' && r.role_settings !== null) {
            roleSettings = r.role_settings;
          }
        }

        const resolvedEmoji = roleSettings.emoji || r.emoji || r.icon || localMatch?.emoji || '🛡️';
        const resolvedColor = roleSettings.color || r.color || localMatch?.color || '#3b82f6';

        let resolvedPermissions = roleSettings.permissions;
        if (!resolvedPermissions) {
          if (typeof r.permissions === 'string') {
            try { resolvedPermissions = JSON.parse(r.permissions); } catch (e) {}
          } else if (r.permissions && typeof r.permissions === 'object') {
            resolvedPermissions = r.permissions;
          } else {
            resolvedPermissions = localMatch?.permissions || {};
          }
        }

        return {
          id: r.id,
          server: r.server,
          name: r.name,
          emoji: resolvedEmoji,
          color: resolvedColor,
          permissions: resolvedPermissions || {},
          role_settings: roleSettings,
          created: r.created
        };
      });

      const merged: ServerRole[] = [...remoteRoles];
      for (const loc of storedLocal) {
        if (!merged.some((item) => item.id === loc.id || item.name === loc.name)) {
          merged.push(loc);
        }
      }

      try {
        localStorage.setItem(`server_roles_${serverId}`, JSON.stringify(merged));
      } catch (err) {}

      return merged;
    } catch (e) {
      return storedLocal;
    }
  }

  async createServerRole(serverId: string, roleData: Partial<ServerRole>): Promise<ServerRole> {
    const emoji = roleData.emoji || '🛡️';
    const color = roleData.color || '#3b82f6';
    const permissions = roleData.permissions || { send_messages: true };

    const roleSettingsObj = {
      emoji,
      color,
      permissions,
      ...(roleData.role_settings || {})
    };

    const newRole: ServerRole = {
      id: 'role-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      server: serverId,
      name: roleData.name || 'New Role',
      emoji,
      color,
      permissions,
      role_settings: roleSettingsObj,
      created: new Date().toISOString()
    };

    try {
      const stored = localStorage.getItem(`server_roles_${serverId}`);
      const storedLocal: ServerRole[] = stored ? JSON.parse(stored) : [];
      localStorage.setItem(`server_roles_${serverId}`, JSON.stringify([newRole, ...storedLocal]));
    } catch (err) {}

    if (!this.isDemo) {
      try {
        const recordPayload: any = {
          server: serverId,
          name: newRole.name,
          emoji: newRole.emoji,
          color: newRole.color,
          permissions: JSON.stringify(newRole.permissions),
          role_settings: roleSettingsObj
        };
        const record = await this.pb.collection('roles').create(recordPayload);
        newRole.id = record.id;
      } catch (e) {
        console.warn('Failed to save role to PocketBase collection, attempting fallback:', e);
        try {
          const fallbackPayload: any = {
            server: serverId,
            name: newRole.name,
            role_settings: JSON.stringify(roleSettingsObj)
          };
          const record = await this.pb.collection('roles').create(fallbackPayload);
          newRole.id = record.id;
        } catch (e2) {
          console.warn('Fallback create also failed:', e2);
        }
      }
    }

    this.serverRolesSnapshotCache.delete(serverId);
    const current = await this.fetchServerRoles(serverId, { forceRefresh: true });
    return current.find((r) => r.id === newRole.id || r.name === newRole.name) || newRole;
  }

  async updateServerRole(serverId: string, roleId: string, roleData: Partial<ServerRole>): Promise<ServerRole> {
    let existingRole: ServerRole | undefined;
    try {
      const stored = localStorage.getItem(`server_roles_${serverId}`);
      if (stored) {
        const storedLocal: ServerRole[] = JSON.parse(stored);
        existingRole = storedLocal.find((r) => r.id === roleId || r.name === roleData.name);
      }
    } catch (err) {}

    const updatedEmoji = roleData.emoji || existingRole?.emoji || existingRole?.role_settings?.emoji || '🛡️';
    const updatedColor = roleData.color || existingRole?.color || existingRole?.role_settings?.color || '#3b82f6';
    const updatedPermissions = roleData.permissions || existingRole?.permissions || existingRole?.role_settings?.permissions || { send_messages: true };

    const roleSettingsObj = {
      ...(existingRole?.role_settings || {}),
      ...(roleData.role_settings || {}),
      emoji: updatedEmoji,
      color: updatedColor,
      permissions: updatedPermissions
    };

    const updatedRoleMerged: ServerRole = {
      id: roleId,
      server: serverId,
      name: roleData.name || existingRole?.name || 'Role',
      emoji: updatedEmoji,
      color: updatedColor,
      permissions: updatedPermissions,
      role_settings: roleSettingsObj
    };

    try {
      const stored = localStorage.getItem(`server_roles_${serverId}`);
      if (stored) {
        const storedLocal: ServerRole[] = JSON.parse(stored);
        const updatedLocal = storedLocal.map((r) =>
          (r.id === roleId || r.name === roleData.name)
            ? { ...r, ...updatedRoleMerged }
            : r
        );
        localStorage.setItem(`server_roles_${serverId}`, JSON.stringify(updatedLocal));
      }
    } catch (err) {}

    if (!this.isDemo) {
      try {
        const recordPayload: any = {
          role_settings: roleSettingsObj
        };
        if (roleData.name) recordPayload.name = roleData.name;
        if (updatedEmoji) recordPayload.emoji = updatedEmoji;
        if (updatedColor) recordPayload.color = updatedColor;
        if (updatedPermissions) recordPayload.permissions = typeof updatedPermissions === 'object' ? JSON.stringify(updatedPermissions) : updatedPermissions;

        await this.pb.collection('roles').update(roleId, recordPayload);
      } catch (e) {
        console.warn('Failed to update role in PocketBase collection:', e);
        try {
          const fallbackPayload: any = {
            role_settings: JSON.stringify(roleSettingsObj)
          };
          if (roleData.name) fallbackPayload.name = roleData.name;
          await this.pb.collection('roles').update(roleId, fallbackPayload);
        } catch (e2) {
          console.warn('Fallback update with stringified role_settings failed:', e2);
        }
      }
    }

    this.serverRolesSnapshotCache.delete(serverId);
    const current = await this.fetchServerRoles(serverId, { forceRefresh: true });
    return current.find((r) => r.id === roleId || r.name === roleData.name) || updatedRoleMerged;
  }

  async deleteServerRole(serverId: string, roleId: string): Promise<boolean> {
    if (!this.isDemo) {
      try {
        await this.pb.collection('roles').delete(roleId);
      } catch (e) {}
    }

    try {
      this.serverRolesSnapshotCache.delete(serverId);
      const current = await this.fetchServerRoles(serverId, { forceRefresh: true });
      const updated = current.filter((r) => r.id !== roleId);
      localStorage.setItem(`server_roles_${serverId}`, JSON.stringify(updated));
    } catch (err) {}

    return true;
  }

  async fetchSingleServerMember(serverId: string, userId: string): Promise<ServerMember | null> {
    if (this.isDemo || !serverId || !userId) return null;
    try {
      const records = await this.pb.collection('server_members').getFullList({
        filter: `server = "${serverId}" && (user = "${userId}" || id = "${userId}")`,
        expand: 'user,role'
      });
      if (records.length === 0) return null;
      const m: any = records[0];

      let serverRoles: ServerRole[] = [];
      try {
        serverRoles = await this.fetchServerRoles(serverId);
      } catch (e) {}

      const localRole = localStorage.getItem(`member_role_${serverId}_${userId}`);

      let pbRole = '';
      if (m.expand?.role) {
        if (Array.isArray(m.expand.role)) {
          pbRole = m.expand.role.map((r: any) => r.id || r.name).join(',');
        } else {
          pbRole = m.expand.role.id || m.expand.role.name || '';
        }
      } else if (m.role) {
        if (Array.isArray(m.role)) {
          pbRole = m.role.map((roleId: string) => {
            const matched = serverRoles.find(r => r.id === roleId || r.name === roleId);
            return matched ? matched.id : roleId;
          }).join(',');
        } else {
          pbRole = String(m.role);
        }
      }

      const effectiveRole = pbRole || localRole || '';

      const localIsMember = localStorage.getItem(`is_member_${serverId}_${userId}`);
      const localStatus = localStorage.getItem(`membership_status_${serverId}_${userId}`);
      const localLeftAt = localStorage.getItem(`left_at_${serverId}_${userId}`);

      let isMember = m.is_member !== false && m.membership_status !== 'left' && m.membership_status !== 'banned' && m.membership_status !== 'kicked';
      if (localIsMember === 'false' || localStatus === 'left' || localStatus === 'banned' || localStatus === 'kicked') {
        isMember = false;
      } else if (localIsMember === 'true' || localStatus === 'active') {
        isMember = true;
      }

      let memStatus: 'active' | 'left' | 'banned' | 'kicked' = (m.membership_status as any) || (m.banned ? 'banned' : (isMember ? 'active' : 'left'));
      if (localStatus) memStatus = localStatus as any;

      const resMember: ServerMember = {
        id: m.id,
        member_name: m.member_name || m.nickname,
        server: m.server,
        user: m.user,
        nickname: m.nickname || m.member_name,
        server_avatar: m.server_avatar,
        server_banner: m.server_banner,
        server_profile_settings: m.server_profile_settings,
        role: effectiveRole,
        role_id: effectiveRole,
        expand: m.expand,
        joined_at: m.joined_at,
        created: m.created,
        is_member: isMember,
        left_at: m.left_at || localLeftAt || null,
        membership_status: memStatus
      };

      if (!this.serverMembersCache.has(serverId)) {
        this.serverMembersCache.set(serverId, new Map());
      }
      this.serverMembersCache.get(serverId)!.set(m.user, resMember);

      return resMember;
    } catch (e) {
      return null;
    }
  }

  async fetchServerMembers(serverId: string, options: { forceRefresh?: boolean } = {}): Promise<ServerMember[]> {
    if (this.isDemo || !serverId) return [];
    const cached = this.serverMembersSnapshotCache.get(serverId);
    if (!options.forceRefresh && cached && Date.now() - cached.timestamp < 15_000) {
      return cached.items;
    }
    const pending = this.serverMembersPromises.get(serverId);
    if (pending) return pending;
    const request = this.fetchServerMembersUncached(serverId)
      .then((items) => {
        this.serverMembersSnapshotCache.set(serverId, { items, timestamp: Date.now() });
        return items;
      })
      .finally(() => {
        if (this.serverMembersPromises.get(serverId) === request) {
          this.serverMembersPromises.delete(serverId);
        }
      });
    this.serverMembersPromises.set(serverId, request);
    return request;
  }

  private async fetchServerMembersUncached(serverId: string): Promise<ServerMember[]> {
    if (this.isDemo) return [];
    try {
      const records = await this.pb.collection('server_members').getFullList({
        filter: `server = "${serverId}"`,
        expand: 'user,role'
      });
      let serverRoles: ServerRole[] = [];
      try {
        serverRoles = await this.fetchServerRoles(serverId);
      } catch (e) {}

      if (!this.serverMembersCache.has(serverId)) {
        this.serverMembersCache.set(serverId, new Map());
      }
      const sMap = this.serverMembersCache.get(serverId)!;

      const mappedMembers: ServerMember[] = records.map((m: any) => {
        const userId = m.user || m.expand?.user?.id || m.id;
        const localRole = localStorage.getItem(`member_role_${serverId}_${userId}`);

        let pbRole = '';
        if (m.expand?.role) {
          if (Array.isArray(m.expand.role)) {
            pbRole = m.expand.role.map((r: any) => r.id || r.name).join(',');
          } else {
            pbRole = m.expand.role.id || m.expand.role.name || '';
          }
        } else if (m.role) {
          if (Array.isArray(m.role)) {
            pbRole = m.role.map((roleId: string) => {
              const matched = serverRoles.find(r => r.id === roleId || r.name === roleId);
              return matched ? matched.id : roleId;
            }).join(',');
          } else {
            pbRole = String(m.role);
          }
        }

        const effectiveRole = pbRole || localRole || '';

        const localIsMember = localStorage.getItem(`is_member_${serverId}_${userId}`);
        const localStatus = localStorage.getItem(`membership_status_${serverId}_${userId}`);
        const localLeftAt = localStorage.getItem(`left_at_${serverId}_${userId}`);

        let isMember = m.is_member !== false && m.membership_status !== 'left' && m.membership_status !== 'banned' && m.membership_status !== 'kicked';
        if (localIsMember === 'false' || localStatus === 'left' || localStatus === 'banned' || localStatus === 'kicked') {
          isMember = false;
        } else if (localIsMember === 'true' || localStatus === 'active') {
          isMember = true;
        }

        let memStatus: 'active' | 'left' | 'banned' | 'kicked' = (m.membership_status as any) || (m.banned ? 'banned' : (isMember ? 'active' : 'left'));
        if (localStatus) memStatus = localStatus as any;

        const sm: ServerMember = {
          id: m.id,
          member_name: m.member_name || m.nickname,
          server: m.server,
          user: userId,
          nickname: m.nickname || m.member_name,
          server_avatar: m.server_avatar,
          server_banner: m.server_banner,
          server_profile_settings: m.server_profile_settings,
          role: effectiveRole,
          role_id: effectiveRole,
          expand: m.expand,
          joined_at: m.joined_at,
          created: m.created,
          is_member: isMember,
          left_at: m.left_at || localLeftAt || null,
          membership_status: memStatus
        };
        sMap.set(userId, sm);
        return sm;
      });

      try {
        localStorage.setItem(`cached_server_members_${serverId}`, JSON.stringify(mappedMembers));
      } catch (err) {}

      return mappedMembers;
    } catch (e) {
      return [];
    }
  }

  async updateMemberRole(serverId: string, memberIdOrUserId: string, roleIdOrName: string): Promise<boolean> {
    this.serverMembersSnapshotCache.delete(serverId);
    let serverRoles: ServerRole[] = [];
    try {
      serverRoles = await this.fetchServerRoles(serverId);
    } catch (e) {}

    const tokens = String(roleIdOrName || '').split(',').map(s => s.trim()).filter(Boolean);
    const resolvedRoleIds: string[] = [];
    const resolvedRoleNames: string[] = [];

    for (const tok of tokens) {
      if (tok === 'owner' || tok === 'Server Owner' || tok === 'مالك السيرفر') continue;
      const matched = serverRoles.find(r => r.id === tok || r.name === tok);
      if (matched) {
        if (!resolvedRoleIds.includes(matched.id)) resolvedRoleIds.push(matched.id);
        if (!resolvedRoleNames.includes(matched.name)) resolvedRoleNames.push(matched.name);
      } else {
        if (!resolvedRoleIds.includes(tok)) resolvedRoleIds.push(tok);
        if (!resolvedRoleNames.includes(tok)) resolvedRoleNames.push(tok);
      }
    }

    if (!this.isDemo) {
      try {
        let memberRecord: any = null;
        try {
          const members = await this.pb.collection('server_members').getFullList({
            filter: `server = "${serverId}" && (user = "${memberIdOrUserId}" || id = "${memberIdOrUserId}")`
          });
          if (members.length > 0) memberRecord = members[0];
        } catch (e) {}

        if (!memberRecord) {
          try {
            const membersByUser = await this.pb.collection('server_members').getFullList({
              filter: `server = "${serverId}" && user = "${memberIdOrUserId}"`
            });
            if (membersByUser.length > 0) memberRecord = membersByUser[0];
          } catch (e) {}
        }

        if (memberRecord) {
          try {
            await this.pb.collection('server_members').update(memberRecord.id, {
              role: resolvedRoleIds
            });
          } catch (updateErr) {
            try {
              await this.pb.collection('server_members').update(memberRecord.id, {
                role: resolvedRoleIds.join(',') || resolvedRoleNames.join(',')
              });
            } catch (fallbackErr) {
              console.warn('Failed fallback update for member role in PocketBase:', fallbackErr);
            }
          }
        } else {
          try {
            await this.pb.collection('server_members').create({
              server: serverId,
              user: memberIdOrUserId,
              role: resolvedRoleIds
            });
          } catch (createErr) {
            try {
              await this.pb.collection('server_members').create({
                server: serverId,
                user: memberIdOrUserId,
                role: resolvedRoleIds.join(',') || resolvedRoleNames.join(',')
              });
            } catch (createFallback) {
              console.warn('Failed fallback create for member role in PocketBase:', createFallback);
            }
          }
        }
      } catch (e) {
        console.warn('Failed to update member role in PocketBase:', e);
      }
    }

    try {
      const combinedVal = resolvedRoleIds.join(',') || resolvedRoleNames.join(',') || roleIdOrName;
      localStorage.setItem(`member_role_${serverId}_${memberIdOrUserId}`, combinedVal);
      window.dispatchEvent(new CustomEvent('server-member-updated', {
        detail: { serverId, userId: memberIdOrUserId, role: combinedVal }
      }));
    } catch (e) {}

    return true;
  }

  async updateServerMemberProfile(
    serverId: string,
    userId: string,
    profileData: { member_name?: string; server_avatar?: File | string | null; server_banner?: File | string | null; server_profile_settings?: any }
  ): Promise<ServerMember> {
    this.serverMembersSnapshotCache.delete(serverId);
    if (this.isDemo) {
      return { id: 'demo-member', server: serverId, user: userId, ...profileData } as any;
    }

    let memberRecord: any = null;
    try {
      const members = await this.pb.collection('server_members').getFullList({
        filter: `server = "${serverId}" && user = "${userId}"`
      });
      if (members.length > 0) {
        memberRecord = members[0];
      }
    } catch (e) {}

    if (!memberRecord) {
      try {
        memberRecord = await this.joinServer(serverId);
      } catch (e) {}
    }

    const formData = new FormData();
    if (profileData.member_name !== undefined) {
      formData.append('member_name', profileData.member_name);
      formData.append('nickname', profileData.member_name);
    }

    if (profileData.server_avatar instanceof File) {
      formData.append('server_avatar', profileData.server_avatar);
    } else if (typeof profileData.server_avatar === 'string' && profileData.server_avatar && profileData.server_avatar !== 'REMOVE') {
      formData.append('server_avatar', profileData.server_avatar);
    } else if (profileData.server_avatar === null || profileData.server_avatar === '' || profileData.server_avatar === 'REMOVE') {
      formData.append('server_avatar', '');
    }

    if (profileData.server_banner instanceof File) {
      formData.append('server_banner', profileData.server_banner);
    } else if (typeof profileData.server_banner === 'string' && profileData.server_banner && profileData.server_banner !== 'REMOVE') {
      formData.append('server_banner', profileData.server_banner);
    } else if (profileData.server_banner === null || profileData.server_banner === '' || profileData.server_banner === 'REMOVE') {
      formData.append('server_banner', '');
    }

    if (profileData.server_profile_settings !== undefined) {
      const strSettings = typeof profileData.server_profile_settings === 'string'
        ? profileData.server_profile_settings
        : JSON.stringify(profileData.server_profile_settings);
      formData.append('server_profile_settings', strSettings);
    }

    if (memberRecord) {
      try {
        const updated = await this.pb.collection('server_members').update(memberRecord.id, formData);
        memberRecord = updated;
      } catch (err) {
        // Fallback to plain JSON object update
        try {
          const plainData: any = {};
          if (profileData.member_name !== undefined) {
            plainData.member_name = profileData.member_name;
            plainData.nickname = profileData.member_name;
          }
          if (typeof profileData.server_avatar === 'string' && profileData.server_avatar !== 'REMOVE') {
            plainData.server_avatar = profileData.server_avatar;
          } else if (profileData.server_avatar === null || profileData.server_avatar === 'REMOVE') {
            plainData.server_avatar = null;
          }

          if (typeof profileData.server_banner === 'string' && profileData.server_banner !== 'REMOVE') {
            plainData.server_banner = profileData.server_banner;
          } else if (profileData.server_banner === null || profileData.server_banner === 'REMOVE') {
            plainData.server_banner = null;
          }

          if (profileData.server_profile_settings !== undefined) {
            plainData.server_profile_settings = profileData.server_profile_settings;
          }

          const updated = await this.pb.collection('server_members').update(memberRecord.id, plainData);
          memberRecord = updated;
        } catch (err2) {
          console.warn('Failed to update server member profile in PB collection:', err2);
        }
      }
    }

    // Cache local overrides for immediate reactivity and offline fallback
    try {
      if (profileData.member_name !== undefined) {
        localStorage.setItem(`server_name_${serverId}_${userId}`, profileData.member_name);
      }

      if (profileData.server_avatar === null || profileData.server_avatar === '' || profileData.server_avatar === 'REMOVE') {
        localStorage.removeItem(`server_avatar_${serverId}_${userId}`);
      } else if (typeof profileData.server_avatar === 'string') {
        localStorage.setItem(`server_avatar_${serverId}_${userId}`, profileData.server_avatar);
      }

      if (profileData.server_banner === null || profileData.server_banner === '' || profileData.server_banner === 'REMOVE') {
        localStorage.removeItem(`server_banner_${serverId}_${userId}`);
      } else if (typeof profileData.server_banner === 'string') {
        localStorage.setItem(`server_banner_${serverId}_${userId}`, profileData.server_banner);
      }

      if (profileData.server_profile_settings !== undefined) {
        const strSettings = typeof profileData.server_profile_settings === 'string'
          ? profileData.server_profile_settings
          : JSON.stringify(profileData.server_profile_settings);
        localStorage.setItem(`server_profile_settings_${serverId}_${userId}`, strSettings);
        if (typeof profileData.server_profile_settings === 'object' && profileData.server_profile_settings) {
          if (profileData.server_profile_settings.cardColor) localStorage.setItem(`server_color1_${serverId}_${userId}`, profileData.server_profile_settings.cardColor);
          if (profileData.server_profile_settings.cardColor2) localStorage.setItem(`server_color2_${serverId}_${userId}`, profileData.server_profile_settings.cardColor2);
          if (profileData.server_profile_settings.avatarFrameColor) localStorage.setItem(`server_frame_color_${serverId}_${userId}`, profileData.server_profile_settings.avatarFrameColor);
          if (profileData.server_profile_settings.bio !== undefined) localStorage.setItem(`server_bio_${serverId}_${userId}`, profileData.server_profile_settings.bio);
        }
      }

      if (memberRecord) {
        if (!this.serverMembersCache.has(serverId)) {
          this.serverMembersCache.set(serverId, new Map());
        }
        this.serverMembersCache.get(serverId)!.set(userId, memberRecord as any as ServerMember);
      }

      window.dispatchEvent(new CustomEvent('server-member-updated', {
        detail: { serverId, userId, memberName: profileData.member_name }
      }));
    } catch (e) {}

    return memberRecord as any as ServerMember;
  }

  // --- SERVER OPTIONS & USER SPECIFIC INVITES ---

  async fetchServerOptions(serverId: string): Promise<ServerOptionInvite[]> {
    if (this.isDemo) return [];
    try {
      const records = await this.pb.collection('server_options').getFullList({
        filter: `server = "${serverId}"`,
        sort: '-created'
      });
      return records.map((r: any) => ({
        id: r.id,
        server: r.server,
        target_user_id: r.target_user_id || r.user_id,
        target_username: r.target_username || r.username,
        target_display_name: r.target_display_name,
        invited_by: r.invited_by,
        status: r.status || 'waiting',
        created: r.created
      }));
    } catch (e) {
      try {
        const stored = localStorage.getItem(`server_options_${serverId}`);
        if (stored) return JSON.parse(stored);
      } catch (err) {}
      return [];
    }
  }

  async createServerOptionInvite(
    serverId: string,
    targetUserId: string,
    targetUsername: string,
    invitedBy: string,
    targetDisplayName?: string
  ): Promise<ServerOptionInvite> {
    return this.createCustomInvite(serverId, targetUserId, targetUsername, invitedBy, targetDisplayName);
  }

  async deleteServerOptionInvite(inviteId: string, serverId: string = ''): Promise<void> {
    return this.removeCustomInvite(serverId, inviteId);
  }

  async createCustomInvite(
    serverId: string,
    targetUserId: string,
    targetUsername: string,
    invitedBy: string,
    targetDisplayName?: string
  ): Promise<ServerOptionInvite> {
    const invite: ServerOptionInvite = {
      id: 'opt-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      server: serverId,
      target_user_id: targetUserId,
      target_username: targetUsername,
      target_display_name: targetDisplayName || targetUsername,
      invited_by: invitedBy,
      status: 'waiting',
      created: new Date().toISOString()
    };

    if (!this.isDemo) {
      try {
        const record = await this.pb.collection('server_options').create({
          server: serverId,
          target_user_id: targetUserId,
          target_username: targetUsername,
          target_display_name: targetDisplayName || targetUsername,
          invited_by: invitedBy,
          status: 'waiting'
        });
        invite.id = record.id;
      } catch (e) {
        console.warn('Failed to save server option invite to PocketBase, using local sync:', e);
      }
    }

    // Update local storage
    try {
      const current = await this.fetchServerOptions(serverId);
      // Replace existing invite if any, else add
      const filtered = current.filter((i) => i.target_user_id !== targetUserId);
      const updated = [invite, ...filtered];
      localStorage.setItem(`server_options_${serverId}`, JSON.stringify(updated));
    } catch (err) {}

    return invite;
  }

  async markInviteJoined(serverId: string, userId: string): Promise<void> {
    if (!this.isDemo) {
      try {
        const records = await this.pb.collection('server_options').getFullList({
          filter: `server = "${serverId}" && target_user_id = "${userId}"`
        });
        for (const r of records) {
          await this.pb.collection('server_options').update(r.id, {
            status: 'joined'
          });
        }
      } catch (e) {}
    }

    try {
      const current = await this.fetchServerOptions(serverId);
      const updated = current.map((i) => {
        if (i.target_user_id === userId) {
          return { ...i, status: 'joined' as const };
        }
        return i;
      });
      localStorage.setItem(`server_options_${serverId}`, JSON.stringify(updated));
    } catch (err) {}
  }

  async removeCustomInvite(serverId: string, inviteId: string): Promise<void> {
    if (!this.isDemo) {
      try {
        await this.pb.collection('server_options').delete(inviteId);
      } catch (e) {}
    }

    try {
      const current = await this.fetchServerOptions(serverId);
      const updated = current.filter((i) => i.id !== inviteId);
      localStorage.setItem(`server_options_${serverId}`, JSON.stringify(updated));
    } catch (err) {}
  }

  subscribeToAppConfig(callback: (newUrl: string) => void): () => void {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'sirver_pb_url' && e.newValue) {
        callback(e.newValue);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }

  async sendHeartbeat(userId: string): Promise<void> {
    if (this.isDemo || !userId) return;
    try {
      const nowIso = new Date().toISOString();
      await this.pb.collection('users').update(userId, {
        last_seen: nowIso
      });
    } catch (e) {
      // Silently ignore heartbeat failure if network drops
    }
  }

  private userListeners = new Set<(event: any) => void>();
  private usersSubscribed = false;

  private setupUsersSubscription() {
    if (this.usersSubscribed || this.isDemo || !this.pb.authStore.isValid || !this.pb.authStore.token) return;
    this.usersSubscribed = true;

    try {
      this.pb.collection('users').subscribe('*', (e) => {
        if (e?.record?.id && this.usersCache) {
          const idx = this.usersCache.findIndex((u) => u.id === e.record.id);
          if (idx >= 0) {
            this.usersCache[idx] = mergeUserRecord(this.usersCache[idx], e.record as unknown as User);
          } else {
            this.usersCache.push(e.record as unknown as User);
          }
        }
        this.userListeners.forEach((callback) => {
          try {
            callback(e);
          } catch (cbErr) {}
        });
      }).catch((err) => {
        this.usersSubscribed = false;
        if (!this.pb.authStore.isValid || !this.pb.authStore.token) return;
        if (this.usersRetryTimeout) clearTimeout(this.usersRetryTimeout);
        this.usersRetryTimeout = setTimeout(() => {
          if (this.userListeners.size > 0 && !this.usersSubscribed && this.pb.authStore.isValid && this.pb.authStore.token) {
            this.setupUsersSubscription();
          }
        }, 5000);
      });
    } catch (err) {
      this.usersSubscribed = false;
      if (!this.pb.authStore.isValid || !this.pb.authStore.token) return;
      if (this.usersRetryTimeout) clearTimeout(this.usersRetryTimeout);
      this.usersRetryTimeout = setTimeout(() => {
        if (this.userListeners.size > 0 && !this.usersSubscribed && this.pb.authStore.isValid && this.pb.authStore.token) {
          this.setupUsersSubscription();
        }
      }, 5000);
    }
  }

  subscribeToUsers(callback: (event: any) => void): () => void {
    if (this.isDemo) return () => {};

    this.userListeners.add(callback);
    if (this.pb.authStore.isValid && this.pb.authStore.token) {
      this.setupUsersSubscription();
    }

    return () => {
      this.userListeners.delete(callback);
      if (this.userListeners.size === 0) {
        if (this.usersRetryTimeout) {
          clearTimeout(this.usersRetryTimeout);
          this.usersRetryTimeout = null;
        }
        this.usersSubscribed = false;
        try {
          this.pb.collection('users').unsubscribe('*').catch(() => {});
        } catch (e) {}
      }
    };
  }

  // --- ATTACHMENT DOWNLOAD STATE PERSISTENCE ---

  async updateAttachmentDownloadedFiles(
    attachmentId: string,
    downloadRecord: DownloadedFileRecord
  ): Promise<void> {
    if (this.isDemo || !attachmentId) return;
    try {
      const record = await this.pb.collection('attachments').getOne(attachmentId).catch(() => null);
      if (!record) return;

      let existingFiles: DownloadedFileRecord[] = [];
      if (record.downloaded_files) {
        if (typeof record.downloaded_files === 'string') {
          try {
            existingFiles = JSON.parse(record.downloaded_files);
          } catch {
            existingFiles = [];
          }
        } else if (Array.isArray(record.downloaded_files)) {
          existingFiles = record.downloaded_files;
        }
      }

      // Check if entry for user already exists to avoid duplicates
      const userIdx = existingFiles.findIndex((f) => f.user_id === downloadRecord.user_id);
      if (userIdx >= 0) {
        existingFiles[userIdx] = { ...existingFiles[userIdx], ...downloadRecord };
      } else {
        existingFiles.push(downloadRecord);
      }

      await this.pb.collection('attachments').update(attachmentId, {
        downloaded_files: existingFiles
      });
    } catch (err) {
      console.warn(`Failed to update downloaded_files for attachment ${attachmentId}:`, err);
    }
  }

  async getAttachmentDownloadedFiles(attachmentId: string): Promise<DownloadedFileRecord[]> {
    if (this.isDemo || !attachmentId) return [];
    try {
      const record = await this.pb.collection('attachments').getOne(attachmentId).catch(() => null);
      if (!record || !record.downloaded_files) return [];
      if (typeof record.downloaded_files === 'string') {
        try {
          return JSON.parse(record.downloaded_files);
        } catch {
          return [];
        }
      } else if (Array.isArray(record.downloaded_files)) {
        return record.downloaded_files;
      }
    } catch (e) {
      console.warn('Failed to fetch attachment downloaded_files:', e);
    }
    return [];
  }

  async kickServerMember(serverId: string, targetUserId: string): Promise<boolean> {
    this.serverMembersSnapshotCache.delete(serverId);
    if (!serverId || !targetUserId) return false;

    if (!this.isDemo) {
      try {
        const records = await this.pb.collection('server_members').getFullList({
          filter: `server = "${serverId}" && (user = "${targetUserId}" || id = "${targetUserId}")`
        });
        for (const r of records) {
          try {
            await this.pb.collection('server_members').update(r.id, {
              is_member: false,
              membership_status: 'kicked',
              left_at: new Date().toISOString()
            });
          } catch (e) {
            try {
              await this.pb.collection('server_members').delete(r.id);
            } catch (delErr) {}
          }
        }
      } catch (err) {
        console.warn('Failed to kick member in PocketBase:', err);
      }
    }

    try {
      localStorage.setItem(`is_member_${serverId}_${targetUserId}`, 'false');
      localStorage.setItem(`membership_status_${serverId}_${targetUserId}`, 'kicked');
      localStorage.setItem(`left_at_${serverId}_${targetUserId}`, new Date().toISOString());

      if (this.serverMembersCache.has(serverId)) {
        this.serverMembersCache.get(serverId)!.delete(targetUserId);
      }

      window.dispatchEvent(new CustomEvent('server-member-updated', {
        detail: { serverId, userId: targetUserId, status: 'kicked', isMember: false }
      }));
    } catch (e) {}

    return true;
  }

  // --- SERVER EMOJIS & STICKERS ---

  async fetchServerEmojis(serverId: string): Promise<ServerEmoji[]> {
    if (!serverId) return [];
    let localEmojis: ServerEmoji[] = [];
    try {
      const stored = localStorage.getItem(`server_emojis_${serverId}`);
      if (stored) localEmojis = JSON.parse(stored);
    } catch (e) {}

    if (this.isDemo) return localEmojis;

    try {
      const records = await this.pb.collection('server_emojis').getFullList({
        filter: `server = "${serverId}" || server_id = "${serverId}"`,
        sort: '-created'
      });
      const remote: ServerEmoji[] = records.map((r: any): ServerEmoji => ({
        id: r.id,
        server_id: r.server || r.server_id || serverId,
        name: r.name,
        url: r.file ? `${this.getServerUrl()}/api/files/server_emojis/${r.id}/${r.file}` : (r.url || ''),
        animated: !!(r.name?.endsWith('.gif') || r.file?.endsWith('.gif') || r.animated),
        type: r.type || 'emoji',
        created: r.created
      }));

      const merged: ServerEmoji[] = [...remote];
      for (const loc of localEmojis) {
        if (!merged.some(m => m.id === loc.id || m.name === loc.name)) {
          merged.push(loc);
        }
      }
      try {
        localStorage.setItem(`server_emojis_${serverId}`, JSON.stringify(merged));
      } catch (e) {}
      return merged;
    } catch (e) {
      return localEmojis;
    }
  }

  async uploadServerEmoji(serverId: string, name: string, file: File, type: 'emoji' | 'sticker' = 'emoji'): Promise<ServerEmoji> {
    const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const isAnim = file.name.endsWith('.gif') || file.type.includes('gif');
    const localUrl = URL.createObjectURL(file);

    const newEmoji: ServerEmoji = {
      id: 'emoji-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      server_id: serverId,
      name: cleanName,
      url: localUrl,
      animated: isAnim,
      type,
      created_by: this.getCurrentUser()?.id,
      created: new Date().toISOString()
    };

    try {
      const existing = await this.fetchServerEmojis(serverId);
      const updated = [newEmoji, ...existing];
      localStorage.setItem(`server_emojis_${serverId}`, JSON.stringify(updated));
    } catch (e) {}

    if (!this.isDemo) {
      try {
        const formData = new FormData();
        formData.append('server', serverId);
        formData.append('server_id', serverId);
        formData.append('name', cleanName);
        formData.append('file', file);
        formData.append('type', type);
        formData.append('animated', String(isAnim));
        const rec = await this.pb.collection('server_emojis').create(formData);
        newEmoji.id = rec.id;
        if (rec.file) {
          newEmoji.url = `${this.getServerUrl()}/api/files/server_emojis/${rec.id}/${rec.file}`;
        }
      } catch (e) {
        console.warn('Server emoji collection upload fallback:', e);
      }
    }

    return newEmoji;
  }

  async deleteServerEmoji(serverId: string, emojiId: string): Promise<boolean> {
    if (!this.isDemo) {
      try {
        await this.pb.collection('server_emojis').delete(emojiId);
      } catch (e) {}
    }
    try {
      const current = await this.fetchServerEmojis(serverId);
      const filtered = current.filter(e => e.id !== emojiId);
      localStorage.setItem(`server_emojis_${serverId}`, JSON.stringify(filtered));
    } catch (e) {}
    return true;
  }

  async updateUserSettings(userId: string, settings: any): Promise<any> {
    try {
      if (!this.isDemo) {
        return await this.pb.collection('users').update(userId, { settings });
      }
    } catch (e) {
      console.warn('Failed to update user settings in PocketBase:', e);
    }
    return null;
  }
}

export const pbService = new PocketBaseService();

export function parseChannelOptions(chan: Channel): ChannelOptions {
  if (!chan) return {};
  let opts: ChannelOptions = {};
  if (chan.channel_options) {
    if (typeof chan.channel_options === 'string') {
      try {
        opts = JSON.parse(chan.channel_options);
      } catch (e) {
        opts = {};
      }
    } else if (typeof chan.channel_options === 'object') {
      opts = chan.channel_options;
    }
  }
  try {
    const local = localStorage.getItem(`channel_options_${chan.id}`);
    if (local) {
      const parsed = JSON.parse(local);
      opts = { ...parsed, ...opts };
    }
  } catch (e) {}

  if (!opts.icon && chan.icon) opts.icon = chan.icon;
  if (!opts.visible_roles && chan.visible_roles) opts.visible_roles = chan.visible_roles;
  if (!opts.user_limit && chan.user_limit) opts.user_limit = chan.user_limit;
  return opts;
}

export default pbService;
