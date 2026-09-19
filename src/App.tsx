import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { pbService, mergeUserRecord } from './pocketbase';
import { MessageDeletionService } from './services/messageDeletionService';
import { getLanguageDictionary } from './services/localization';
import { Bell, Volume2 } from 'lucide-react';
import { User, Server, Channel, Message, Attachment, Translation, AppLanguageConfig, MusicTrack, NotificationItem, UnreadChannelInfo, Call, MessageCursor, MessagePage } from './types';
import { sendInAppNotification, requestNotificationPermission, isEphemeralCallNotification } from './lib/notifications';
import { notificationService } from './services/notificationService';
import { playPingSound } from './lib/sounds';
import {
  UserSettings,
  getCachedUserSettings,
  saveCachedUserSettings,
  applySettingsToDocument,
  mergeWithDefaults,
  resolveEffectiveTheme
} from './lib/userSettings';
import { backStackManager, useBackHandler } from './services/backStackManager';

// Components
import AuthScreen from './components/AuthScreen';
import ChannelList from './components/ChannelList';
import type { ActiveUploadState } from './components/ChatPanel';
import UserProfileModal, { AnchorRect } from './components/UserProfileModal';
import NotificationToast, { ToastNotice } from './components/NotificationToast';
import NotificationsPopover from './components/NotificationsPopover';
import TitleBar from './components/TitleBar';
import ResetPasswordScreen from './components/ResetPasswordScreen';
import { setupWindowCloseRequestedListener, isTauriEnvironment, isMobilePlatform, isDesktopPlatform } from './lib/tauriDesktopService';
import { GlobalMusicPlayer } from './components/MusicPlayer';

// Code-Split Lazy Loaded Components
const SettingsModal = React.lazy(() => import('./components/SettingsModal'));
const ChatPanel = React.lazy(() => import('./components/ChatPanel'));
import VoicePanel from './components/VoicePanel';
const ServerSettingsModal = React.lazy(() => import('./components/ServerSettingsModal'));
const DiscoveryCenter = React.lazy(() => import('./components/DiscoveryCenter'));
const CreateServerModal = React.lazy(() => import('./components/CreateServerModal'));
const NewDmModal = React.lazy(() => import('./components/NewDmModal'));
import { FloatingCallWindow } from './components/FloatingCallWindow';
const LeaveServerModal = React.lazy(() => import('./components/LeaveServerModal'));
import wsService from './services/websocket';
import callSignalingService from './services/callSignaling';
import { parseCallLog } from './services/callLogService';
import { offlineCacheService } from './services/offlineCacheService';
import { parseReactions, toggleReactionInList } from './components/MessageReactions';
import { areMessagesEqual, isSingleMessageEqual } from './lib/messageDiff';
import { useMediaSession } from './context/MediaContext';
import { realtimeMediaProvider } from './media/RealtimeMediaProvider';
import voicePresenceStore from './services/voicePresenceStore';
import { readSessionSnapshot, writeSessionSnapshot } from './services/sessionSnapshot';
import { cursorFromMessage, getOldestCursor, getNewestCursor, dedupeMessages, didMessageWindowMoveOlder, mergeMessagePage, mergeOlderMessagePage, INITIAL_MESSAGE_PAGE_SIZE, OLDER_MESSAGE_PAGE_SIZE, MAX_ACTIVE_MESSAGES } from './services/messagePagination';
import { backendAvailability, BackendAvailability, isClientCancellation } from './services/backendAvailability';
import { afterFirstPaint } from './services/afterPaint';
import { apiV2Client, BootstrapResponse } from './services/apiV2Client';

const EMPTY_ACTIVE_CALLS: Call[] = [];

/**
 * Capacitor is retained only for the legacy Android shell. Keep its plugin
 * out of the Tauri/browser startup bundle and never initialise it inside a
 * Tauri window. Tauri Android has its own native activity and does not need
 * the Capacitor bridge for navigation or updates.
 */
async function getCapacitorApp() {
  if (typeof window === 'undefined') return null;
  const capacitor = (window as any).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  try {
    const module = await import('@capacitor/app');
    return module.App;
  } catch {
    return null;
  }
}

function extractResetTokenFromUrl(urlStr?: string): string | null {
  if (typeof window === 'undefined') return null;
  const target = urlStr || window.location.href;
  try {
    const parsed = new URL(target);
    const t = parsed.searchParams.get('token');
    if (t) return t;
  } catch (e) {}
  if (target.includes('token=')) {
    const match = target.match(/token=([^&]+)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

export default function App() {
  // Read the compact last-session payload synchronously.  IndexedDB/network
  // hydration still happens after the first paint, but the shell can display
  // the last server/channel/messages immediately when a valid auth session is
  // already present.
  const [startupSnapshot] = useState(() => readSessionSnapshot());
  const initialIsDm = startupSnapshot?.activeConversationKind === 'dm' || (typeof window !== 'undefined' && localStorage.getItem('last_active_conversation_type') === 'dm');
  const initialServer = initialIsDm
    ? null
    : (startupSnapshot?.servers.find((server) => server.id === startupSnapshot.activeServerId) || (startupSnapshot?.activeServerId ? null : (startupSnapshot?.servers[0] || null)));
  const initialChannel = startupSnapshot?.activeChannelId
    ? Object.values(startupSnapshot.channelsByServer as Record<string, Channel[]>).flat().find((channel) => channel.id === startupSnapshot.activeChannelId) || startupSnapshot.dms.find((channel) => channel.id === startupSnapshot.activeChannelId) || null
    : null;
  const [currentUser, setCurrentUser] = useState<User | null>(() => pbService.getCurrentUser());
  const [resetToken, setResetToken] = useState<string | null>(() => extractResetTokenFromUrl());
  const [servers, setServers] = useState<Server[]>(() => startupSnapshot?.servers || []);
  const [channels, setChannels] = useState<Channel[]>(() => initialServer ? (startupSnapshot?.channelsByServer[initialServer.id] || []) : []);
  const [messages, setMessages] = useState<Message[]>(() => initialChannel ? (startupSnapshot?.newestMessages[initialChannel.id] || []) : []);
  const [serverMessages, setServerMessages] = useState<Message[]>([]);
  const [messagesPage, setMessagesPage] = useState<number>(1);
  const [hasMoreMessages, setHasMoreMessages] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [isInitialLoadingChannel, setIsInitialLoadingChannel] = useState<boolean>(false);
  const [backendStatus, setBackendStatus] = useState<BackendAvailability>(() => backendAvailability.getSnapshot().status);
  const [backendError, setBackendError] = useState<string | null>(() => backendAvailability.getSnapshot().lastError);
  
  // Unread, Toast & Notification states
  const [unreadCounts, setUnreadCounts] = useState<Record<string, UnreadChannelInfo>>({});
  const [activeUnreadCountOnOpen, setActiveUnreadCountOnOpen] = useState<{ channelId: string; count: number } | null>(null);
  const [activeToast, setActiveToast] = useState<ToastNotice | null>(null);
  const [notificationsList, setNotificationsList] = useState<NotificationItem[]>([]);
  const [showNotificationsPopover, setShowNotificationsPopover] = useState<boolean>(false);
  const [showNewDmModal, setShowNewDmModal] = useState<boolean>(false);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const [activeUpload, setActiveUpload] = useState<ActiveUploadState | null>(null);
  
  const [activeServer, setActiveServer] = useState<Server | null>(() => initialServer);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(() => initialChannel);
  const [activeServerChannel, setActiveServerChannel] = useState<Channel | null>(null);
  const [activeDmChannel, setActiveDmChannel] = useState<Channel | null>(null);
  const [activeVoiceChannel, setActiveVoiceChannel] = useState<Channel | null>(null);
  const [pendingVoiceSwitchChannel, setPendingVoiceSwitchChannel] = useState<Channel | null>(null);
  const lastVoiceChannelRef = useRef<Channel | null>(null);
  const [activeCallMode, setActiveCallMode] = useState<'voice' | 'video' | 'screen'>('voice');
  const previousTextChannelRef = useRef<Channel | null>(null);
  const [showDiscoveryCenter, setShowDiscoveryCenter] = useState(false);
  const [discoveryTab, setDiscoveryTab] = useState<'friends' | 'servers'>('servers');
  const [allDmChannels, setAllDmChannels] = useState<Channel[]>(() => startupSnapshot?.dms || []);
  const [closedDmIds, setClosedDmIds] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const stored = localStorage.getItem(`closed_dms_${pbService.getCurrentUser()?.id}`);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  const [isMobile, setIsMobile] = useState<boolean>(() => typeof window !== 'undefined' ? window.innerWidth < 768 : false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const { activeRoom, leaveRoomOrCall, joinVoiceRoom, startDmCall } = useMediaSession();

  const prevActiveRoomIdRef = useRef<string | null>(null);

  // Deep link listener & web redirect logic for password reset tokens (sirver://reset-password?token=...)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const initialToken = extractResetTokenFromUrl(window.location.href);
    if (initialToken) {
      if (window.location.protocol.startsWith('http') && window.location.pathname.includes('/reset-password')) {
        const isNative = isTauriEnvironment() || isMobilePlatform();
        if (!isNative) {
          // Attempt opening the installed native application via custom protocol sirver://
          const appUri = `sirver://reset-password?token=${encodeURIComponent(initialToken)}`;
          const iframe = document.createElement('iframe');
          iframe.style.display = 'none';
          iframe.src = appUri;
          document.body.appendChild(iframe);
          setTimeout(() => {
            if (document.body.contains(iframe)) {
              document.body.removeChild(iframe);
            }
          }, 1500);
        }
      }
      setResetToken(initialToken);
    }

    let disposed = false;
    let capListener: any = null;
    void getCapacitorApp().then((capApp) => {
      if (disposed || !capApp) return;
      capListener = capApp.addListener('appUrlOpen', (data: any) => {
        if (data?.url) {
          const deepToken = extractResetTokenFromUrl(data.url);
          if (deepToken) {
            setResetToken(deepToken);
          }
        }
      });
    }).catch(() => {});

    return () => {
      disposed = true;
      if (capListener && typeof capListener.then === 'function') {
        capListener.then((h: any) => h?.remove?.()).catch(() => {});
      } else if (capListener && typeof capListener.remove === 'function') {
        capListener.remove();
      }
    };
  }, []);

  // Sync activeVoiceChannel with activeRoom in MediaContext and navigate to voice channel screen on join
  useEffect(() => {
    const currentRoomId = activeRoom?.roomId || null;
    if (currentRoomId && currentRoomId !== prevActiveRoomIdRef.current) {
      // Find matching voice channel in channels or allDmChannels or activeVoiceChannel
      const matchedVoiceChan =
        (activeVoiceChannel && activeVoiceChannel.id === currentRoomId ? activeVoiceChannel : null) ||
        channels.find((c) => c.id === currentRoomId) ||
        allDmChannels.find((c) => c.id === currentRoomId);

      if (matchedVoiceChan) {
        if (matchedVoiceChan.server && matchedVoiceChan.server !== 'dm' && matchedVoiceChan.server !== activeServer?.id) {
          const parentServer = servers.find((s) => s.id === matchedVoiceChan.server);
          if (parentServer) {
            setActiveServer(parentServer);
          }
        }
        if (activeChannel && activeChannel.type !== 'voice' && activeChannel.id !== matchedVoiceChan.id) {
          previousTextChannelRef.current = activeChannel;
        }
        setActiveVoiceChannel(matchedVoiceChan);
        setActiveChannel(matchedVoiceChan);
        setShowDiscoveryCenter(false);
      }
    } else if (!activeRoom && activeVoiceChannel) {
      setActiveVoiceChannel(null);
    }
    prevActiveRoomIdRef.current = currentRoomId;
  }, [activeRoom, activeVoiceChannel, channels, allDmChannels, servers, activeServer, activeChannel]);

  // Connection & settings
  const isDemo = false; // Always connected to sirverdata only
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sidebarDragState, setSidebarDragState] = useState<{
    isDragging: boolean;
    dragX: number;
    opacity: number;
  }>({ isDragging: false, dragX: 0, opacity: 0 });

  const sidebarTouchRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastTime: number;
    axis: 'horizontal' | 'vertical' | null;
    initialIsOpen: boolean;
    active: boolean;
  } | null>(null);

  const [serverUrl, setServerUrl] = useState(pbService.getServerUrl());
  
  // Default to Arabic lang
  const [lang, setLang] = useState<'en' | 'ar'>(() => {
    const saved = localStorage.getItem('app_lang');
    return (saved === 'en' || saved === 'ar') ? saved : 'ar';
  });
  const [langConfig, setLangConfig] = useState<AppLanguageConfig>({});

  // User Settings state
  const [userSettings, setUserSettings] = useState<UserSettings>(() => getCachedUserSettings());

  // Apply settings to document on initial mount and change
  useEffect(() => {
    applySettingsToDocument(userSettings);
  }, [userSettings]);

  // Realtime is intentionally started after the cached shell has painted.
  // This keeps a slow/unavailable WebSocket from delaying servers or chats.
  useEffect(() => {
    if (!currentUser?.id || typeof window === 'undefined') return;
    let frame = requestAnimationFrame(() => wsService.connect());
    return () => cancelAnimationFrame(frame);
  }, [currentUser?.id]);

  // Intercept native Tauri window close button (X) to hide instead of exit
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const cancel = afterFirstPaint(() => {
      setupWindowCloseRequestedListener().then((fn) => {
        if (disposed) {
          fn?.();
        } else if (fn) {
          unlisten = fn;
        }
      }).catch(() => {});
    });
    return () => {
      disposed = true;
      cancel();
      if (unlisten) unlisten();
    };
  }, []);

  const handleUpdateUserSettings = (newSettings: UserSettings) => {
    setUserSettings(newSettings);
    saveCachedUserSettings(newSettings);
    applySettingsToDocument(newSettings);

    if (newSettings.languageRegion.appLanguage !== lang) {
      setLang(newSettings.languageRegion.appLanguage);
      localStorage.setItem('app_lang', newSettings.languageRegion.appLanguage);
    }

    if (currentUser) {
      pbService.updateProfile(currentUser.id, { settings: newSettings }).catch((e) => {
        console.warn('Failed to sync settings to PocketBase profile:', e);
      });
    }
  };

  const effectiveTheme = resolveEffectiveTheme(userSettings.appearance.theme);

  // Audio state
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [activeGlobalTrack, setActiveGlobalTrack] = useState<MusicTrack | null>(null);
  const [leavingServer, setLeavingServer] = useState<Server | null>(null);

  // Modals
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [selectedUserProfile, setSelectedUserProfile] = useState<User | null>(null);
  const [profileAnchorRect, setProfileAnchorRect] = useState<AnchorRect | null>(null);
  const [isGlobalSelfProfile, setIsGlobalSelfProfile] = useState<boolean>(false);
  const [serverSettingsModalServer, setServerSettingsModalServer] = useState<Server | null>(null);
  const lastProfileSelectTimeRef = useRef<number>(0);

  const handleSelectUser = (
    user: User | null,
    anchor?: AnchorRect | HTMLElement | MouseEvent | React.MouseEvent | null,
    isEditableSelf: boolean = false
  ) => {
    const now = Date.now();
    // Guard against identical event firing within 30ms (e.g. pointerdown + click on same tap)
    if (user && now - lastProfileSelectTimeRef.current < 30) {
      return;
    }
    lastProfileSelectTimeRef.current = now;

    setIsGlobalSelfProfile(isEditableSelf);

    if (!user) {
      setSelectedUserProfile(null);
      setProfileAnchorRect(null);
      setIsGlobalSelfProfile(false);
      return;
    }
    if (anchor) {
      let targetEl: HTMLElement | null = null;

      if (typeof anchor === 'object' && anchor !== null) {
        if ('currentTarget' in anchor && (anchor as any).currentTarget instanceof HTMLElement) {
          targetEl = (anchor as any).currentTarget;
        } else if ('target' in anchor && (anchor as any).target instanceof HTMLElement) {
          targetEl = (anchor as any).target;
        } else if (anchor instanceof HTMLElement) {
          targetEl = anchor;
        }
      }

      if (targetEl) {
        // Check if target element is inside the desktop server member list
        const memberListDesktopEl = targetEl.closest?.('[data-member-list-desktop="true"]');
        const isMemberListDesktop = Boolean(memberListDesktopEl) && window.innerWidth >= 768;

        // Resolve anchor directly to the avatar element if present in target or nearby row
        const avatarEl =
          targetEl.querySelector?.('[data-member-avatar="true"], img, [data-avatar], .app-message-avatar, .rounded-lg, .rounded-xl, .rounded-full') ||
          targetEl.closest?.('.flex, li, button, div.group, .app-message-avatar')?.querySelector?.('[data-member-avatar="true"], img, [data-avatar], .app-message-avatar, .rounded-lg, .rounded-xl, .rounded-full') ||
          targetEl;

        const elToMeasure = (avatarEl as HTMLElement) || targetEl;
        const r = elToMeasure.getBoundingClientRect();

        let memberListLeft: number | undefined = undefined;
        let memberListRight: number | undefined = undefined;

        if (isMemberListDesktop && memberListDesktopEl) {
          const mlRect = memberListDesktopEl.getBoundingClientRect();
          memberListLeft = mlRect.left;
          memberListRight = mlRect.right;
        }

        setProfileAnchorRect({
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          isMemberListDesktop,
          memberListLeft,
          memberListRight,
        });
      } else if (typeof anchor === 'object' && 'getBoundingClientRect' in anchor && typeof (anchor as any).getBoundingClientRect === 'function') {
        const r = (anchor as any).getBoundingClientRect();
        setProfileAnchorRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
      } else if (typeof anchor === 'object' && 'left' in anchor && 'top' in anchor && !('clientX' in anchor)) {
        setProfileAnchorRect(anchor as AnchorRect);
      } else {
        setProfileAnchorRect(null);
      }
    } else {
      setProfileAnchorRect(null);
    }
    if (selectedUserProfile?.id === user.id) {
      setSelectedUserProfile({ ...user });
    } else {
      setSelectedUserProfile(user);
    }
  };

  // Disable default browser context menu globally; custom app context menus will continue working
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener('contextmenu', handleContextMenu);
    return () => {
      window.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);

  // Caching mechanism for instant browsing experience (SWR pattern)
  const channelsCache = useRef<Record<string, Channel[]>>(startupSnapshot?.channelsByServer || {});
  type MessageMemoryCache = {
    items: Message[];
    page: number;
    /** Backwards-compatible alias used by legacy UI callers. */
    hasMore: boolean;
    remoteHasMore?: boolean;
    cachedPagesAvailable?: number;
    newestCursor?: MessageCursor | null;
    oldestCursor?: MessageCursor | null;
  };
  const messagesCache = useRef<Record<string, MessageMemoryCache>>(
    Object.fromEntries(
      Object.entries(startupSnapshot?.newestMessages || {}).map(([conversationId, rawItems]) => {
        const items = Array.isArray(rawItems) ? rawItems as Message[] : [];
        return [conversationId, {
          items,
          page: 1,
          hasMore: true,
          remoteHasMore: true,
          cachedPagesAvailable: 1,
          newestCursor: getNewestCursor(items),
          oldestCursor: getOldestCursor(items),
        }] as const;
      })
    )
  );
  const serverMessagesCache = useRef<Record<string, Message[]>>({});
  const loadMessagesGenerationRef = useRef<Map<string, number>>(new Map());
  const loadChannelsGenerationRef = useRef<Map<string, number>>(new Map());
  const olderMessageRequestRef = useRef<Set<string>>(new Set());
  const prefetchedOlderPagesRef = useRef<Record<string, {
    items: Message[];
    hasMore: boolean;
    cursor: MessageCursor | null;
  } | null>>({});
  const prefetchingConversationsRef = useRef<Set<string>>(new Set());
  const previousMessageConversationRef = useRef<{ id: string; kind: 'channel' | 'dm' } | null>(null);
  const gatewayBootstrapRef = useRef<BootstrapResponse | null>(null);
  const gatewayBootstrapPromiseRef = useRef<Promise<BootstrapResponse | null> | null>(null);
  const gatewayBootstrapUserRef = useRef<string | null>(null);
  const gatewayBootstrapStateRef = useRef<'idle' | 'loading' | 'success' | 'retryable-failure'>('idle');
  const gatewayBootstrapFailureAtRef = useRef(0);
  const gatewayBootstrapEnabled = String((import.meta as any).env?.VITE_ENABLE_API_V2_BOOTSTRAP || '').toLowerCase() === 'true';

  // Refs for tracking changes without triggering re-renders in effects
  const channelsRef = useRef<Channel[]>([]);
  const activeChannelRef = useRef<Channel | null>(null);
  const currentUserRef = useRef<User | null>(null);
  const langRef = useRef<string>('en');
  const activeServerRef = useRef<Server | null>(null);
  const handleSelectNotificationRef = useRef<((notif: NotificationItem) => void) | null>(null);

  useEffect(() => { channelsRef.current = channels; }, [channels]);
  useEffect(() => { activeChannelRef.current = activeChannel; }, [activeChannel]);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);
  useEffect(() => { langRef.current = lang; }, [lang]);
  useEffect(() => { activeServerRef.current = activeServer; }, [activeServer]);

  // Keep the visible server list aligned with the users.in_servers relation
  // when PocketBase pushes a user-record update (join, leave, kick, or ban).
  // This prevents a stale server_members cache from keeping a removed server
  // mounted after the authoritative user record has changed.
  useEffect(() => {
    const relationIds = currentUser?.in_servers;
    if (!Array.isArray(relationIds)) return;
    const ids = new Set(relationIds.map((value: any) => typeof value === 'string' ? value : value?.id).filter(Boolean));
    setServers((previous) => previous.filter((server) => ids.has(server.id)));
    const active = activeServerRef.current;
    if (active && !ids.has(active.id)) {
      setActiveServer(null);
      setChannels([]);
      setActiveChannel(null);
      setActiveVoiceChannel(null);
      setShowDiscoveryCenter(true);
    }
  }, [currentUser?.id, currentUser?.in_servers]);

  // Keep the optional v2 read client bound to the same PocketBase session as
  // the legacy mutation/realtime layer.  The provider is cheap to install and
  // does not make a network request until the gateway flag is enabled.
  useEffect(() => {
    apiV2Client.setTokenProvider(() => {
      try {
        return pbService.getPbInstance().authStore.token || null;
      } catch {
        return null;
      }
    });
  }, [currentUser?.id]);

  /**
   * Optional v2 bootstrap. It is opt-in until the gateway is deployed on the
   * home VPS; when enabled, servers/channels/DM summaries share one
   * authenticated request and the legacy reads below are skipped. A failed
   * callers share one in-flight promise. Failures enter a short retryable
   * cooldown rather than permanently disabling bootstrap until logout.
   */
  const ensureGatewayBootstrap = async (): Promise<BootstrapResponse | null> => {
    const userId = currentUser?.id;
    if (!gatewayBootstrapEnabled || !userId) return null;
    if (gatewayBootstrapUserRef.current !== userId) {
      gatewayBootstrapUserRef.current = userId;
      gatewayBootstrapRef.current = null;
      gatewayBootstrapPromiseRef.current = null;
      gatewayBootstrapStateRef.current = 'idle';
      gatewayBootstrapFailureAtRef.current = 0;
    }
    if (gatewayBootstrapRef.current) return gatewayBootstrapRef.current;
    if (gatewayBootstrapPromiseRef.current) return gatewayBootstrapPromiseRef.current;
    if (
      gatewayBootstrapStateRef.current === 'retryable-failure' &&
      Date.now() - gatewayBootstrapFailureAtRef.current < 5000
    ) return null;

    gatewayBootstrapStateRef.current = 'loading';
    apiV2Client.setTokenProvider(() => {
      try {
        return pbService.getPbInstance().authStore.token || null;
      } catch {
        return null;
      }
    });
    const request = apiV2Client.bootstrap(activeServerRef.current?.id || null)
      .then((bootstrap) => {
        if (bootstrap?.user?.id && bootstrap.user.id === userId) {
          gatewayBootstrapRef.current = bootstrap;
          gatewayBootstrapStateRef.current = 'success';
          return bootstrap;
        }
        gatewayBootstrapStateRef.current = 'retryable-failure';
        gatewayBootstrapFailureAtRef.current = Date.now();
        return null;
      })
      .catch(() => {
        gatewayBootstrapStateRef.current = 'retryable-failure';
        gatewayBootstrapFailureAtRef.current = Date.now();
        return null;
      })
      .finally(() => {
        if (gatewayBootstrapPromiseRef.current === request) {
          gatewayBootstrapPromiseRef.current = null;
        }
      });
    gatewayBootstrapPromiseRef.current = request;
    return request;
  };

  // Availability is intentionally a small external store: read failures can
  // update the banner without making every message/cache mutation rerender the
  // whole workspace. The breaker is reset by the retry action below.
  useEffect(() => backendAvailability.subscribe((snapshot) => {
    setBackendStatus(snapshot.status);
    setBackendError(snapshot.lastError);
  }), []);

  // Keep a bounded synchronous snapshot for the next startup. Message pages
  // remain in IndexedDB; this payload is deliberately limited to the current
  // conversation's newest messages so localStorage reads stay cheap.
  const snapshotWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!currentUser?.id) return;
    if (snapshotWriteTimerRef.current) clearTimeout(snapshotWriteTimerRef.current);
    snapshotWriteTimerRef.current = setTimeout(() => {
      const conversationId = activeChannel?.id || null;
      writeSessionSnapshot({
        user: currentUser,
        servers,
        channelsByServer: {
          ...channelsCache.current,
          ...(activeServer?.id ? { [activeServer.id]: channels } : {}),
        },
        dms: allDmChannels,
        activeServerId: activeServer?.id || null,
        activeChannelId: conversationId,
        activeConversationKind: activeChannel?.server === 'dm' || activeChannel?.name?.startsWith('@') ? 'dm' : (activeChannel ? 'channel' : null),
        newestMessages: conversationId && messages.length > 0 ? { [conversationId]: messages.slice(-30) } : {},
      });
      snapshotWriteTimerRef.current = null;
    }, 250);
    return () => {
      if (snapshotWriteTimerRef.current) {
        clearTimeout(snapshotWriteTimerRef.current);
        snapshotWriteTimerRef.current = null;
      }
    };
  }, [currentUser?.id, servers, channels, allDmChannels, activeServer?.id, activeChannel?.id, messages]);

  // Initialize native Android & local notification channels and setup tap listeners
  useEffect(() => {
    let unsub: (() => void) | null = null;
    const cancel = afterFirstPaint(() => {
      notificationService.init();
      unsub = notificationService.onNotificationTapped((notif) => {
        if (handleSelectNotificationRef.current) {
          handleSelectNotificationRef.current(notif);
        }
      });
    });
    return () => {
      cancel();
      unsub?.();
    };
  }, []);

  useEffect(() => {
    if (activeChannel) {
      const isDm = Boolean(activeChannel.server === 'dm' || activeChannel.name?.startsWith('@'));
      if (isDm) {
        setActiveDmChannel(activeChannel);
      } else {
        setActiveServerChannel(activeChannel);
      }
    }
  }, [activeChannel]);

  // Track active modals and overlays in ref for back button handler
  const modalsStateRef = useRef({
    selectedUserProfile: null as User | null,
    showSettings: false,
    serverSettingsModalServer: null as Server | null,
    showCreateServer: false,
    showDiscoveryCenter: false,
    showNotificationsPopover: false,
    showNewDmModal: false,
    activeUpload: null as ActiveUploadState | null,
    isSidebarOpen: false,
  });

  useEffect(() => {
    modalsStateRef.current = {
      selectedUserProfile,
      showSettings,
      serverSettingsModalServer,
      showCreateServer,
      showDiscoveryCenter,
      showNotificationsPopover,
      showNewDmModal,
      activeUpload,
      isSidebarOpen,
    };
  }, [
    selectedUserProfile,
    showSettings,
    serverSettingsModalServer,
    showCreateServer,
    showDiscoveryCenter,
    showNotificationsPopover,
    showNewDmModal,
    activeUpload,
    isSidebarOpen,
  ]);

  // Register LIFO Back Stack handlers for top-level modals & overlays
  useBackHandler('app-user-profile', Boolean(selectedUserProfile), () => setSelectedUserProfile(null));
  useBackHandler('app-settings', showSettings, () => setShowSettings(false));
  useBackHandler('app-server-settings', Boolean(serverSettingsModalServer), () => setServerSettingsModalServer(null));
  useBackHandler('app-create-server', showCreateServer, () => setShowCreateServer(false));
  useBackHandler('app-discovery', showDiscoveryCenter, () => setShowDiscoveryCenter(false));
  useBackHandler('app-notifications-popover', showNotificationsPopover, () => setShowNotificationsPopover(false));
  useBackHandler('app-new-dm-modal', showNewDmModal, () => setShowNewDmModal(false));
  useBackHandler('app-active-upload', Boolean(activeUpload), () => setActiveUpload(null));
  useBackHandler('app-sidebar-drawer', isSidebarOpen, () => setIsSidebarOpen(false));

  // Native 1:1 Edge & Drag Gesture Manager for Mobile Sidebar Drawer
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      if (window.innerWidth >= 768) return;
      if (e.touches.length !== 1) return;

      if (showSettings || showCreateServer || selectedUserProfile || serverSettingsModalServer || showDiscoveryCenter) return;

      const touch = e.touches[0];
      const startX = touch.clientX;
      const startY = touch.clientY;
      const isRtl = lang === 'ar';
      const edgeThreshold = 35;

      let isTriggerable = false;

      if (!isSidebarOpen) {
        if (isRtl) {
          if (startX >= window.innerWidth - edgeThreshold) isTriggerable = true;
        } else {
          if (startX <= edgeThreshold) isTriggerable = true;
        }
      } else {
        isTriggerable = true;
      }

      if (isTriggerable) {
        sidebarTouchRef.current = {
          startX,
          startY,
          lastX: startX,
          lastTime: Date.now(),
          axis: null,
          initialIsOpen: isSidebarOpen,
          active: true,
        };
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!sidebarTouchRef.current || !sidebarTouchRef.current.active) return;
      const state = sidebarTouchRef.current;
      const touch = e.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - state.startX;
      const deltaY = touch.clientY - state.startY;

      if (state.axis === null) {
        if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 8) {
          state.axis = 'vertical';
          state.active = false;
          setSidebarDragState({ isDragging: false, dragX: 0, opacity: 0 });
          return;
        } else if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 8) {
          state.axis = 'horizontal';
        }
      }

      if (state.axis === 'horizontal') {
        if (e.cancelable) e.preventDefault();

        state.lastX = touch.clientX;
        state.lastTime = Date.now();

        const isRtl = lang === 'ar';
        const drawerWidth = window.innerWidth < 640 ? Math.min(window.innerWidth * 0.5, 280) : Math.min(window.innerWidth * 0.42, 340);
        let translateX = 0;

        if (!isRtl) {
          if (!state.initialIsOpen) {
            const dragDelta = Math.max(0, Math.min(drawerWidth, deltaX));
            translateX = -drawerWidth + dragDelta;
          } else {
            const dragDelta = Math.min(0, Math.max(-drawerWidth, deltaX));
            translateX = dragDelta;
          }
        } else {
          if (!state.initialIsOpen) {
            const dragDelta = Math.max(0, Math.min(drawerWidth, -deltaX));
            translateX = drawerWidth - dragDelta;
          } else {
            const dragDelta = Math.min(drawerWidth, Math.max(0, deltaX));
            translateX = dragDelta;
          }
        }

        const opacity = !isRtl
          ? Math.max(0, Math.min(1, (drawerWidth + translateX) / drawerWidth))
          : Math.max(0, Math.min(1, (drawerWidth - translateX) / drawerWidth));

        setSidebarDragState({
          isDragging: true,
          dragX: translateX,
          opacity,
        });
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!sidebarTouchRef.current || !sidebarTouchRef.current.active) return;
      const state = sidebarTouchRef.current;
      sidebarTouchRef.current = null;

      if (state.axis !== 'horizontal') {
        setSidebarDragState({ isDragging: false, dragX: 0, opacity: 0 });
        return;
      }

      const touch = e.changedTouches[0];
      const endX = touch ? touch.clientX : state.lastX;
      const elapsedTime = Math.max(1, Date.now() - state.lastTime);
      const velocityX = (endX - state.lastX) / elapsedTime;
      const totalDeltaX = endX - state.startX;
      const isRtl = lang === 'ar';
      const drawerWidth = window.innerWidth < 640 ? Math.min(window.innerWidth * 0.5, 280) : Math.min(window.innerWidth * 0.42, 340);
      const threshold = drawerWidth * 0.4;

      let shouldOpen = state.initialIsOpen;

      if (!isRtl) {
        if (!state.initialIsOpen) {
          if (totalDeltaX > threshold || velocityX > 0.25) shouldOpen = true;
        } else {
          if (totalDeltaX < -threshold || velocityX < -0.25) shouldOpen = false;
        }
      } else {
        if (!state.initialIsOpen) {
          if (totalDeltaX < -threshold || velocityX < -0.25) shouldOpen = true;
        } else {
          if (totalDeltaX > threshold || velocityX > 0.25) shouldOpen = false;
        }
      }

      setIsSidebarOpen(shouldOpen);
      setSidebarDragState({ isDragging: false, dragX: 0, opacity: 0 });
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [isSidebarOpen, lang, showSettings, showCreateServer, selectedUserProfile, serverSettingsModalServer, showDiscoveryCenter]);

  // Menu / Modal back navigation logic fallback for active channel / server
  const handleGoBackInMenu = (): boolean => {
    if (activeChannelRef.current) {
      setActiveChannel(null);
      return true;
    }

    if (activeServerRef.current) {
      setActiveServer(null);
      return true;
    }

    return false;
  };

  const isDesktop = useMemo(() => isDesktopPlatform(), []);
  const [exitToast, setExitToast] = useState<string | null>(null);
  const lastBackPressTimeRef = useRef<number>(0);

  // Hardware and browser back button listener
  useEffect(() => {
    try {
      window.history.pushState({ appNav: true }, '');
    } catch (e) {}

    let exitTimer: any = null;
    let disposed = false;

    const handleDoubleBackExit = () => {
      const now = Date.now();
      if (lastBackPressTimeRef.current && (now - lastBackPressTimeRef.current < 2000)) {
        if (exitTimer) clearTimeout(exitTimer);
        lastBackPressTimeRef.current = 0;
        setExitToast(null);
        void getCapacitorApp().then((capApp) => {
          if (!capApp) return;
          return capApp.exitApp().catch(() => capApp.minimizeApp().catch(() => {}));
        }).catch(() => {});
      } else {
        lastBackPressTimeRef.current = now;
        const msg = langRef.current === 'ar' ? 'اضغط رجوع مرة أخرى للخروج' : 'Press back again to exit';
        setExitToast(msg);
        if (exitTimer) clearTimeout(exitTimer);
        exitTimer = setTimeout(() => {
          setExitToast(null);
          lastBackPressTimeRef.current = 0;
        }, 2000);
      }
    };

    const triggerGlobalBack = () => {
      // 1. Pop most recent modal/sheet/dialog from LIFO BackStack Manager
      const handledByStack = backStackManager.handleBack();
      if (handledByStack) {
        return true;
      }

      // 2. Close open side panel (channel sidebar)
      if (isSidebarOpen) {
        setIsSidebarOpen(false);
        return true;
      }

      // 3. Leave voice channel and restore previous text channel context
      if (activeVoiceChannel || (activeChannel && activeChannel.type === 'voice')) {
        setActiveVoiceChannel(null);
        if (previousTextChannelRef.current) {
          setActiveChannel(previousTextChannelRef.current);
          previousTextChannelRef.current = null;
        }
        return true;
      }

      // 4. Fallback to channel/server menu navigation
      const handledByMenu = handleGoBackInMenu();
      if (handledByMenu) {
        return true;
      }

      // 5. Trigger double-back exit confirmation toast
      handleDoubleBackExit();
      return false;
    };

    const handlePopState = () => {
      const handled = triggerGlobalBack();
      try {
        window.history.pushState({ appNav: true }, '');
      } catch (e) {}
    };

    window.addEventListener('popstate', handlePopState);

    let capListener: any = null;
    void getCapacitorApp().then((capApp) => {
      if (disposed || !capApp) return;
      return capApp.addListener('backButton', () => {
        triggerGlobalBack();
      });
    }).then((l) => {
      if (l) capListener = l;
    }).catch(() => {});

    return () => {
      disposed = true;
      window.removeEventListener('popstate', handlePopState);
      if (capListener && typeof capListener.remove === 'function') {
        capListener.remove();
      }
    };
  }, []);

  // 1. Restore Auth Session on load
  useEffect(() => {
    const cancelPermissionSchedule = afterFirstPaint(() => {
      void requestNotificationPermission();
    });
    const user = pbService.getCurrentUser();
    const cachedSettings = getCachedUserSettings();
    if (user) {
      setCurrentUser(user);
      let userSet = user.settings;
      if (typeof userSet === 'string') {
        try { userSet = JSON.parse(userSet); } catch (e) {}
      }
      const merged = mergeWithDefaults({
        ...cachedSettings,
        ...(userSet || {}),
        appearance: {
          ...cachedSettings.appearance,
          ...(userSet?.appearance || {}),
        },
        languageRegion: {
          ...cachedSettings.languageRegion,
          ...(userSet?.languageRegion || {}),
        },
      });
      setUserSettings(merged);
      saveCachedUserSettings(merged);
      applySettingsToDocument(merged);

      // Restore user's saved language immediately
      const settingsLang = merged.languageRegion?.appLanguage;
      const rawPref = (user as any)?.preferred_language || (user as any)?.preferredLanguage || user?.language;
      let targetLang: 'en' | 'ar' | null = null;
      if (settingsLang === 'en' || settingsLang === 'ar') {
        targetLang = settingsLang;
      } else if (rawPref) {
        const lower = String(rawPref).toLowerCase().trim();
        if (lower.startsWith('ar') || lower.includes('arabic') || lower.includes('العربية')) targetLang = 'ar';
        else if (lower.startsWith('en') || lower.includes('english')) targetLang = 'en';
      }
      if (targetLang) {
        setLang(targetLang);
        localStorage.setItem('app_lang', targetLang);
      }
    } else {
      applySettingsToDocument(cachedSettings);
    }
    // Verify and refresh auth session only after the first usable frame. A
    // saved PocketBase session is already enough to paint the cached shell.
    const cancelAuthRefresh = user
      ? afterFirstPaint(() => {
          pbService.refreshAuth().then((refreshedUser) => {
            if (refreshedUser) {
              setCurrentUser(refreshedUser);
            } else if (!pbService.getCurrentUser()) {
              setCurrentUser(null);
            }
          }).catch(() => {});
        })
      : () => {};

    return () => {
      cancelPermissionSchedule();
      cancelAuthRefresh();
    };
  }, []);

  // 1a. Listen for session expiration events and reset user state cleanly
  useEffect(() => {
    const handleAuthExpired = () => {
      setCurrentUser(null);
    };
    window.addEventListener('auth-session-expired', handleAuthExpired);
    return () => window.removeEventListener('auth-session-expired', handleAuthExpired);
  }, []);

  // 1b. User presence heartbeat to signal real-time connectivity. Presence is
  // event-driven here: an always-on 25s PocketBase timer made an idle client
  // generate writes even when no one was using the app. Refresh on the first
  // paint, focus/visibility, and real user activity with a small throttle.
  useEffect(() => {
    if (!currentUser?.id) return;

    let isCancelled = false;
    let lastHeartbeatAt = 0;
    let heartbeatInFlight = false;

    const triggerHeartbeat = async (force = false) => {
      if (isCancelled) return;
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (!force && (heartbeatInFlight || now - lastHeartbeatAt < 30000)) return;
      heartbeatInFlight = true;
      lastHeartbeatAt = now;
      try {
        await pbService.sendHeartbeat(currentUser.id);
        const nowIso = new Date().toISOString();
        if (!isCancelled) {
          setCurrentUser(prev => prev ? { ...prev, last_seen: nowIso } : prev);
        }
      } catch (e) {
        console.warn('Presence heartbeat failed:', e);
      } finally {
        heartbeatInFlight = false;
      }
    };
    
    const cancelInitialHeartbeat = afterFirstPaint(() => {
      void triggerHeartbeat(true);
    });

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void triggerHeartbeat(true);
      }
    };
    const handleActivity = () => { void triggerHeartbeat(); };
    
    window.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleActivity);
    window.addEventListener('pointerdown', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });
    window.addEventListener('touchstart', handleActivity, { passive: true });

    return () => {
      isCancelled = true;
      cancelInitialHeartbeat();
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleActivity);
      window.removeEventListener('pointerdown', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
    };
  }, [currentUser?.id]);

  // 1c. Set user status to 'offline' when closing the tab/window
  useEffect(() => {
    if (!currentUser) return;

    const handleBeforeUnload = () => {
      try {
        const url = `${pbService.getServerUrl()}/api/collections/users/records/${currentUser.id}`;
        const body = JSON.stringify({ status: 'offline' });
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } catch (e) {
        console.warn('Failed to send offline beacon:', e);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [currentUser?.id]);

  // Real-time listener for server profile updates, ownership transfers, and leaves
  useEffect(() => {
    const handleServerUpdated = (e: CustomEvent) => {
      const { serverId, server, owner } = e.detail || {};
      if (!serverId) return;
      setServers((prev) =>
        prev.map((s) => {
          if (s.id === serverId) {
            return {
              ...s,
              ...(server || {}),
              ...(owner ? { owner } : {})
            };
          }
          return s;
        })
      );
      if (activeServer?.id === serverId) {
        setActiveServer((prev) =>
          prev
            ? {
                ...prev,
                ...(server || {}),
                ...(owner ? { owner } : {})
              }
            : null
        );
      }
    };

    const handleServerMemberUpdated = (e: CustomEvent) => {
      const { serverId, userId, is_member } = e.detail || {};
      if (!serverId || !userId) return;
      if (currentUser && userId === currentUser.id && is_member === false) {
        setServers((prev) => prev.filter((s) => s.id !== serverId));
        if (activeServer?.id === serverId) {
          setServers((prev) => {
            const remaining = prev.filter((s) => s.id !== serverId);
            if (remaining.length > 0) {
              setActiveServer(remaining[0]);
              loadChannels(remaining[0].id);
            } else {
              setActiveServer(null);
              setChannels([]);
              setActiveChannel(null);
              setShowDiscoveryCenter(true);
            }
            return remaining;
          });
        }
      }
    };

    window.addEventListener('server-updated', handleServerUpdated as EventListener);
    window.addEventListener('server-member-updated', handleServerMemberUpdated as EventListener);
    return () => {
      window.removeEventListener('server-updated', handleServerUpdated as EventListener);
      window.removeEventListener('server-member-updated', handleServerMemberUpdated as EventListener);
    };
  }, [activeServer?.id, currentUser?.id]);

  // 1d. Subscribe to App Config for real-time Database URL changes across connected clients
  useEffect(() => {
    const unsub = pbService.subscribeToAppConfig((newUrl) => {
      if (newUrl && newUrl !== pbService.getServerUrl()) {
        console.log('Syncing updated database URL from admin config:', newUrl);
        pbService.setServerUrl(newUrl);
        setServerUrl(newUrl);
        localStorage.setItem('sirver_pb_url', newUrl);
      }
    });
    return () => unsub();
  }, []);

  // 1e. Load user's saved notifications from database on login
  useEffect(() => {
    if (!currentUser?.id) return;
    if (currentUser.notifications) {
      if (typeof currentUser.notifications === 'string') {
        try {
          const parsed = JSON.parse(currentUser.notifications);
          if (Array.isArray(parsed)) {
            setNotificationsList(parsed.filter((n) => !isEphemeralCallNotification(n)));
          }
        } catch (e) {}
      } else if (Array.isArray(currentUser.notifications)) {
        setNotificationsList(currentUser.notifications.filter((n) => !isEphemeralCallNotification(n)));
      }
      return;
    }

    return afterFirstPaint(() => {
      pbService.getUserNotifications(currentUser.id).then((notifs) => {
        if (notifs && notifs.length > 0) {
          setNotificationsList(notifs.filter((n) => !isEphemeralCallNotification(n)));
        }
      }).catch(() => {});
    });
  }, [currentUser?.id]);

  // Sync unread counts from loaded unread notifications so badges persist accurately across reloads
  useEffect(() => {
    if (notificationsList.length > 0) {
      const unreadFromNotifs: Record<string, UnreadChannelInfo> = {};
      notificationsList.forEach((n) => {
        if (!n.read) {
          const isDm = n.type === 'dm' || n.channel_id === 'dm' || n.channel_id?.startsWith('dm-') || n.channel_id?.startsWith('dm-server-') || !!n.private_chat_id || n.server_id === 'dm';
          const rawChanId = n.channel_id || '';
          const chanId = isDm
            ? (rawChanId && rawChanId !== 'dm' ? rawChanId : (n.private_chat_id ? `dm-server-${n.private_chat_id}` : 'dm'))
            : rawChanId;
          
          if (!chanId) return;

          const srvId = isDm ? 'dm' : (n.server_id && n.server_id !== 'dm' ? n.server_id : '');
          const isMention = n.type === 'mention' || n.type === 'reply' || n.type === 'dm';

          if (!unreadFromNotifs[chanId]) {
            unreadFromNotifs[chanId] = {
              channelId: chanId,
              serverId: srvId,
              count: 1,
              hasMention: isMention,
              lastMentionMsgId: n.message_id
            };
          } else {
            unreadFromNotifs[chanId].count += 1;
            if (isMention) {
              unreadFromNotifs[chanId].hasMention = true;
            }
            if (n.message_id && !unreadFromNotifs[chanId].lastMentionMsgId) {
              unreadFromNotifs[chanId].lastMentionMsgId = n.message_id;
            }
          }
        }
      });

      setUnreadCounts((prev) => {
        const updated = { ...prev };
        Object.keys(unreadFromNotifs).forEach((cId) => {
          if (!updated[cId]) {
            updated[cId] = unreadFromNotifs[cId];
          } else {
            updated[cId] = {
              ...updated[cId],
              serverId: unreadFromNotifs[cId].serverId || updated[cId].serverId,
              hasMention: updated[cId].hasMention || unreadFromNotifs[cId].hasMention,
              lastMentionMsgId: updated[cId].lastMentionMsgId || unreadFromNotifs[cId].lastMentionMsgId
            };
          }
        });
        return updated;
      });
    }
  }, [notificationsList]);
  useEffect(() => {
    const initTranslations = async () => {
      try {
        const records = await pbService.fetchTranslations();
        const config = getLanguageDictionary(records, lang);
        setLangConfig(config);
      } catch (err) {
        console.warn('Error loading translations:', err);
      }
    };
    return afterFirstPaint(() => {
      void initTranslations();
    });
  }, [lang]);

  // 3. Fetch servers on login / toggle modes
  useEffect(() => {
    if (!currentUser?.id) return;
    return afterFirstPaint(() => {
      void loadServers();
    });
  }, [currentUser?.id, isDemo]);

  // In-memory instant DM channels cache per user
  const inMemoryDmCacheRef = useRef<Map<string, Channel[]>>(new Map());

  const loadAllDmChannels = async () => {
    if (!currentUser?.id) return;
    const userId = currentUser.id;

    // 1. Instant sync load from in-memory / local cache for 0ms transition
    let cachedDms = inMemoryDmCacheRef.current.get(userId) || offlineCacheService.getDmChannelsSync(userId) || pbService.getCachedDmChannels(userId);
    if (cachedDms && cachedDms.length > 0) {
      inMemoryDmCacheRef.current.set(userId, cachedDms);
      const visible = cachedDms.filter(
        (c) =>
          !closedDmIds.has(c.id) &&
          (!c.recipientUser?.id ||
            (!closedDmIds.has(c.recipientUser.id) &&
              !closedDmIds.has(`dm-user-${c.recipientUser.id}`)))
      );
      setAllDmChannels(visible);
    } else {
      // 2. Fast load cached DM channels from IndexedDB if not in sync cache
      try {
        const idbCachedDms = await offlineCacheService.getDmChannels(userId);
        if (idbCachedDms && idbCachedDms.length > 0) {
          inMemoryDmCacheRef.current.set(userId, idbCachedDms);
          pbService.setCachedDmChannels(userId, idbCachedDms);
          const visible = idbCachedDms.filter(
            (c) =>
              !closedDmIds.has(c.id) &&
              (!c.recipientUser?.id ||
                (!closedDmIds.has(c.recipientUser.id) &&
                  !closedDmIds.has(`dm-user-${c.recipientUser.id}`)))
          );
          setAllDmChannels(visible);
        }
      } catch (e) {
        console.warn('Failed to load cached DMs from IndexedDB:', e);
      }
    }

    const bootstrap = await ensureGatewayBootstrap();
    if (bootstrap && Array.isArray(bootstrap.dms)) {
      const normalizedDms: Channel[] = bootstrap.dms
        .filter((dm) => dm?.id && dm.counterpart?.id)
        .map((dm) => ({
          id: /^(?:dm-server-|dm-)/.test(dm.id) ? dm.id : `dm-server-${dm.id}`,
          name: `@${dm.counterpart.username}`,
          type: 'text' as const,
          server: 'dm',
          description: `Direct Messages with ${dm.counterpart.display_name || dm.counterpart.username}`,
          recipientUser: dm.counterpart,
          created: dm.created || dm.updated || new Date().toISOString(),
        }));
      const visible = normalizedDms.filter(
        (c) => !closedDmIds.has(c.id) && !closedDmIds.has(c.recipientUser?.id || '') && !closedDmIds.has(`dm-user-${c.recipientUser?.id || ''}`),
      );
      inMemoryDmCacheRef.current.set(userId, visible);
      pbService.setCachedDmChannels(userId, visible);
      setAllDmChannels(visible);
      void offlineCacheService.saveDmChannels(userId, visible);
      return;
    }

    // 3. Non-blocking background sync from PocketBase. A tunnel outage must
    // not fan this read into a users-directory request or compatibility
    // waterfall; the cached DM list above remains usable in that case.
    if (!backendAvailability.canRequest()) return;
    try {
      const userChatServers = await pbService.getUserPrivateChatServers();
      if (!backendAvailability.canRequest()) return;
      const currentId = currentUser?.id;
      const counterpartIds = Array.from(new Set(
        userChatServers.flatMap((cs: any) => {
          const users = cs.users || [cs.user1, cs.user2].filter(Boolean);
          return users.filter((uid: string) => uid && uid !== currentId);
        }),
      ));
      const allUsers = await pbService.fetchUsersByIds(counterpartIds);

      const dynamicDmChannels: Channel[] = [];
      const seenRecipientIds = new Set<string>();

      for (const cs of userChatServers) {
        const usersInServer = cs.users || [cs.user1, cs.user2].filter(Boolean);
        const otherUserId = usersInServer.find((uid: string) => uid !== currentId) || usersInServer[0];
        const otherUser = allUsers.find((u) => u.id === otherUserId);
        if (otherUser && !seenRecipientIds.has(otherUser.id)) {
          const chanId = `dm-server-${cs.id}`;
          const isClosed =
            closedDmIds.has(chanId) ||
            closedDmIds.has(otherUser.id) ||
            closedDmIds.has(`dm-user-${otherUser.id}`);
          if (!isClosed) {
            seenRecipientIds.add(otherUser.id);
            dynamicDmChannels.push({
              id: chanId,
              name: `@${otherUser.username}`,
              type: 'text',
              server: 'dm',
              description: `Direct Messages with ${otherUser.display_name || otherUser.username}`,
              recipientUser: otherUser,
              created: cs.created || new Date().toISOString()
            });
          }
        }
      }

      // Diff check: compare with existing to avoid unnecessary React re-renders/flashes
      const prevList = inMemoryDmCacheRef.current.get(userId) || [];
      const hasChanged =
        prevList.length !== dynamicDmChannels.length ||
        dynamicDmChannels.some((newChan, idx) => {
          const oldChan = prevList[idx];
          return !oldChan || oldChan.id !== newChan.id || oldChan.created !== newChan.created || oldChan.recipientUser?.avatar !== newChan.recipientUser?.avatar;
        });

      if (hasChanged || prevList.length === 0) {
        inMemoryDmCacheRef.current.set(userId, dynamicDmChannels);
        pbService.setCachedDmChannels(userId, dynamicDmChannels);
        setAllDmChannels(dynamicDmChannels);
        offlineCacheService.saveDmChannels(userId, dynamicDmChannels);
      }
    } catch (err) {
      console.warn('Failed to load DM channels:', err);
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    return afterFirstPaint(() => {
      void loadAllDmChannels();
    });
  }, [currentUser]);

  // 4. Fetch channels when active server changes
  useEffect(() => {
    if (activeServer) {
      return afterFirstPaint(() => {
        void loadChannels(activeServer.id);
      });
    } else {
      setChannels([]);
      setActiveChannel(null);
    }
  }, [activeServer?.id]);

  // Persist current active server and channel to localStorage when selection changes
  useEffect(() => {
    if (activeServer) {
      localStorage.setItem('last_active_server_id', activeServer.id);
      localStorage.setItem('last_active_conversation_type', 'server');
    }
  }, [activeServer?.id]);

  useEffect(() => {
    if (activeServer && activeChannel && activeChannel.type === 'text') {
      localStorage.setItem(`last_active_channel_id_${activeServer.id}`, activeChannel.id);
    }
    if (activeChannel) {
      const isDm = activeChannel.server === 'dm' || activeChannel.name.startsWith('@');
      if (isDm) {
        setActiveDmChannel(activeChannel);
        localStorage.setItem('last_active_dm_id', activeChannel.id);
        localStorage.setItem('last_active_conversation_type', 'dm');
      } else {
        setActiveServerChannel(activeChannel);
      }
    }
  }, [activeServer?.id, activeChannel?.id]);

  // 5a. Fetch channel messages when active channel changes
  useEffect(() => {
    if (activeChannel && activeChannel.type === 'text') {
      const kind: 'channel' | 'dm' = activeChannel.server === 'dm' || activeChannel.name.startsWith('@') ? 'dm' : 'channel';
      const previous = previousMessageConversationRef.current;
      if (previous && previous.id !== activeChannel.id) {
        pbService.cancelMessageHistory(previous.id, previous.kind);
        olderMessageRequestRef.current.delete(previous.id);
      }
      previousMessageConversationRef.current = { id: activeChannel.id, kind };
      const cached = messagesCache.current[activeChannel.id] || offlineCacheService.getCachedMessagesSync(activeChannel.id);
      if (cached && cached.items && cached.items.length > 0) {
        messagesCache.current[activeChannel.id] = cached;
        const initialPage = cached.items.slice(Math.max(0, cached.items.length - INITIAL_MESSAGE_PAGE_SIZE));
        setMessages(initialPage);
        setHasMoreMessages(cached.remoteHasMore ?? true);
        setMessagesPage(cached.page || 1);
        // Keep the sync flag true until the single background newest-page
        // request settles. ChatPanel still renders this cached page immediately
        // and uses the flag only to prevent the top sentinel racing that fetch.
        setIsInitialLoadingChannel(true);
      } else {
        setMessages([]);
        setMessagesPage(1);
        setHasMoreMessages(true);
        setIsInitialLoadingChannel(true);
      }
      const conversationId = activeChannel.id;
      return afterFirstPaint(() => {
        void loadMessages(conversationId, 1, false, null, INITIAL_MESSAGE_PAGE_SIZE);
      });
    } else {
      if (previousMessageConversationRef.current) {
        pbService.cancelMessageHistory(previousMessageConversationRef.current.id, previousMessageConversationRef.current.kind);
        previousMessageConversationRef.current = null;
      }
      setMessages([]);
      setIsInitialLoadingChannel(false);
    }
  }, [activeChannel?.id]);

  // 5b. Server-wide history is not needed for the chat UI.  Older versions
  // fetched 100 messages on every server switch solely for ping detection,
  // amplifying latency and request volume. Realtime events update this cache
  // when it is already present; never perform a broad background read here.
  useEffect(() => {
    if (!activeServer) {
      setServerMessages([]);
      return;
    }

    const serverId = activeServer.id;
    setServerMessages(serverMessagesCache.current[serverId] || []);
  }, [activeServer?.id]);

  // 5c. Global Realtime SSE subscriptions for Server Channels & Direct Messages (Runs whenever user is logged in)
  useEffect(() => {
    if (!currentUser?.id) return;

    // Subscribe to ALL message events across channels and servers
    const unsubscribe = pbService.subscribeToMessages('*', async (e) => {
      const currentActiveChan = activeChannelRef.current;
      const currentCurrUser = currentUserRef.current;
      const currentLang = langRef.current;
      const currentServer = activeServerRef.current;

      if (e.action === 'create' || e.action === 'update') {
        const senderId = e.record.sender;
        const senderObj = e.record.expand?.sender;
        const senderName = senderObj?.display_name || senderObj?.username || 'User';
        const isMe = currentCurrUser && senderId === currentCurrUser.id;

        // The PocketBase adapter emits one normalized realtime event. Do not
        // refetch the same record here; relation data is hydrated by the
        // normal page request or a dedicated attachment event.
        const fullMsg = e.record;

        const isCurrentlyViewing = !!(currentActiveChan && currentActiveChan.id === fullMsg.channel);

        if (e.action === 'create' && currentCurrUser && !isMe) {
          const content = (fullMsg.content || '').toLowerCase();
          const usernameLower = (currentCurrUser.username || '').toLowerCase();
          const displayNameLower = (currentCurrUser.display_name || '').toLowerCase();

          const hasMention = (usernameLower && content.includes(`@${usernameLower}`)) ||
            (displayNameLower && content.includes(`@${displayNameLower}`));

          const isReplyToMe = fullMsg.reply_to && messages.some((m) => m.id === fullMsg.reply_to && m.sender === currentCurrUser.id);
          const isDmMsg = fullMsg.channel.startsWith('dm-server-') ||
            fullMsg.channel.startsWith('dm-') ||
            fullMsg.channel === 'dm' ||
            allDmChannels.some((d) => d.id === fullMsg.channel) ||
            (fullMsg.expand?.channel && (fullMsg.expand.channel as any).server === 'dm');

          // Determine originating server ID and channel (DMs must ALWAYS be 'dm')
          const msgChannelObj = channels.find((c) => c.id === fullMsg.channel) || (currentActiveChan?.id === fullMsg.channel ? currentActiveChan : null);
          let msgServerId = '';
          if (isDmMsg) {
            msgServerId = 'dm';
          } else if (fullMsg.expand?.channel && (fullMsg.expand.channel as any).server) {
            msgServerId = (fullMsg.expand.channel as any).server;
          } else if (msgChannelObj && msgChannelObj.server) {
            msgServerId = msgChannelObj.server;
          } else if (currentActiveChan && currentActiveChan.id === fullMsg.channel && currentServer && currentActiveChan.server !== 'dm') {
            msgServerId = currentServer.id;
          }

          const userSettingsObj = userSettings || getCachedUserSettings();
          const notifSettings = userSettingsObj.notifications || {};

          const mentionAllowed = hasMention && notifSettings.mentionNotifications !== false;
          const replyAllowed = isReplyToMe && notifSettings.replyNotifications !== false;
          const isPingEvent = mentionAllowed || replyAllowed || isDmMsg;

          const soundsEnabled = notifSettings.mentionSounds !== false && notifSettings.sound !== false;
          const desktopEnabled = notifSettings.desktopMentions !== false && notifSettings.pushNotifications !== false;
          const highlightEnabled = notifSettings.mentionHighlight !== false;

          if (isCurrentlyViewing) {
            // User is already inside this channel:
            // Do NOT add navigation badges. Instead, play sound and highlight message in-chat.
            if (isPingEvent) {
              if (soundsEnabled) playPingSound();
              if (highlightEnabled) setTargetMessageId(fullMsg.id);
            }
          } else {
            // User is NOT inside this channel
            const isCallLogOrSignal =
              fullMsg.content?.startsWith('INCOMING_CALL:') ||
              fullMsg.content?.includes('INCOMING_CALL:') ||
              fullMsg.content?.startsWith('[CALL_LOG:') ||
              fullMsg.content?.includes('CALL_LOG:') ||
              parseCallLog(fullMsg.content) !== null;

            if (isCallLogOrSignal) {
              if (fullMsg.content?.includes('INCOMING_CALL:')) {
                callSignalingService.handleIncomingCallPayload(fullMsg.content);
              }
              return;
            }

            if (isPingEvent) {
              if (soundsEnabled) playPingSound();

              if (notifSettings.mentionNotifications !== false) {
                setActiveToast({
                  id: fullMsg.id,
                  title: senderName,
                  body: fullMsg.content || (currentLang === 'ar' ? 'أرسل مرفقاً جديداً' : 'Sent an attachment'),
                  avatar: senderObj?.avatar ? `${pbService.getServerUrl()}/api/files/users/${senderId}/${senderObj.avatar}` : undefined,
                  senderName: senderName,
                  type: hasMention ? 'ping' : isDmMsg ? 'dm' : 'reply',
                  channelId: fullMsg.channel
                });

                const notifItem: NotificationItem = {
                  id: 'notif-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
                  type: hasMention ? 'mention' : isDmMsg ? 'dm' : 'reply',
                  sender_id: senderId,
                  sender_name: senderName,
                  sender_avatar: senderObj?.avatar ? `${pbService.getServerUrl()}/api/files/users/${senderId}/${senderObj.avatar}` : undefined,
                  channel_id: fullMsg.channel,
                  channel_name: msgChannelObj?.name || 'channel',
                  server_id: msgServerId,
                  message_id: fullMsg.id,
                  message_content: fullMsg.content || '',
                  created: fullMsg.created || new Date().toISOString(),
                  read: false
                };

                setNotificationsList((prev) => [notifItem, ...prev.filter((n) => n.id !== notifItem.id)]);
                pbService.addNotificationToUser(currentCurrUser.id, notifItem);

                if (desktopEnabled) {
                  sendInAppNotification(
                    hasMention
                      ? (currentLang === 'ar' ? `إشارة جديدة من ${senderName}` : `New Mention from ${senderName}`)
                      : isDmMsg
                      ? (currentLang === 'ar' ? `رسالة خاصة من ${senderName}` : `Direct Message from ${senderName}`)
                      : (currentLang === 'ar' ? `رد على رسالتك من ${senderName}` : `Reply from ${senderName}`),
                    fullMsg.content || (currentLang === 'ar' ? 'مرفق جديد' : 'New Attachment'),
                    senderObj?.avatar ? `${pbService.getServerUrl()}/api/files/users/${senderId}/${senderObj.avatar}` : undefined,
                    () => handleSelectNotification(notifItem)
                  );
                }
              }
            }

            // Update unread counts for channel and its exact server_id
            setUnreadCounts((prev) => {
              const currentUnread = prev[fullMsg.channel] || {
                channelId: fullMsg.channel,
                serverId: msgServerId,
                count: 0,
                hasMention: false
              };
              return {
                ...prev,
                [fullMsg.channel]: {
                  channelId: fullMsg.channel,
                  serverId: msgServerId,
                  count: currentUnread.count + 1,
                  hasMention: currentUnread.hasMention || isPingEvent,
                  lastMentionMsgId: isPingEvent ? fullMsg.id : currentUnread.lastMentionMsgId
                }
              };
            });
          }
        }

        if (currentServer) {
          setServerMessages((prev) => {
            const existingIdx = prev.findIndex((m) => m.id === fullMsg.id);
            if (existingIdx === -1) {
              const updated = mergeMessagePage(prev, [fullMsg], MAX_ACTIVE_MESSAGES);
              serverMessagesCache.current[currentServer.id] = updated;
              return updated;
            }
            const prevMsg = prev[existingIdx];
            const incomingAtts =
              fullMsg.expand?.['attachments(message)'] ||
              fullMsg.expand?.['private_attachments(message)'] ||
              fullMsg.expand?.attachments_via_message;
            const prevAtts =
              prevMsg.expand?.['attachments(message)'] ||
              prevMsg.expand?.['private_attachments(message)'] ||
              prevMsg.expand?.attachments_via_message;
            const effectiveAtts = (incomingAtts && incomingAtts.length > 0) ? incomingAtts : prevAtts;

            const nextMsg: Message = {
              ...prevMsg,
              ...fullMsg,
              reactions: fullMsg.reactions !== undefined ? fullMsg.reactions : prevMsg.reactions,
              expand: {
                ...(prevMsg.expand || {}),
                ...(fullMsg.expand || {}),
                ...(effectiveAtts && effectiveAtts.length > 0 ? {
                  'attachments(message)': effectiveAtts,
                  'private_attachments(message)': effectiveAtts,
                  attachments_via_message: effectiveAtts,
                  private_attachments_via_message: effectiveAtts,
                } : {})
              }
            };
            if (isSingleMessageEqual(prevMsg, nextMsg)) {
              return prev;
            }
            const updated = [...prev];
            updated[existingIdx] = nextMsg;
            serverMessagesCache.current[currentServer.id] = updated;
            return updated;
          });
        }

        if (currentActiveChan && fullMsg.channel === currentActiveChan.id) {
          setMessages((prev) => {
            const incomingSenderId = typeof fullMsg.sender === 'string'
              ? fullMsg.sender
              : (fullMsg as any).sender_id || (fullMsg as any).user || fullMsg.expand?.sender?.id;
            const incomingContent = (fullMsg.content || '').trim();
            const existingIdx = prev.findIndex(
              (m) =>
                m.id === fullMsg.id ||
                ((m as any).temp_id && (fullMsg as any).temp_id && (m as any).temp_id === (fullMsg as any).temp_id) ||
                ((m as any).temp_id && (m.sender === incomingSenderId || (m.expand?.sender?.id && m.expand.sender.id === incomingSenderId)) && (m.content || '').trim() === incomingContent) ||
                (m.id.startsWith('optimistic-') && (m.sender === incomingSenderId || (m.expand?.sender?.id && m.expand.sender.id === incomingSenderId)) && (m.content || '').trim() === incomingContent)
            );

            if (existingIdx === -1) {
              const updated = mergeMessagePage(prev, [fullMsg], MAX_ACTIVE_MESSAGES);
              if (messagesCache.current[currentActiveChan.id]) {
                messagesCache.current[currentActiveChan.id].items = updated;
              }
              return updated;
            }

            const prevMsg = prev[existingIdx];
            const matchedTempId = (prevMsg as any).temp_id || (prevMsg.id.startsWith('optimistic-') ? prevMsg.id : undefined);
            const incomingAtts =
              fullMsg.expand?.['attachments(message)'] ||
              fullMsg.expand?.['private_attachments(message)'] ||
              fullMsg.expand?.attachments_via_message;
            const prevAtts =
              prevMsg.expand?.['attachments(message)'] ||
              prevMsg.expand?.['private_attachments(message)'] ||
              prevMsg.expand?.attachments_via_message;
            const effectiveAtts = (incomingAtts && incomingAtts.length > 0) ? incomingAtts : prevAtts;

            const nextMsg: Message = {
              ...prevMsg,
              ...fullMsg,
              reactions: fullMsg.reactions !== undefined ? fullMsg.reactions : prevMsg.reactions,
              temp_id: matchedTempId || (fullMsg as any).temp_id,
              expand: {
                ...(prevMsg.expand || {}),
                ...(fullMsg.expand || {}),
                ...(effectiveAtts && effectiveAtts.length > 0 ? {
                  'attachments(message)': effectiveAtts,
                  'private_attachments(message)': effectiveAtts,
                  attachments_via_message: effectiveAtts,
                  private_attachments_via_message: effectiveAtts,
                } : {})
              }
            };

            // If the message is visually unchanged (e.g. identical reactions after optimistic update), return prev to avoid re-render flicker
            if (isSingleMessageEqual(prevMsg, nextMsg)) {
              return prev;
            }

            const updated = [...prev];
            updated[existingIdx] = nextMsg;

            if (messagesCache.current[currentActiveChan.id]) {
              messagesCache.current[currentActiveChan.id].items = updated;
            }
            return updated;
          });
        } else if (fullMsg.channel) {
          if (messagesCache.current[fullMsg.channel]) {
            const existing = messagesCache.current[fullMsg.channel].items || [];
            if (!existing.some((m) => m.id === fullMsg.id)) {
              messagesCache.current[fullMsg.channel].items = mergeMessagePage(existing, [fullMsg], MAX_ACTIVE_MESSAGES);
            }
          }
        }
        if (fullMsg.channel) {
          offlineCacheService.mergeChannelMessages(fullMsg.channel, [fullMsg]);
        }
      } else if (e.action === 'delete') {
        if (e.record?.channel) {
          offlineCacheService.mergeChannelMessages(e.record.channel, [], undefined, undefined, [e.record.id]);
        }
        if (currentServer) {
          setServerMessages((prev) => {
            const updated = MessageDeletionService.transformMessagesOnDeletion(prev, e.record.id, currentLang);
            serverMessagesCache.current[currentServer.id] = updated;
            return updated;
          });
        }
        if (currentActiveChan && e.record.channel === currentActiveChan.id) {
          setMessages((prev) => {
            const updated = MessageDeletionService.transformMessagesOnDeletion(prev, e.record.id, currentLang);
            if (messagesCache.current[currentActiveChan.id]) {
              messagesCache.current[currentActiveChan.id].items = updated;
            }
            return updated;
          });

          const currentPins = currentActiveChan.pinned_messages || (currentActiveChan as any).Pinned_messages || [];
          if (currentPins.includes(e.record.id)) {
            const newPins = currentPins.filter((id) => id !== e.record.id);
            setActiveChannel({
              ...currentActiveChan,
              pinned_messages: newPins,
              Pinned_messages: newPins
            });
          }
        }
      }
    });

    // Subscribe to ALL private message events across private chats
    const unsubscribePrivate = pbService.subscribeToPrivateMessages('*', async (e: any) => {
      const currentCurrUser = currentUserRef.current;
      const currentLang = langRef.current;
      const currentActiveChan = activeChannelRef.current;

      if (!currentCurrUser || !e.record) return;

      const senderId = e.record.sender || e.record.user;
      const isMe = senderId === currentCurrUser.id;
      const chatServerId = e.record.chat_server;
      const dmChannelId = `dm-server-${chatServerId}`;

      let fullMsg = e.record;
      if (!fullMsg.expand?.sender) {
        try {
          // Realtime events should enrich only the sender that arrived, not
          // refetch the entire user directory for every DM message.
          const senderObj = (await pbService.fetchUsersByIds([senderId]))[0];
          if (senderObj) {
            fullMsg.expand = { ...fullMsg.expand, sender: senderObj };
          }
        } catch (err) {}
      }

      // Check if current active channel matches this DM conversation
      const isCurrentlyViewingDM = !!(currentActiveChan && (
        currentActiveChan.id === dmChannelId ||
        currentActiveChan.id === chatServerId ||
        (currentActiveChan.recipientUser && (currentActiveChan.recipientUser.id === senderId || (isMe && currentActiveChan.recipientUser.id === e.record.recipient))) ||
        (fullMsg.expand?.sender?.username && currentActiveChan.name === `@${fullMsg.expand.sender.username}`)
      ));

      const targetChanId = currentActiveChan && isCurrentlyViewingDM ? currentActiveChan.id : dmChannelId;

      if (e.action === 'create') {
        const msgWithChannel = { ...fullMsg, channel: targetChanId };

        if (isCurrentlyViewingDM && currentActiveChan) {
          setMessages((prev) => {
            const incomingContent = (fullMsg.content || '').trim();
            const existingIdx = prev.findIndex(
              (m) =>
                m.id === fullMsg.id ||
                ((m as any).temp_id && (fullMsg as any).temp_id && (m as any).temp_id === (fullMsg as any).temp_id) ||
                ((m as any).temp_id && (m.sender === senderId || (m.expand?.sender?.id && m.expand.sender.id === senderId)) && (m.content || '').trim() === incomingContent) ||
                (m.id.startsWith('optimistic-') && (m.sender === senderId || (m.expand?.sender?.id && m.expand.sender.id === senderId)) && (m.content || '').trim() === incomingContent)
            );

            let updated: Message[];
            if (existingIdx !== -1) {
              const prevMsg = prev[existingIdx];
              const matchedTempId = (prevMsg as any).temp_id || (prevMsg.id.startsWith('optimistic-') ? prevMsg.id : undefined);
              const incomingAtts =
                fullMsg.expand?.['attachments(message)'] ||
                fullMsg.expand?.['private_attachments(message)'] ||
                fullMsg.expand?.attachments_via_message;
              const prevAtts =
                prevMsg.expand?.['attachments(message)'] ||
                prevMsg.expand?.['private_attachments(message)'] ||
                prevMsg.expand?.attachments_via_message;
              const effectiveAtts = (incomingAtts && incomingAtts.length > 0) ? incomingAtts : prevAtts;

              updated = [...prev];
              updated[existingIdx] = {
                ...prevMsg,
                ...msgWithChannel,
                temp_id: matchedTempId || (fullMsg as any).temp_id,
                expand: {
                  ...(prevMsg.expand || {}),
                  ...(fullMsg.expand || {}),
                  ...(effectiveAtts && effectiveAtts.length > 0 ? {
                    'attachments(message)': effectiveAtts,
                    'private_attachments(message)': effectiveAtts,
                    attachments_via_message: effectiveAtts,
                    private_attachments_via_message: effectiveAtts,
                  } : {})
                }
              };
            } else {
              updated = mergeMessagePage(prev, [msgWithChannel], MAX_ACTIVE_MESSAGES);
            }

            if (messagesCache.current[currentActiveChan.id]) {
              messagesCache.current[currentActiveChan.id].items = updated;
            }
            if (messagesCache.current[dmChannelId]) {
              messagesCache.current[dmChannelId].items = updated;
            }
            return updated;
          });
        } else {
          if (messagesCache.current[dmChannelId]) {
            const cachedItems = messagesCache.current[dmChannelId].items || [];
            if (!cachedItems.some((m) => m.id === fullMsg.id)) {
              messagesCache.current[dmChannelId].items = mergeMessagePage(cachedItems, [msgWithChannel], MAX_ACTIVE_MESSAGES);
            }
          }
        }

        // Notification & sound ONLY for incoming messages from others when not currently viewing
        if (e.action === 'create' && !isMe) {
          const senderObj = fullMsg.expand?.sender;
          const senderName = senderObj?.display_name || senderObj?.username || 'User';

          // Check if message is a call log or call signaling event
          const isCallLogOrSignal =
            fullMsg.content?.startsWith('INCOMING_CALL:') ||
            fullMsg.content?.includes('INCOMING_CALL:') ||
            fullMsg.content?.startsWith('[CALL_LOG:') ||
            fullMsg.content?.includes('CALL_LOG:') ||
            parseCallLog(fullMsg.content) !== null;

          if (isCallLogOrSignal) {
            if (fullMsg.content?.includes('INCOMING_CALL:')) {
              callSignalingService.handleIncomingCallPayload(fullMsg.content);
            }
            return;
          }

          if (!isCurrentlyViewingDM) {
            playPingSound();

            const notifItem: NotificationItem = {
              id: 'notif-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
              type: 'dm',
              sender_id: senderId,
              sender_name: senderName,
              sender_avatar: senderObj?.avatar ? `${pbService.getServerUrl()}/api/files/users/${senderId}/${senderObj.avatar}` : undefined,
              channel_id: dmChannelId,
              channel_name: '@' + senderName,
              server_id: 'dm',
              private_chat_id: chatServerId,
              message_id: fullMsg.id,
              message_content: fullMsg.content || '',
              created: fullMsg.created || new Date().toISOString(),
              read: false
            };

            setActiveToast({
              id: fullMsg.id,
              title: currentLang === 'ar' ? `رسالة خاصة من ${senderName}` : `Direct Message from ${senderName}`,
              body: fullMsg.content || (currentLang === 'ar' ? 'أرسل مرفقاً جديداً' : 'Sent an attachment'),
              avatar: senderObj?.avatar ? `${pbService.getServerUrl()}/api/files/users/${senderId}/${senderObj.avatar}` : undefined,
              senderName: senderName,
              type: 'dm',
              channelId: dmChannelId,
              serverId: 'dm',
              onClick: () => handleSelectNotification(notifItem)
            });

            setNotificationsList((prev) => [notifItem, ...prev.filter((n) => n.id !== notifItem.id)]);
            pbService.addNotificationToUser(currentCurrUser.id, notifItem);

            sendInAppNotification(
              currentLang === 'ar' ? `رسالة خاصة من ${senderName}` : `Direct Message from ${senderName}`,
              fullMsg.content || (currentLang === 'ar' ? 'مرفق جديد' : 'New Attachment'),
              senderObj?.avatar ? `${pbService.getServerUrl()}/api/files/users/${senderId}/${senderObj.avatar}` : undefined,
              () => handleSelectNotification(notifItem)
            );

            setUnreadCounts((prev) => {
              const currentUnread = prev[dmChannelId] || { channelId: dmChannelId, serverId: 'dm', count: 0, hasMention: true };
              return {
                ...prev,
                [dmChannelId]: {
                  ...currentUnread,
                  count: currentUnread.count + 1,
                  hasMention: true
                }
              };
            });
          }
        }

        // Automatic DM list order & timestamp refresh
        setAllDmChannels((prevDms) => {
          const targetIndex = prevDms.findIndex((c) => c.id === dmChannelId || c.id.endsWith(chatServerId));
          if (targetIndex !== -1) {
            const updatedChan = { ...prevDms[targetIndex], created: fullMsg.created || new Date().toISOString() };
            const remaining = prevDms.filter((_, idx) => idx !== targetIndex);
            return [updatedChan, ...remaining];
          } else {
            loadAllDmChannels();
            return prevDms;
          }
        });

        offlineCacheService.mergeChannelMessages(targetChanId, [msgWithChannel]);

      } else if (e.action === 'delete' && e.record?.id) {
        offlineCacheService.mergeChannelMessages(dmChannelId, [], undefined, undefined, [e.record.id]);
        if (isCurrentlyViewingDM) {
          setMessages((prev) => MessageDeletionService.transformMessagesOnDeletion(prev, e.record.id, currentLang));
        }
        if (messagesCache.current[dmChannelId]) {
          messagesCache.current[dmChannelId].items = MessageDeletionService.transformMessagesOnDeletion(
            messagesCache.current[dmChannelId].items,
            e.record.id,
            currentLang
          );
        }
      } else if (e.action === 'update' && e.record?.id) {
        const updatedRecord = e.record;
        if (isCurrentlyViewingDM) {
          setMessages((prev) => {
            const existingIdx = prev.findIndex((m) => m.id === updatedRecord.id);
            if (existingIdx === -1) return prev;
            const prevMsg = prev[existingIdx];
            const nextMsg: Message = {
              ...prevMsg,
              ...updatedRecord,
              reactions: updatedRecord.reactions !== undefined ? updatedRecord.reactions : prevMsg.reactions,
              channel: targetChanId,
              expand: updatedRecord.expand || prevMsg.expand
            };
            if (isSingleMessageEqual(prevMsg, nextMsg)) {
              return prev;
            }
            const updated = [...prev];
            updated[existingIdx] = nextMsg;
            if (messagesCache.current[currentActiveChan.id]) {
              messagesCache.current[currentActiveChan.id].items = updated;
            }
            if (messagesCache.current[dmChannelId]) {
              messagesCache.current[dmChannelId].items = updated;
            }
            return updated;
          });
        } else {
          if (messagesCache.current[dmChannelId]) {
            messagesCache.current[dmChannelId].items = (messagesCache.current[dmChannelId].items || []).map((m) =>
              m.id === updatedRecord.id
                ? { ...m, ...updatedRecord, channel: dmChannelId, expand: updatedRecord.expand || m.expand }
                : m
            );
          }
        }
        offlineCacheService.mergeChannelMessages(targetChanId, [{
          ...updatedRecord,
          channel: targetChanId,
        } as Message]);
      }
    });

    const unsubscribeUsers = pbService.subscribeToUsers((e: any) => {
      if (e?.record?.id) {
        const activeUserId = currentUserRef.current?.id;
        if (e.record.id === activeUserId) {
          const userRec = e.record;
          setCurrentUser((prev) => (prev ? mergeUserRecord(prev, userRec) : prev));

          // Sync remote notifications list and dispatch notifications for new items
          let remoteNotifs: NotificationItem[] = [];
          if (userRec.notifications) {
            if (typeof userRec.notifications === 'string') {
              try { remoteNotifs = JSON.parse(userRec.notifications); } catch {}
            } else if (Array.isArray(userRec.notifications)) {
              remoteNotifs = userRec.notifications;
            }
          }

          setNotificationsList((prevList) => {
            const existingIds = new Set(prevList.map((n) => n.id));
            const newUnreadItems = remoteNotifs.filter(
              (rn) => !existingIds.has(rn.id) && !rn.read && rn.sender_id !== activeUserId
            );

            newUnreadItems.forEach((nItem) => {
              const contentStr = nItem.message_content || nItem.message || '';
              const isSignal =
                contentStr.startsWith('INCOMING_CALL:') ||
                contentStr.includes('INCOMING_CALL:') ||
                contentStr.startsWith('CALL_SIGNAL:') ||
                contentStr.includes('CALL_SIGNAL:');
              const isCallLog =
                contentStr.startsWith('[CALL_LOG:') ||
                contentStr.includes('CALL_LOG:') ||
                parseCallLog(contentStr) !== null;

              if (isSignal) {
                // Pass directly to Call Signaling so FloatingCallWindow handles incoming call with Answer/Reject/Mute
                callSignalingService.handleIncomingCallPayload(contentStr || nItem);
                return;
              }

              if (isCallLog) {
                return;
              }

              notificationService.sendNotification(nItem, { lang: langRef.current });

              setActiveToast({
                id: nItem.id,
                title: nItem.sender_name || 'Sirver Notification',
                body: nItem.message_content || nItem.message || '',
                avatar: nItem.sender_avatar,
                senderName: nItem.sender_name,
                type: nItem.type === 'friend_request' ? 'ping' : nItem.type === 'dm' ? 'dm' : 'reply',
                channelId: nItem.channel_id || 'dm',
                onClick: () => {
                  if (handleSelectNotificationRef.current) {
                    handleSelectNotificationRef.current(nItem);
                  }
                }
              });
            });

            const cleanRemoteNotifs = remoteNotifs.filter((rn) => !isEphemeralCallNotification(rn));

            return cleanRemoteNotifs;
          });
        }

        setSelectedUserProfile((prev) => (prev && prev.id === e.record.id ? mergeUserRecord(prev, e.record) : prev));
        setAllDmChannels((prev) =>
          prev.map((dm) => {
            if (dm.recipientUser?.id === e.record.id) {
              return { ...dm, recipientUser: mergeUserRecord(dm.recipientUser, e.record) };
            }
            return dm;
          })
        );
        try {
          window.dispatchEvent(new CustomEvent('user-presence-changed', { detail: e.record }));
        } catch (err) {}
      }
    });


    return () => {
      unsubscribe();
      unsubscribePrivate();
      unsubscribeUsers();
    };
  }, [currentUser?.id]);


  // --- CORE SERVICES ---

  const loadServers = async () => {
    // This flag must also become true when the IndexedDB read completes after
    // the function starts. Otherwise an offline response of `[]` can replace
    // a perfectly usable cached server list with the discovery screen.
    let hadCachedServers = servers.length > 0 || Boolean(activeServerRef.current);
    // 1. Instantly display cached servers synchronously (0ms)
    if (currentUser?.id) {
      const syncServers = offlineCacheService.getServersSync(currentUser.id);
      const isLastDm = localStorage.getItem('last_active_conversation_type') === 'dm' || activeChannelRef.current?.server === 'dm' || Boolean(activeChannelRef.current?.name?.startsWith('@'));
      if (syncServers && syncServers.length > 0) {
        hadCachedServers = true;
        setServers(syncServers);
        if (!isLastDm && !activeServerRef.current) {
          const savedServerId = localStorage.getItem('last_active_server_id');
          const restoredServer = syncServers.find((s) => s.id === savedServerId) || syncServers[0];
          setActiveServer(restoredServer);
          setShowDiscoveryCenter(false);
        }
      } else {
        // Fallback to IndexedDB async lookup
        try {
          const cachedServers = await offlineCacheService.getServers(currentUser.id);
          if (cachedServers && cachedServers.length > 0) {
            hadCachedServers = true;
            setServers(cachedServers);
            if (!isLastDm && !activeServerRef.current) {
              const savedServerId = localStorage.getItem('last_active_server_id');
              const restoredServer = cachedServers.find((s) => s.id === savedServerId) || cachedServers[0];
              setActiveServer(restoredServer);
              setShowDiscoveryCenter(false);
            }
          }
        } catch (e) {
          console.warn('Failed to load cached servers from IndexedDB:', e);
        }
      }
    }

    // 2. Optional gateway bootstrap. The shell/cache has already rendered;
    // this single request replaces the server + DM + channel read waterfall
    // when the v2 gateway is enabled in the deployment environment.
    const bootstrap = await ensureGatewayBootstrap();
    if (bootstrap) {
      const bootstrapServers = Array.isArray(bootstrap.servers) ? bootstrap.servers : [];
      const relation = currentUser?.in_servers;
      const list = Array.isArray(relation)
        ? bootstrapServers.filter((server) => pbService.isUserInServer(server.id, currentUser))
        : bootstrapServers;
      setServers((prev) => {
        if (prev.length === list.length && prev.every((s, i) => s.id === list[i]?.id && s.name === list[i]?.name && s.icon === list[i]?.icon)) return prev;
        return list;
      });
      if (currentUser?.id) void offlineCacheService.saveServers(currentUser.id, list);
      const preferredId = bootstrap.activeServerId && list.some((server) => server.id === bootstrap.activeServerId)
        ? bootstrap.activeServerId
        : activeServerRef.current?.id && list.some((server) => server.id === activeServerRef.current?.id)
          ? activeServerRef.current.id
          : list[0]?.id;
      const preferredServer = list.find((server) => server.id === preferredId);
      if (preferredServer) {
        setActiveServer(preferredServer);
        setShowDiscoveryCenter(false);
        if (bootstrap.activeServerId === preferredServer.id && Array.isArray(bootstrap.channels)) {
          channelsCache.current[preferredServer.id] = bootstrap.channels;
          setChannels(bootstrap.channels);
          void offlineCacheService.saveChannels(preferredServer.id, bootstrap.channels);
        }
      } else if (!hadCachedServers) {
        setActiveServer(null);
        setChannels([]);
        setActiveChannel(null);
        setShowDiscoveryCenter(true);
      }
      return;
    }

    // 3. Background sync with server
    if (!backendAvailability.canRequest()) return;
    try {
      const list = await pbService.fetchServers();
      setServers((prev) => {
        // An empty result from a timed-out/offline compatibility path is not a
        // valid membership snapshot. Keep the last known servers visible.
        if (list.length === 0 && prev.length > 0) return prev;
        if (
          prev.length === list.length &&
          prev.every((s, i) => s.id === list[i]?.id && s.name === list[i]?.name && s.icon === list[i]?.icon && s.banner === list[i]?.banner)
        ) {
          return prev;
        }
        return list;
      });

      if (currentUser?.id && list.length > 0) {
        offlineCacheService.saveServers(currentUser.id, list);
      }

      if (list.length > 0) {
        const isLastDm = localStorage.getItem('last_active_conversation_type') === 'dm' || activeChannelRef.current?.server === 'dm' || Boolean(activeChannelRef.current?.name?.startsWith('@'));
        if (!isLastDm && !activeServerRef.current) {
          const savedServerId = localStorage.getItem('last_active_server_id');
          const restoredServer = list.find((s) => s.id === savedServerId) || list[0];
          setActiveServer(restoredServer);
          setShowDiscoveryCenter(false);
        }
      } else {
        if (!hadCachedServers) setShowDiscoveryCenter(true);
      }
    } catch (err) {
      console.error('Failed to load servers:', err);
    }
  };

  const loadChannels = async (serverId: string) => {
    const generation = (loadChannelsGenerationRef.current.get(serverId) || 0) + 1;
    loadChannelsGenerationRef.current.set(serverId, generation);
    const isCurrentRequest = () =>
      loadChannelsGenerationRef.current.get(serverId) === generation &&
      activeServerRef.current?.id === serverId;
    // 1. Instantly check synchronous in-memory & local cache (0ms)
    let cachedList = channelsCache.current[serverId] || offlineCacheService.getChannelsSync(serverId) || pbService.getCachedChannels(serverId);
    if (!cachedList || cachedList.length === 0) {
      try {
        const dbChannels = await offlineCacheService.getChannels(serverId);
        if (dbChannels && dbChannels.length > 0) {
          cachedList = dbChannels;
          channelsCache.current[serverId] = cachedList;
          pbService.setCachedChannels(serverId, cachedList);
        }
      } catch (e) {}
    }

    const currentActive = activeChannelRef.current;
    const isCurrentActiveInThisServer = currentActive && currentActive.server === serverId;

    if (cachedList && cachedList.length > 0) {
      channelsCache.current[serverId] = cachedList;
      setChannels(cachedList);
      
      if (!isCurrentActiveInThisServer) {
        const savedChannelId = localStorage.getItem(`last_active_channel_id_${serverId}`);
        const restoredChannel = cachedList.find((c) => c.id === savedChannelId);
        
        if (restoredChannel) {
          setActiveChannel(restoredChannel);
        } else {
          const defaultTextChan = cachedList.find((c) => c.type === 'text');
          if (defaultTextChan) {
            setActiveChannel(defaultTextChan);
          } else if (cachedList.length > 0) {
            setActiveChannel(cachedList[0]);
          }
        }
      }
    }

    // The gateway bootstrap already includes channels for the selected
    // server. Reuse that result instead of issuing a second public request.
    const bootstrap = await ensureGatewayBootstrap();
    if (bootstrap?.activeServerId === serverId && Array.isArray(bootstrap.channels)) {
      channelsCache.current[serverId] = bootstrap.channels;
      setChannels(bootstrap.channels);
      void offlineCacheService.saveChannels(serverId, bootstrap.channels);
      return;
    }

    // 3. Background sync from server
    if (!backendAvailability.canRequest()) return;
    try {
      const list = await pbService.fetchChannels(serverId);
      if (!isCurrentRequest()) return;
      channelsCache.current[serverId] = list;
      setChannels((prev) => {
        if (
          prev.length === list.length &&
          prev.every((c, i) => c.id === list[i]?.id && c.name === list[i]?.name && c.topic === list[i]?.topic && c.type === list[i]?.type)
        ) {
          return prev;
        }
        return list;
      });
      offlineCacheService.saveChannels(serverId, list);
      
      const currentActiveNow = activeChannelRef.current;
      const isCurrentActiveInThisServerNow = currentActiveNow && currentActiveNow.server === serverId;

      if (!isCurrentActiveInThisServerNow) {
        const savedChannelId = localStorage.getItem(`last_active_channel_id_${serverId}`);
        const restoredChannel = list.find((c) => c.id === savedChannelId);
        
        if (restoredChannel) {
          setActiveChannel(restoredChannel);
        } else {
          const defaultTextChan = list.find((c) => c.type === 'text');
          if (defaultTextChan) {
            setActiveChannel(defaultTextChan);
          } else if (list.length > 0) {
            setActiveChannel(list[0]);
          }
        }
      } else {
        const matchingChan = list.find((c) => c.id === currentActiveNow.id);
        if (matchingChan && (matchingChan.name !== currentActiveNow.name || matchingChan.topic !== currentActiveNow.topic)) {
          setActiveChannel(matchingChan);
        }
      }
    } catch (err) {
      console.error('Failed to load channels:', err);
    }
  };

  /**
   * Older message pages render without attachment expansion so the cursor
   * request stays small. Hydrate any attachments in one background batch and
   * merge only those records into the current channel; never replace the
   * message window that may have changed while the request was in flight.
   */
  const hydrateOlderMessageAttachments = (conversationId: string, pageItems: Message[], isPrivate: boolean) => {
    if (!pageItems.some((message) => message?.has_attachment)) return;

    void pbService.hydrateMessageAttachments(pageItems, isPrivate).then((hydratedItems) => {
      const hydratedById = new Map(
        hydratedItems
          .filter((message) => message?.id && message.expand && (
            message.expand['attachments(message)']?.length ||
            message.expand['private_attachments(message)']?.length
          ))
          .map((message) => [message.id, message]),
      );
      if (hydratedById.size === 0) return;

      const entry = messagesCache.current[conversationId];
      if (entry) {
        const updatedItems = entry.items.map((message) => {
          const hydrated = hydratedById.get(message.id);
          return hydrated ? { ...message, ...hydrated, expand: { ...(message.expand || {}), ...(hydrated.expand || {}) } } : message;
        });
        messagesCache.current[conversationId] = {
          ...entry,
          items: dedupeMessages(updatedItems, MAX_ACTIVE_MESSAGES),
          oldestCursor: getOldestCursor(updatedItems),
          newestCursor: getNewestCursor(updatedItems),
        };
      }

      if (activeChannelRef.current?.id === conversationId) {
        setMessages((previous) => previous.map((message) => {
          const hydrated = hydratedById.get(message.id);
          return hydrated ? { ...message, ...hydrated, expand: { ...(message.expand || {}), ...(hydrated.expand || {}) } } : message;
        }));
      }
    }).catch(() => {
      // Attachment hydration is best effort; the already-rendered message page
      // remains usable and can be hydrated again by a later refresh.
    });
  };

  const loadMessages = async (channelId: string, pageNum = 1, append = false, targetMessageId: string | null = null, limit = 10, retryCount = 0) => {
    const nextGeneration = (loadMessagesGenerationRef.current.get(channelId) || 0) + 1;
    loadMessagesGenerationRef.current.set(channelId, nextGeneration);
    const requestIsCurrent = () => loadMessagesGenerationRef.current.get(channelId) === nextGeneration;
    const requestLimit = append ? OLDER_MESSAGE_PAGE_SIZE : INITIAL_MESSAGE_PAGE_SIZE;
    const targetChan = activeChannelRef.current?.id === channelId ? activeChannelRef.current : channels.find((c) => c.id === channelId);
    if (targetChan?.type === 'voice') {
      if (activeChannelRef.current?.id === channelId) {
        setMessages([]);
        setIsInitialLoadingChannel(false);
      }
      return;
    }
    if (!append && pageNum === 1) {
      // 1. Check synchronous in-memory L1 cache first
      let cached = messagesCache.current[channelId] || offlineCacheService.getCachedMessagesSync(channelId);
      // 2. Check IndexedDB persistent cache if missing from memory
      if (!cached || !cached.items || cached.items.length === 0) {
        try {
          const dbCached = await offlineCacheService.getCachedMessages(channelId);
          if (dbCached && dbCached.items && dbCached.items.length > 0) {
            cached = {
              items: dbCached.items,
              page: dbCached.page,
              hasMore: dbCached.hasMore !== undefined ? dbCached.hasMore : true,
                // Legacy cache rows predate the separate remote cursor state.
                // Treat them as potentially incomplete and let the next cursor
                // request establish exhaustion instead of hiding older pages.
                remoteHasMore: (dbCached as any).remoteHasMore ?? true,
              cachedPagesAvailable: (dbCached as any).cachedPagesAvailable ?? 0,
              oldestCursor: (dbCached as any).oldestCursor ?? null,
              newestCursor: (dbCached as any).newestCursor ?? null,
            };
            messagesCache.current[channelId] = cached;
          }
        } catch (e) {}
      }

      if (activeChannelRef.current?.id === channelId && requestIsCurrent()) {
        if (cached && cached.items && cached.items.length > 0) {
          const initialPage = cached.items.slice(Math.max(0, cached.items.length - INITIAL_MESSAGE_PAGE_SIZE));
          setMessages((prev) => (areMessagesEqual(prev, initialPage) ? prev : initialPage));
           setHasMoreMessages(cached.remoteHasMore ?? true);
          setMessagesPage(cached.page || 1);
          setIsInitialLoadingChannel(true);
        } else {
          setMessages([]);
          setHasMoreMessages(true);
          setIsInitialLoadingChannel(true);
        }
      }
    }

    if (!backendAvailability.canRequest()) {
      if (activeChannelRef.current?.id === channelId) {
        setIsLoadingMore(false);
        setIsInitialLoadingChannel(false);
      }
      return;
    }

    // When the v2 gateway is deployed, use its single cursor contract for
    // both public channels and DMs.  A gateway failure is intentionally a
    // typed outage (and not a signal to fan out into legacy compatibility
    // reads); cached rows remain visible and the circuit breaker throttles
    // subsequent navigation until the service recovers.
    const gatewayKind: 'channel' | 'dm' | null = targetChan
      ? (targetChan.server === 'dm' || targetChan.name.startsWith('@') ? 'dm' : 'channel')
      : null;
    if (gatewayBootstrapEnabled && gatewayKind) {
      const currentEntry = messagesCache.current[channelId];
      // DM channels keep the legacy `dm-server-*` UI/cache key. The v2
      // gateway addresses the underlying PocketBase private_chat_servers
      // record, so strip that presentation prefix only for the request.
      const gatewayConversationId = gatewayKind === 'dm' && channelId.startsWith('dm-server-')
        ? channelId.slice('dm-server-'.length)
        : channelId;
      const cursor = append
        ? (currentEntry?.oldestCursor || getOldestCursor(currentEntry?.items))
        : null;
      try {
        if (append && activeChannelRef.current?.id === channelId) setIsLoadingMore(true);
        const page = await apiV2Client.messages<Message>(gatewayKind, gatewayConversationId, requestLimit, cursor);
        if (!requestIsCurrent()) return;
        // Normalize the gateway's canonical conversation shape back to the
        // legacy React/Tauri message shape. In particular, `sender` must stay
        // an ID (not the expanded user object), and DM rows must use the
        // prefixed UI channel key for replies, realtime matching, and caches.
        const gatewayItems = (Array.isArray(page.items) ? page.items : []).map((item: any) => {
          const expandedSender = item?.expand?.sender || (item?.sender && typeof item.sender === 'object' ? item.sender : undefined);
          const senderId = typeof item?.sender === 'string'
            ? item.sender
            : item?.sender_id || expandedSender?.id || item?.user || '';
          return {
            ...item,
            sender: senderId,
            sender_id: senderId,
            channel: channelId,
            conversation_id: channelId,
            expand: {
              ...(item?.expand || {}),
              ...(expandedSender ? { sender: expandedSender } : {}),
            },
          } as Message;
        });
        const gatewayPage = { ...page, items: gatewayItems } as MessagePage<Message>;
        const existing = currentEntry?.items || (activeChannelRef.current?.id === channelId ? messages : []);
        const mergedItems = append
          ? mergeOlderMessagePage(existing, gatewayPage.items, MAX_ACTIVE_MESSAGES)
          : mergeMessagePage(existing, gatewayPage.items, MAX_ACTIVE_MESSAGES);
        const nextEntry = {
          items: mergedItems,
          page: append ? pageNum : 1,
          hasMore: gatewayPage.hasMore,
          remoteHasMore: gatewayPage.hasMore,
          cachedPagesAvailable: Math.max(1, currentEntry?.cachedPagesAvailable || 0) + (append ? 1 : 0),
          newestCursor: getNewestCursor(mergedItems),
          oldestCursor: getOldestCursor(mergedItems),
        };
        messagesCache.current[channelId] = nextEntry;
        if (activeChannelRef.current?.id === channelId && requestIsCurrent()) {
          setMessages((prev) => append
            ? mergeOlderMessagePage(prev, gatewayPage.items, MAX_ACTIVE_MESSAGES)
            : mergeMessagePage(prev, gatewayPage.items, MAX_ACTIVE_MESSAGES));
          setHasMoreMessages(gatewayPage.hasMore);
          setMessagesPage(append ? pageNum : 1);
        }
        offlineCacheService.enqueueMessagePersistence(
          gatewayKind,
          channelId,
          gatewayPage,
          cursor,
          append ? pageNum : 1,
        );
      } catch (error) {
        console.warn(`Gateway ${gatewayKind} message read failed:`, error);
      } finally {
        if (activeChannelRef.current?.id === channelId) {
          setIsLoadingMore(false);
          setIsInitialLoadingChannel(false);
        }
      }
      return;
    }

    // Resolve the conversation from the requested ID, not whichever channel
    // happens to be active now. Fast navigation can leave an older request in
    // flight; this prevents it from querying a DM as a public channel (or
    // vice versa) before the generation guard discards its result.
    const isDmChan = Boolean(targetChan && (targetChan.name.startsWith('@') || targetChan.server === 'dm'));
    if (isDmChan && targetChan) {
      const targetUsername = targetChan.name.replace(/^@/, '');
      let targetUser = targetChan.recipientUser;
      let chatServerId = channelId.startsWith('dm-server-') ? channelId.replace(/^dm-server-/, '') : undefined;
      const cachedEntry = messagesCache.current[channelId];
      const currentDataset = (activeChannelRef.current?.id === channelId && messages.length > 0)
        ? messages
        : (cachedEntry?.items || []);
      const cursor = append
        ? (getOldestCursor(currentDataset) || cachedEntry?.oldestCursor)
        : null;

      try {
        if (append && activeChannelRef.current?.id === channelId) {
          setIsLoadingMore(true);
        }

        if (!targetUser || !targetUser.id) {
          const foundInDms = allDmChannels.find((c) => c.recipientUser?.username?.toLowerCase() === targetUsername.toLowerCase())?.recipientUser;
          if (foundInDms) {
            targetUser = foundInDms;
          } else if (targetUsername) {
            const matchingUsers = await pbService.searchUsers(targetUsername);
            targetUser = matchingUsers.find((u) => u.username.toLowerCase() === targetUsername.toLowerCase());
          }
        }

        // A DM that cannot resolve its counterpart is not a public channel.
        // Stop this generation here instead of falling through to a second
        // request against the messages collection with a DM id.
        if (!targetUser?.id) return;

        if (!chatServerId) {
          const cachedServer = pbService.getCachedPrivateChatServer(targetUser.id);
          chatServerId = cachedServer?.id;
        }
        const page = await pbService.fetchDirectMessagesPage(
          targetUser.id,
          chatServerId,
          cursor,
          requestLimit,
          { deferAttachments: append },
        );
        if (!requestIsCurrent()) return;

        const existing = cachedEntry?.items || (activeChannelRef.current?.id === channelId ? messages : []);
        // Refreshing the newest DM page must retain the newest side of the
        // bounded window. Only an explicit older-history request prepends.
        const mergedItems = append
          ? mergeOlderMessagePage(existing, page.items, MAX_ACTIVE_MESSAGES)
          : mergeMessagePage(existing, page.items, MAX_ACTIVE_MESSAGES);
        const remoteHasMore = page.hasMore;
        const nextEntry = {
          items: mergedItems,
          page: pageNum,
          hasMore: remoteHasMore,
          remoteHasMore,
          cachedPagesAvailable: Math.max(1, cachedEntry?.cachedPagesAvailable || 0) + (append ? 1 : 0),
          newestCursor: getNewestCursor(mergedItems),
          oldestCursor: getOldestCursor(mergedItems),
        };
        messagesCache.current[channelId] = nextEntry;
        if (activeChannelRef.current?.id === channelId && requestIsCurrent()) {
          setMessages((prev) => append
            ? mergeOlderMessagePage(prev, page.items, MAX_ACTIVE_MESSAGES)
            : mergeMessagePage(prev, page.items, MAX_ACTIVE_MESSAGES));
          setHasMoreMessages(remoteHasMore);
          setMessagesPage(pageNum);
        }
        if (append) hydrateOlderMessageAttachments(channelId, page.items, true);
        offlineCacheService.enqueueMessagePersistence('dm', channelId, page, cursor, pageNum);
        if (remoteHasMore) {
          setTimeout(() => prefetchNextOlderPage(channelId, true), 100);
        }

        if ((import.meta as any).env?.DEV) {
          console.log(`[PAGINATION_DEBUG] DM Channel: ${channelId} | cursor=${cursor ? `${cursor.created}/${cursor.id}` : 'initial'} | returned=${page.items.length} | hasMore=${page.hasMore}`);
        }
        return;
      } catch (e: any) {
        if (!isClientCancellation(e)) {
          // If this was a timeout on an initial load or pagination, give it one immediate retry with extended timeout
          const isTimeout = e?.code === 'TIMEOUT' || e?.status === 408 || /timed? ?out/i.test(e?.message || '');
          if (isTimeout && !retryCount && requestIsCurrent() && targetUser?.id) {
            try {
              const retryPage = await pbService.fetchDirectMessagesPage(
                targetUser.id,
                chatServerId,
                cursor,
                requestLimit,
                { timeoutMs: 20000, deferAttachments: append },
              );
              if (!requestIsCurrent()) return;
              const existing = cachedEntry?.items || (activeChannelRef.current?.id === channelId ? messages : []);
              const mergedItems = append
                ? mergeOlderMessagePage(existing, retryPage.items, MAX_ACTIVE_MESSAGES)
                : mergeMessagePage(existing, retryPage.items, MAX_ACTIVE_MESSAGES);
              const remoteHasMore = retryPage.hasMore;
              const nextEntry = {
                items: mergedItems,
                page: pageNum,
                hasMore: remoteHasMore,
                remoteHasMore,
                cachedPagesAvailable: Math.max(1, cachedEntry?.cachedPagesAvailable || 0) + (append ? 1 : 0),
                newestCursor: getNewestCursor(mergedItems),
                oldestCursor: getOldestCursor(mergedItems),
              };
              messagesCache.current[channelId] = nextEntry;
              if (activeChannelRef.current?.id === channelId && requestIsCurrent()) {
                setMessages((prev) => append
                  ? mergeOlderMessagePage(prev, retryPage.items, MAX_ACTIVE_MESSAGES)
                  : mergeMessagePage(prev, retryPage.items, MAX_ACTIVE_MESSAGES));
                setHasMoreMessages(remoteHasMore);
                setMessagesPage(pageNum);
              }
              if (append) hydrateOlderMessageAttachments(channelId, retryPage.items, true);
              offlineCacheService.enqueueMessagePersistence('dm', channelId, retryPage, cursor, pageNum);
              return;
            } catch (retryErr) {
              if (!isClientCancellation(retryErr)) {
                console.warn('Error loading direct messages after retry:', retryErr);
              }
              return;
            }
          }
          console.warn('Error loading direct messages from private_chat_servers:', e);
        }
        // Do not retry the same DM as a public channel after an unavailable
        // private_messages request. Cached messages remain visible and the
        // caller can retry explicitly once the backend recovers.
        return;
      } finally {
        if (activeChannelRef.current?.id === channelId) {
          setIsLoadingMore(false);
          setIsInitialLoadingChannel(false);
        }
      }
    }

    try {
      if (append && activeChannelRef.current?.id === channelId) {
        setIsLoadingMore(true);
      }

      if (append) {
        // Cursor pagination: the id tie-breaker is calculated from the oldest
        // message in the active cache, so equal-timestamp rows are not skipped.
        const currentEntry = messagesCache.current[channelId];
        const currentDataset = (activeChannelRef.current?.id === channelId && messages.length > 0)
          ? messages
          : (currentEntry?.items || []);
        const oldestCursor = getOldestCursor(currentDataset) || currentEntry?.oldestCursor;
        const page = await pbService.fetchMessagesPage(channelId, oldestCursor, requestLimit, { deferAttachments: true });
        if (!requestIsCurrent()) return;

        const mergedItems = mergeOlderMessagePage(currentDataset, page.items, MAX_ACTIVE_MESSAGES);
        const remoteHasMore = page.hasMore;
        messagesCache.current[channelId] = {
          items: mergedItems,
          page: pageNum,
          hasMore: remoteHasMore,
          remoteHasMore,
          cachedPagesAvailable: (currentEntry?.cachedPagesAvailable || 0) + 1,
          newestCursor: getNewestCursor(mergedItems),
          oldestCursor: getOldestCursor(mergedItems),
        };
        if (activeChannelRef.current?.id === channelId) {
          setMessages((prev) => mergeOlderMessagePage(prev, page.items, MAX_ACTIVE_MESSAGES));
          setHasMoreMessages(remoteHasMore);
        }
        hydrateOlderMessageAttachments(channelId, page.items, false);
        offlineCacheService.enqueueMessagePersistence('channel', channelId, page, oldestCursor, pageNum);
        if (remoteHasMore) {
          setTimeout(() => prefetchNextOlderPage(channelId, false), 100);
        }
        if ((import.meta as any).env?.DEV) {
          console.log(`[PAGINATION_DEBUG] Appending channel cursor=${oldestCursor ? `${oldestCursor.created}/${oldestCursor.id}` : 'initial'} returned=${page.items.length} hasMore=${page.hasMore}`);
        }
      } else {
        // Initial request: exactly one bounded newest page. Cached content has
        // already been rendered above, so this request never blocks navigation.
        const page = await pbService.fetchMessagesPage(channelId, null, requestLimit);
        if (!requestIsCurrent()) return;

        let itemsToSet = [...page.items];
        if (targetMessageId && !itemsToSet.some((m) => m.id === targetMessageId)) {
          try {
            const targetMsg = await pbService.getMessageById(targetMessageId);
            if (targetMsg && targetMsg.channel === channelId) itemsToSet.push(targetMsg);
          } catch (e) {}
        }

        const currentEntry = messagesCache.current[channelId];
        const mergedItems = mergeMessagePage(currentEntry?.items || [], itemsToSet, MAX_ACTIVE_MESSAGES);
        const nextEntry = {
          items: mergedItems,
          page: 1,
          hasMore: page.hasMore,
          remoteHasMore: page.hasMore,
          cachedPagesAvailable: Math.max(1, currentEntry?.cachedPagesAvailable || 0),
          newestCursor: getNewestCursor(mergedItems),
          oldestCursor: getOldestCursor(mergedItems),
        };
        messagesCache.current[channelId] = nextEntry;
        if (activeChannelRef.current?.id === channelId) {
          setMessages((prev) => mergeMessagePage(prev, itemsToSet, MAX_ACTIVE_MESSAGES));
          setHasMoreMessages(page.hasMore);
        }
        offlineCacheService.enqueueMessagePersistence(
          'channel',
          channelId,
          { ...page, items: itemsToSet },
          null,
          1,
        );
        if (page.hasMore) {
          setTimeout(() => prefetchNextOlderPage(channelId, false), 100);
        }

        if ((import.meta as any).env?.DEV) {
          console.log(`[PAGINATION_DEBUG] Initial channel page returned=${page.items.length} hasMore=${page.hasMore}`);
        }
      }
      if (activeChannelRef.current?.id === channelId) {
        setMessagesPage(pageNum);
      }
    } catch (err: any) {
      if (!isClientCancellation(err)) {
        const isTimeout = err?.code === 'TIMEOUT' || err?.status === 408 || /timed? ?out/i.test(err?.message || '');
        if (isTimeout && !retryCount && requestIsCurrent()) {
          try {
            if (append) {
              const currentEntry = messagesCache.current[channelId];
              const currentDataset = currentEntry?.items || messages;
              const oldestCursor = currentEntry?.oldestCursor || getOldestCursor(currentDataset);
              const retryPage = await pbService.fetchMessagesPage(channelId, oldestCursor, requestLimit, { timeoutMs: 20000, deferAttachments: true });
              if (!requestIsCurrent()) return;

              const mergedItems = mergeOlderMessagePage(currentDataset, retryPage.items, MAX_ACTIVE_MESSAGES);
              const remoteHasMore = retryPage.hasMore;
              messagesCache.current[channelId] = {
                items: mergedItems,
                page: pageNum,
                hasMore: remoteHasMore,
                remoteHasMore,
                cachedPagesAvailable: (currentEntry?.cachedPagesAvailable || 0) + 1,
                newestCursor: getNewestCursor(mergedItems),
                oldestCursor: getOldestCursor(mergedItems),
              };
              if (activeChannelRef.current?.id === channelId) {
                setMessages((prev) => mergeOlderMessagePage(prev, retryPage.items, MAX_ACTIVE_MESSAGES));
                setHasMoreMessages(remoteHasMore);
                setMessagesPage(pageNum);
              }
              hydrateOlderMessageAttachments(channelId, retryPage.items, false);
              offlineCacheService.enqueueMessagePersistence('channel', channelId, retryPage, oldestCursor, pageNum);
              return;
            } else {
              const retryPage = await pbService.fetchMessagesPage(channelId, null, requestLimit, { timeoutMs: 20000 });
              if (!requestIsCurrent()) return;

              let itemsToSet = [...retryPage.items];
              if (targetMessageId && !itemsToSet.some((m) => m.id === targetMessageId)) {
                try {
                  const targetMsg = await pbService.getMessageById(targetMessageId);
                  if (targetMsg && targetMsg.channel === channelId) itemsToSet.push(targetMsg);
                } catch (e) {}
              }

              const currentEntry = messagesCache.current[channelId];
              const mergedItems = mergeMessagePage(currentEntry?.items || [], itemsToSet, MAX_ACTIVE_MESSAGES);
              const nextEntry = {
                items: mergedItems,
                page: 1,
                hasMore: retryPage.hasMore,
                remoteHasMore: retryPage.hasMore,
                cachedPagesAvailable: Math.max(1, currentEntry?.cachedPagesAvailable || 0),
                newestCursor: getNewestCursor(mergedItems),
                oldestCursor: getOldestCursor(mergedItems),
              };
              messagesCache.current[channelId] = nextEntry;
              if (activeChannelRef.current?.id === channelId) {
                setMessages((prev) => mergeMessagePage(prev, itemsToSet, MAX_ACTIVE_MESSAGES));
                setHasMoreMessages(retryPage.hasMore);
                setMessagesPage(pageNum);
              }
              offlineCacheService.enqueueMessagePersistence(
                'channel',
                channelId,
                { ...retryPage, items: itemsToSet },
                null,
                1,
              );
              return;
            }
          } catch (retryErr) {
            if (!isClientCancellation(retryErr)) {
              console.warn('Failed to load messages after retry:', retryErr);
            }
            return;
          }
        }
        console.warn('Failed to load messages:', err);
      }
      // Do NOT set setHasMoreMessages(false) on error so user can retry
    } finally {
      if (activeChannelRef.current?.id === channelId) {
        setIsLoadingMore(false);
        setIsInitialLoadingChannel(false);
      }
    }
  };

  const prefetchNextOlderPage = async (conversationId: string, isDm: boolean) => {
    if (!conversationId) return;
    if (prefetchedOlderPagesRef.current[conversationId]) return;
    if (prefetchingConversationsRef.current.has(conversationId)) return;
    const entry = messagesCache.current[conversationId];
    if (entry && entry.remoteHasMore === false) return;
    const kind = isDm ? 'dm' : 'channel';
    const currentDataset = (activeChannelRef.current?.id === conversationId && messages.length > 0)
      ? messages
      : (entry?.items || []);
    const oldestCursor = getOldestCursor(currentDataset) || entry?.oldestCursor;
    if (!oldestCursor) return;

    prefetchingConversationsRef.current.add(conversationId);
    try {
      // 1. Check offline cache first (0 network latency)
      const cachedPage = await offlineCacheService.getNextOlderMessagePage(kind, conversationId, oldestCursor);
      if (cachedPage?.items?.length) {
        prefetchedOlderPagesRef.current[conversationId] = {
          items: cachedPage.items,
          hasMore: cachedPage.hasMore,
          cursor: oldestCursor,
        };
        return;
      }

      // 2. Proactively prefetch from remote in background so next scroll-up is instant
      if (entry?.remoteHasMore !== false) {
        let items: Message[] = [];
        let hasMore = false;
        let fetchedPage: any = null;
        if (isDm) {
          const targetChan = activeChannelRef.current?.id === conversationId ? activeChannelRef.current : allDmChannels.find((c) => c.id === conversationId);
          const targetUsername = targetChan ? targetChan.name.replace(/^@/, '') : '';
          let targetUser = targetChan?.recipientUser || (targetUsername ? allDmChannels.find((c) => c.recipientUser?.username?.toLowerCase() === targetUsername.toLowerCase())?.recipientUser : null);
          if (!targetUser?.id && targetUsername) {
            try {
              const matchingUsers = await pbService.searchUsers(targetUsername);
              targetUser = matchingUsers.find((u) => u.username.toLowerCase() === targetUsername.toLowerCase());
            } catch {}
          }
          if (targetUser?.id) {
            const cachedServer = pbService.getCachedPrivateChatServer(targetUser.id);
            const res = await pbService.fetchDirectMessagesPage(
              targetUser.id,
              cachedServer?.id,
              oldestCursor,
              OLDER_MESSAGE_PAGE_SIZE,
              { deferAttachments: true },
            );
            fetchedPage = res;
            items = res.items;
            hasMore = res.hasMore;
          }
        } else {
          const res = await pbService.fetchMessagesPage(
            conversationId,
            oldestCursor,
            OLDER_MESSAGE_PAGE_SIZE,
            { deferAttachments: true },
          );
          fetchedPage = res;
          items = res.items;
          hasMore = res.hasMore;
        }

        if (items.length > 0 && fetchedPage) {
          prefetchedOlderPagesRef.current[conversationId] = {
            items,
            hasMore,
            cursor: oldestCursor,
          };
          offlineCacheService.enqueueMessagePersistence(
            kind,
            conversationId,
            fetchedPage,
            oldestCursor,
            (entry?.page || 1) + 1,
          );
        }
      }
    } catch {
      // Background prefetch errors are silent
    } finally {
      prefetchingConversationsRef.current.delete(conversationId);
    }
  };

  const handleLoadMoreMessages = async () => {
    if (!activeChannel || isLoadingMore) return;
    const conversationId = activeChannel.id;
    if (olderMessageRequestRef.current.has(conversationId)) return;
    olderMessageRequestRef.current.add(conversationId);

    try {
      const entry = messagesCache.current[conversationId];
      const isDm = activeChannel.server === 'dm' || activeChannel.name.startsWith('@');
      const kind = isDm ? 'dm' : 'channel';

      // FAST-PATH: WhatsApp-style Instant Load from in-memory prefetch buffer (0ms latency)
      const prefetched = prefetchedOlderPagesRef.current[conversationId];
      if (prefetched && prefetched.items?.length > 0) {
        prefetchedOlderPagesRef.current[conversationId] = null;
        const revealedItems = mergeOlderMessagePage(
          messages,
          prefetched.items,
          MAX_ACTIVE_MESSAGES,
        );
        if (didMessageWindowMoveOlder(messages, revealedItems)) {
          setMessages(revealedItems);
          setHasMoreMessages(prefetched.hasMore);
          hydrateOlderMessageAttachments(conversationId, prefetched.items, isDm);
          const nextEntry = {
            ...(entry || {}),
            items: revealedItems,
            page: (entry?.page || messagesPage) + 1,
            hasMore: prefetched.hasMore,
            remoteHasMore: prefetched.hasMore,
            cachedPagesAvailable: Math.max(0, (entry?.cachedPagesAvailable || 1) - 1),
            newestCursor: getNewestCursor(revealedItems),
            oldestCursor: getOldestCursor(revealedItems),
          };
          messagesCache.current[conversationId] = nextEntry as any;
          if (prefetched.hasMore) {
            setTimeout(() => {
              prefetchNextOlderPage(conversationId, isDm);
            }, 10);
          }
          return;
        }
      }

      const visibleOldestCursor = getOldestCursor(messages);
      // Fast-path: Check synchronous in-memory cache first to avoid IndexedDB round-trip lag
      const syncCachedPage = offlineCacheService.getMessagePageSync(kind, conversationId, visibleOldestCursor);
      if (syncCachedPage?.items?.length) {
        const revealedItems = mergeOlderMessagePage(
          messages,
          syncCachedPage.items,
          MAX_ACTIVE_MESSAGES,
        );
        if (didMessageWindowMoveOlder(messages, revealedItems)) {
          const cachedHasMore = syncCachedPage.hasMore;
          setMessages(revealedItems);
          setHasMoreMessages(cachedHasMore);
          hydrateOlderMessageAttachments(conversationId, syncCachedPage.items, isDm);
          const revealedEntry = entry || {
            items: [],
            page: messagesPage,
            hasMore: cachedHasMore,
            remoteHasMore: cachedHasMore,
            cachedPagesAvailable: 0,
            newestCursor: getNewestCursor(revealedItems),
            oldestCursor: getOldestCursor(revealedItems),
          };
          revealedEntry.items = revealedItems;
          revealedEntry.hasMore = cachedHasMore;
          revealedEntry.newestCursor = getNewestCursor(revealedItems);
          revealedEntry.oldestCursor = getOldestCursor(revealedItems);
          messagesCache.current[conversationId] = revealedEntry;
          if (cachedHasMore) {
            setTimeout(() => {
              prefetchNextOlderPage(conversationId, isDm);
            }, 10);
          }
          return;
        }
      }

      // Check async storage cache
      const cachedPage = await offlineCacheService.getNextOlderMessagePage(
        kind,
        conversationId,
        visibleOldestCursor,
      );
      if (activeChannelRef.current?.id !== conversationId) return;

      if (cachedPage?.items?.length) {
        const revealedItems = mergeOlderMessagePage(
          messages,
          cachedPage.items,
          MAX_ACTIVE_MESSAGES,
        );
        if (didMessageWindowMoveOlder(messages, revealedItems)) {
          const cachedHasMore = cachedPage.hasMore;
          setMessages(revealedItems);
          setHasMoreMessages(cachedHasMore);
          hydrateOlderMessageAttachments(conversationId, cachedPage.items, isDm);
          const revealedEntry = entry || {
            items: [],
            page: messagesPage,
            hasMore: cachedHasMore,
            remoteHasMore: cachedHasMore,
            cachedPagesAvailable: 0,
            newestCursor: getNewestCursor(revealedItems),
            oldestCursor: getOldestCursor(revealedItems),
          };
          revealedEntry.items = revealedItems;
          revealedEntry.hasMore = cachedHasMore;
          revealedEntry.newestCursor = getNewestCursor(revealedItems);
          revealedEntry.oldestCursor = getOldestCursor(revealedItems);
          messagesCache.current[conversationId] = revealedEntry;
          if (cachedHasMore) {
            setTimeout(() => {
              prefetchNextOlderPage(conversationId, isDm);
            }, 10);
          }
          return;
        }
      }

      const nextPage = messagesPage + 1;
      await loadMessages(conversationId, nextPage, true, null, OLDER_MESSAGE_PAGE_SIZE);
      setTimeout(() => {
        prefetchNextOlderPage(conversationId, isDm);
      }, 20);
    } finally {
      olderMessageRequestRef.current.delete(conversationId);
    }
  };

  const handleSkipUploadFile = () => {
    if (!activeUpload) return;
    activeUpload.skipRequested = true;
    activeUpload.abortController.abort();
  };

  const handleCancelUploadMessage = async () => {
    if (!activeUpload) return;
    const targetMsgId = activeUpload.messageId;
    const targetTempId = activeUpload.tempId;

    activeUpload.skipRequested = false;
    activeUpload.abortController.abort();
    setActiveUpload(null);

    if (targetMsgId) {
      try {
        await pbService.deleteMessage(targetMsgId);
      } catch (e) {
        console.warn('Failed to delete cancelled message from PocketBase:', e);
      }
    }

    setMessages((prev) =>
      prev.filter((m) => m.id !== targetMsgId && m.id !== targetTempId)
    );
  };

  const handleSendMessage = async (content: string, replyToId?: string, attachments?: File[], uploadedAttachments?: Attachment[]) => {
    if (!activeChannel) return;

    const finalContent = content.trim() === '' ? '  ' : content;

    // Check if sending a Direct Message
    const isDmChannel = activeChannel.name.startsWith('@') || activeServer?.name === 'Direct Messages' || activeServer?.name === 'الرسائل الخاصة';
    const targetUsername = isDmChannel ? activeChannel.name.replace(/^@/, '') : '';

    const hasAttachment = !!((attachments && attachments.length > 0) || (uploadedAttachments && uploadedAttachments.length > 0));

    // Construct optimistic attachment records for atomic rendering
    let optimisticAttachmentsList: any[] = [];
    if (uploadedAttachments && uploadedAttachments.length > 0) {
      optimisticAttachmentsList = uploadedAttachments;
    } else if (attachments && attachments.length > 0) {
      optimisticAttachmentsList = attachments.map((file, idx) => ({
        id: `temp-att-${Date.now()}-${idx}`,
        file: file.name,
        type: file.type,
        size: file.size,
        created: new Date().toISOString(),
        collectionName: isDmChannel ? 'private_attachments' : 'attachments',
        url: (file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/'))
          ? URL.createObjectURL(file)
          : ''
      }));
    }

    // 1. Create a local optimistic echo message for instant responsiveness
    const tempId = `optimistic-${Date.now()}`;
    const optimisticMessage: Message & { attachmentsCount?: number; temp_id?: string } = {
      id: tempId,
      temp_id: tempId,
      content: finalContent,
      sender: currentUser!.id,
      channel: activeChannel.id,
      reply_to: replyToId,
      created: new Date().toISOString(),
      is_pending: false,
      has_attachment: hasAttachment,
      attachmentsCount: optimisticAttachmentsList.length,
      expand: {
        sender: currentUser!,
        'attachments(message)': optimisticAttachmentsList,
        'private_attachments(message)': optimisticAttachmentsList
      }
    };

    setMessages((prev) => {
      const updated = [...prev, optimisticMessage];
      if (messagesCache.current[activeChannel.id]) {
        messagesCache.current[activeChannel.id].items = updated;
      }
      return updated;
    });

    if (isDmChannel) {
      setAllDmChannels((prevDms) => {
        const targetIndex = prevDms.findIndex(
          (c) => c.id === activeChannel.id || c.name === activeChannel.name || (activeChannel.recipientUser && c.recipientUser?.id === activeChannel.recipientUser.id)
        );
        if (targetIndex !== -1) {
          const updatedChan = {
            ...prevDms[targetIndex],
            created: optimisticMessage.created
          };
          const remaining = prevDms.filter((_, idx) => idx !== targetIndex);
          return [updatedChan, ...remaining];
        }
        return prevDms;
      });
    }

    // Perform sending workflow in background asynchronously - non-blocking for client!
    (async () => {
      try {
        let msg: Message;
        if (isDmChannel) {
          let targetUser = activeChannel.recipientUser || (targetUsername ? allDmChannels.find(c => c.recipientUser?.username?.toLowerCase() === targetUsername.toLowerCase())?.recipientUser : null);
          if (!targetUser && targetUsername) {
            const matchingUsers = await pbService.searchUsers(targetUsername);
            targetUser = matchingUsers.find(u => u.username.toLowerCase() === targetUsername.toLowerCase()) || null;
          }
          if (targetUser) {
            const chatServerId = activeChannel.id.startsWith('dm-server-') ? activeChannel.id.replace(/^dm-server-/, '') : undefined;
            msg = await pbService.sendDirectMessage(targetUser.id, finalContent, replyToId, chatServerId, hasAttachment);
          } else {
            msg = await pbService.sendMessage(activeChannel.id, finalContent, replyToId, hasAttachment);
          }
        } else {
          msg = await pbService.sendMessage(activeChannel.id, finalContent, replyToId, hasAttachment);
        }

        const realMsgId = msg.id;

        // Immediately update optimistic echo with real message id in local state preserving stable temp_id & attachments
        setMessages((prev) => {
          const optMsg = prev.find((m) => m.id === tempId || (m as any).temp_id === tempId);
          const currentAtts =
            optMsg?.expand?.['attachments(message)'] ||
            optMsg?.expand?.['private_attachments(message)'] ||
            optimisticAttachmentsList;

          const alreadyHasReal = prev.some((m) => m.id === realMsgId);
          if (alreadyHasReal) {
            return prev
              .filter((m) => m.id !== tempId && (m as any).temp_id !== tempId)
              .map((m) => {
                if (m.id === realMsgId) {
                  const existingAtts = m.expand?.['attachments(message)'] || m.expand?.['private_attachments(message)'];
                  const effectiveAtts = (existingAtts && existingAtts.length > 0) ? existingAtts : currentAtts;
                  return {
                    ...m,
                    ...msg,
                    id: realMsgId,
                    temp_id: tempId,
                    expand: {
                      ...(m.expand || {}),
                      ...(msg.expand || {}),
                      ...(effectiveAtts && effectiveAtts.length > 0 ? {
                        'attachments(message)': effectiveAtts,
                        'private_attachments(message)': effectiveAtts,
                        attachments_via_message: effectiveAtts,
                        private_attachments_via_message: effectiveAtts,
                      } : {})
                    }
                  };
                }
                return m;
              });
          }
          return prev.map((m) => {
            if (m.id === tempId || (m as any).temp_id === tempId) {
              return {
                ...m,
                ...msg,
                id: realMsgId,
                temp_id: tempId,
                expand: {
                  ...(m.expand || {}),
                  ...(msg.expand || {}),
                  ...(currentAtts && currentAtts.length > 0 ? {
                    'attachments(message)': currentAtts,
                    'private_attachments(message)': currentAtts,
                    attachments_via_message: currentAtts,
                    private_attachments_via_message: currentAtts,
                  } : {})
                }
              };
            }
            return m;
          });
        });

        // Handle pre-uploaded attachments from background upload manager
        if (uploadedAttachments && uploadedAttachments.length > 0) {
          await Promise.all(
            uploadedAttachments.map((att) => pbService.linkAttachmentToMessage(att.id, realMsgId, isDmChannel))
          );
          await pbService.touchMessage(realMsgId);
          msg.expand = {
            ...msg.expand,
            'attachments(message)': uploadedAttachments,
            'private_attachments(message)': uploadedAttachments
          };
          setMessages((prev) =>
            prev.map((m) =>
              m.id === realMsgId || (m as any).temp_id === tempId
                ? {
                    ...m,
                    expand: {
                      ...m.expand,
                      'attachments(message)': uploadedAttachments,
                      'private_attachments(message)': uploadedAttachments
                    }
                  }
                : m
            )
          );
        }
        // Handle fallback attachment file uploads if queued (legacy path)
        else if (attachments && attachments.length > 0) {
          const abortController = new AbortController();
          const uploadState: ActiveUploadState = {
            messageId: realMsgId,
            tempId,
            files: attachments,
            currentFileIndex: 0,
            currentFileName: attachments[0].name,
            fileProgress: 0,
            totalProgress: 0,
            abortController,
            skipRequested: false
          };

          setActiveUpload(uploadState);

          const uploadedAttachmentsList = [];
          let isCancelled = false;

          for (let i = 0; i < attachments.length; i++) {
            if (abortController.signal.aborted && !uploadState.skipRequested) {
              isCancelled = true;
              break;
            }

            const file = attachments[i];
            
            setActiveUpload({
              messageId: realMsgId,
              tempId,
              files: attachments,
              currentFileIndex: i,
              currentFileName: file.name,
              fileProgress: 0,
              totalProgress: Math.round((i / attachments.length) * 100),
              abortController,
              skipRequested: false
            });

            try {
              // Upload as unlinked first so other users only see attachments once all are ready
              const attach = await pbService.uploadAttachmentWithProgress(
                '',
                file,
                (pct) => {
                  const total = Math.round(((i + pct / 100) / attachments.length) * 100);
                  setActiveUpload({
                    messageId: realMsgId,
                    tempId,
                    files: attachments,
                    currentFileIndex: i,
                    currentFileName: file.name,
                    fileProgress: pct,
                    totalProgress: total,
                    abortController,
                    skipRequested: uploadState.skipRequested
                  });
                },
                abortController.signal,
                isDmChannel
              );
              uploadedAttachmentsList.push(attach);
            } catch (uploadErr: any) {
              if (uploadState.skipRequested) {
                console.log('User skipped file:', file.name);
                uploadState.skipRequested = false;
                continue;
              } else if (abortController.signal.aborted) {
                isCancelled = true;
                break;
              } else {
                console.warn('Upload error for file:', file.name, uploadErr);
              }
            }
          }

          setActiveUpload(null);

          if (isCancelled && !uploadState.skipRequested) {
            try {
              await pbService.deleteMessage(realMsgId);
            } catch (e) {
              // ignore
            }
            setMessages((prev) => prev.filter((m) => m.id !== realMsgId && m.id !== tempId));
            return;
          }

          if (uploadedAttachmentsList.length > 0) {
            // Link all uploaded attachments atomically to the message
            await Promise.all(
              uploadedAttachmentsList.map((att) => pbService.linkAttachmentToMessage(att.id, realMsgId, isDmChannel))
            );
            msg.expand = {
              ...msg.expand,
              'attachments(message)': uploadedAttachmentsList,
              'private_attachments(message)': uploadedAttachmentsList
            };
            try {
              await pbService.touchMessage(msg.id);
            } catch (e) {
              // ignore
            }
          }
        }

        // Swap optimistic echo out for real database record
        let finalMsg = msg;
        try {
          finalMsg = await pbService.getMessageById(msg.id, { forceRefresh: true });
        } catch (e) {
          finalMsg = msg;
        }

        setMessages((prev) => {
          // The PocketBase realtime echo and the send response can arrive in
          // either order. Replace both optimistic/real copies, then run the
          // canonical merge so React never renders two rows for one record.
          const updated = dedupeMessages(
            prev.map((m) => (m.id === tempId || (m as any).temp_id === tempId || m.id === realMsgId ? finalMsg : m)),
          );
          if (messagesCache.current[activeChannel.id]) {
            messagesCache.current[activeChannel.id].items = updated;
          }
          return updated;
        });

        offlineCacheService.mergeChannelMessages(activeChannel.id, [finalMsg]);

        if (isDmChannel) {
          setAllDmChannels((prevDms) => {
            const targetIndex = prevDms.findIndex((c) => c.id === activeChannel.id || c.name === activeChannel.name);
            if (targetIndex !== -1) {
              const updatedChan = { ...prevDms[targetIndex], created: finalMsg.created || new Date().toISOString() };
              const remaining = prevDms.filter((_, idx) => idx !== targetIndex);
              return [updatedChan, ...remaining];
            }
            return prevDms;
          });
        }

        // Dispatch notifications to target users in PocketBase so offline users receive them in their notifications tab.
        // Keep this path bounded: the previous implementation downloaded the
        // entire users collection for every sent message.  Resolve mentions
        // from the cached directory/server-member list first, and query only
        // the exact names that are not already cached.
        try {
          const contentLower = (finalMsg.content || '').toLowerCase();
          const targetUserIds = new Set<string>();

          // Helper for exact mention matching without partial substring match (e.g. @simlfe matching @simlfe90)
          const isMentionMatch = (text: string, name: string) => {
            if (!name) return false;
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`@${escaped}(?![a-zA-Z0-9_-])`, 'i');
            return regex.test(text);
          };

          const mentionTokens = Array.from(new Set(
            Array.from(contentLower.matchAll(/@([a-zA-Z0-9_\u0600-\u06FF-]+)/g)).map((match) => match[1]).filter(Boolean),
          ));
          const cachedUsersById = new Map<string, User>();
          pbService.getCachedUsers().forEach((user) => cachedUsersById.set(user.id, user));

          // The member cache contains only the active server's users when it
          // is available, which avoids notifying unrelated directory users.
          const memberRecords = activeServer?.id ? pbService.getCachedServerMembers(activeServer.id) : [];
          memberRecords.forEach((member) => {
            const expandedUser = member.expand?.user;
            const cachedUser = expandedUser || pbService.getCachedUser(member.user);
            if (cachedUser) cachedUsersById.set(cachedUser.id, cachedUser);
          });

          // 1. Mentions (@username or @display_name)
          const unresolvedMentionTokens = new Set<string>();
          for (const token of mentionTokens) {
            const matching = Array.from(cachedUsersById.values()).filter((user) =>
              user.id !== currentUser!.id &&
              (String(user.username || '').toLowerCase() === token ||
                String(user.display_name || '').toLowerCase() === token),
            );
            if (matching.length > 0) {
              matching.forEach((user) => {
                if (!activeServer?.id) {
                  targetUserIds.add(user.id);
                  return;
                }
                const memRecord = pbService.getCachedServerMember(activeServer.id, user.id);
                const inactive = !pbService.isUserInServer(activeServer.id, user) ||
                  memRecord?.is_member === false || ['left', 'banned', 'kicked'].includes(memRecord?.membership_status || '');
                if (!inactive) targetUserIds.add(user.id);
              });
            } else {
              unresolvedMentionTokens.add(token);
            }
          }

          // Search only unresolved mention tokens; this is normally zero after
          // the visible member list has populated and is capped by the number
          // of distinct @tokens in the message.
          if (unresolvedMentionTokens.size > 0) {
            const resolved = await Promise.all(Array.from(unresolvedMentionTokens).map(async (token) => {
              try {
                return await pbService.searchUsers(token);
              } catch {
                return [] as User[];
              }
            }));
            resolved.flat().forEach((user) => {
              if (user.id !== currentUser!.id &&
                (isMentionMatch(contentLower, (user.username || '').toLowerCase()) ||
                  isMentionMatch(contentLower, (user.display_name || '').toLowerCase()))) {
                targetUserIds.add(user.id);
              }
            });
          }

          // 2. Replies
          if (replyToId) {
            const repliedMsg = messages.find((m) => m.id === replyToId);
            if (repliedMsg && repliedMsg.sender !== currentUser!.id) {
              targetUserIds.add(repliedMsg.sender);
            }
          }

          // 3. Direct Message
          if (isDmChannel && targetUsername) {
            const targetUser = Array.from(cachedUsersById.values()).find((u) => u.username?.toLowerCase() === targetUsername.toLowerCase()) ||
              (await pbService.searchUsers(targetUsername)).find((u) => u.username?.toLowerCase() === targetUsername.toLowerCase());
            if (targetUser && targetUser.id !== currentUser!.id) {
              targetUserIds.add(targetUser.id);
            }
          }

          for (const targetId of Array.from(targetUserIds)) {
            const isDM = isDmChannel || activeChannel.id === 'dm';
            const isReply = replyToId && messages.some((m) => m.id === replyToId && m.sender === targetId);

            const notifItem: NotificationItem = {
              id: 'notif-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
              type: isDM ? 'dm' : isReply ? 'reply' : 'mention',
              sender_id: currentUser!.id,
              sender_name: currentUser!.display_name || currentUser!.username,
              sender_avatar: currentUser!.avatar ? `${pbService.getServerUrl()}/api/files/users/${currentUser!.id}/${currentUser!.avatar}` : undefined,
              channel_id: activeChannel.id,
              channel_name: activeChannel.name,
              server_id: activeServer?.id,
              message_id: finalMsg.id,
              message_content: finalMsg.content || '',
              created: finalMsg.created || new Date().toISOString(),
              read: false
            };

            await pbService.addNotificationToUser(targetId, notifItem);
          }
        } catch (notifErr) {
          console.warn('Failed to dispatch notifications to users:', notifErr);
        }
      } catch (err) {
        console.error('Failed to sync sent message with PocketBase, falling back:', err);
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setActiveUpload(null);
        if (uploadedAttachments && uploadedAttachments.length > 0) {
          for (const att of uploadedAttachments) {
            pbService.deleteAttachmentRecord(att.id, isDmChannel);
          }
        }
      }
    })();
  };

  // DELETIONS

  const handleEditMessage = async (messageId: string, newContent: string) => {
    try {
      const now = new Date().toISOString();
      await pbService.editMessage(messageId, newContent);
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, content: newContent, edited: true, updated: now, edited_at: now } : m));
    } catch (err) {
      console.error('Failed to edit message:', err);
    }
  };

  const handleToggleReaction = async (messageId: string, emoji: string) => {
    if (!currentUser) return;
    const currentActiveChan = activeChannelRef.current || activeChannel;
    const isDm = Boolean(
      currentActiveChan &&
        (currentActiveChan.server === 'dm' ||
          (currentActiveChan as any).server_id === 'dm' ||
          currentActiveChan.id.startsWith('dm-') ||
          currentActiveChan.id.startsWith('private-') ||
          currentActiveChan.name.startsWith('@') ||
          activeServer?.name === 'Direct Messages' ||
          activeServer?.name === 'الرسائل الخاصة' ||
          activeServer?.id === 'dm')
    );

    const updateMsgReactions = (m: Message): Message => {
      if (m.id !== messageId) return m;
      const raw = (m as any).reactions ?? (m as any).expand?.reactions ?? (m as any).reactions_list ?? (m as any).message_reactions;
      const updatedList = toggleReactionInList(raw, emoji, currentUser.id);

      return {
        ...m,
        reactions: updatedList,
      };
    };

    setMessages((prev) => {
      const updated = prev.map(updateMsgReactions);
      if (currentActiveChan?.id && messagesCache.current[currentActiveChan.id]) {
        messagesCache.current[currentActiveChan.id].items = updated;
      }
      return updated;
    });

    if (activeServer) {
      setServerMessages((prev) => {
        const updated = prev.map(updateMsgReactions);
        if (activeServer?.id && serverMessagesCache.current[activeServer.id]) {
          serverMessagesCache.current[activeServer.id] = updated;
        }
        return updated;
      });
    }

    try {
      await pbService.toggleMessageReaction(messageId, emoji, Boolean(isDm));
    } catch (err) {
      console.warn('Failed to toggle reaction:', err);
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    try {
      await MessageDeletionService.deleteMessage(messageId, {
        channelId: activeChannel?.id,
        activeChannel,
        lang,
        onChannelUpdated: (updatedChan) => {
          setActiveChannel(updatedChan);
          setChannels((prev) =>
            prev.map((c) => (c.id === updatedChan.id ? updatedChan : c))
          );
        },
        onMessageDeletedStateUpdate: (deletedId) => {
          setMessages((prev) => MessageDeletionService.transformMessagesOnDeletion(prev, deletedId, lang));
          if (activeServer) {
            setServerMessages((prev) => MessageDeletionService.transformMessagesOnDeletion(prev, deletedId, lang));
          }
        }
      });
    } catch (err) {
      console.error('Failed to delete message:', err);
    }
  };

  const handleDeleteChannel = async (channelId: string) => {
    try {
      await pbService.deleteChannel(channelId);
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
      if (activeChannel?.id === channelId) {
        setActiveChannel(null);
      }
    } catch (err) {
      console.error('Failed to delete channel:', err);
    }
  };

  const handleDeleteServer = async (serverId: string) => {
    try {
      const targetServer = servers.find((s) => s.id === serverId);
      const serverName = targetServer?.name || 'Server';

      // Notify all users in the server that this server was deleted by an admin and won't be accessible anymore
      await pbService.notifyServerUsersDeleted(serverId, serverName, currentUser?.id, lang);

      await pbService.deleteServer(serverId);
      setServers((prev) => prev.filter((s) => s.id !== serverId));
      if (activeServer?.id === serverId) {
        const remaining = servers.filter((s) => s.id !== serverId);
        setActiveServer(remaining.length > 0 ? remaining[0] : null);
        setActiveChannel(null);
      }
    } catch (err) {
      console.error('Failed to delete server:', err);
    }
  };

  const handleLeaveServer = (serverToLeave: Server) => {
    if (!currentUser) return;
    setLeavingServer(serverToLeave);
  };

  const handleLeaveServerSuccess = async (leftServer: Server, newOwnerId?: string) => {
    setServerSettingsModalServer(null);
    setLeavingServer(null);

    if (activeVoiceChannel && activeVoiceChannel.server === leftServer.id) {
      await leaveRoomOrCall();
    }

    const nextServers = servers.filter((s) => s.id !== leftServer.id);
    setServers(nextServers);

    if (activeServer?.id === leftServer.id) {
      if (nextServers.length > 0) {
        const nextSrv = nextServers[0];
        setActiveServer(nextSrv);
        await loadChannels(nextSrv.id);
      } else {
        setActiveServer(null);
        setChannels([]);
        setActiveChannel(null);
        setShowDiscoveryCenter(true);
      }
    }
  };

  const handleKickMember = async (targetUserId: string) => {
    if (!activeServer) return;
    try {
      await pbService.kickMember(activeServer.id, targetUserId);
      setServers((prev) =>
        prev.map((s) =>
          s.id === activeServer.id
            ? { ...s, members: (s.members || []).filter((m) => m !== targetUserId) }
            : s
        )
      );
      setSelectedUserProfile(null);
    } catch (err) {
      console.error('Failed to kick member:', err);
    }
  };

  const handleSelectChannel = (channel: Channel, overrideTargetMessageId?: string) => {
    setShowDiscoveryCenter(false);

    if (channel.server && channel.server !== activeServer?.id) {
      const parentServer = servers.find((s) => s.id === channel.server);
      if (parentServer) {
        setActiveServer(parentServer);
      }
    }

    if (channel.type === 'voice') {
      if (activeChannel && activeChannel.type !== 'voice') {
        previousTextChannelRef.current = activeChannel;
      }
      setActiveVoiceChannel(channel);
      setActiveChannel(channel);
      lastVoiceChannelRef.current = channel;
      if (currentUser && activeRoom?.roomId !== channel.id) {
        joinVoiceRoom(channel, currentUser, 'voice').catch((e) => {
          console.error('Failed to auto-join voice channel:', e);
        });
      }
      return;
    } else {
      previousTextChannelRef.current = channel;
      // Capture unread count before clearing
      const unreadInfo = unreadCounts[channel.id];
      const countOnOpen = unreadInfo?.count || 0;
      setActiveUnreadCountOnOpen(countOnOpen > 0 ? { channelId: channel.id, count: countOnOpen } : null);

      // Clear unread count for this channel
      setUnreadCounts((prev) => {
        if (!prev[channel.id]) return prev;
        const copy = { ...prev };
        delete copy[channel.id];
        return copy;
      });

      // 1. Immediately populate messages from synchronous L1 / memory cache (0ms)
      const cached = messagesCache.current[channel.id] || offlineCacheService.getCachedMessagesSync(channel.id);
      if (cached && cached.items && cached.items.length > 0) {
        messagesCache.current[channel.id] = cached;
        const initialPage = cached.items.slice(Math.max(0, cached.items.length - INITIAL_MESSAGE_PAGE_SIZE));
        setMessages(initialPage);
        setHasMoreMessages(cached.remoteHasMore ?? true);
        setMessagesPage(cached.page || 1);
        setIsInitialLoadingChannel(true);
      } else {
        setMessages([]);
        setHasMoreMessages(true);
        setIsInitialLoadingChannel(true);
      }

      const targetMsgToFocus = overrideTargetMessageId || (unreadInfo?.hasMention ? unreadInfo?.lastMentionMsgId : null) || null;
      setTargetMessageId(targetMsgToFocus);

      // Mark notifications for this channel as read
      if (currentUser?.id) {
        const matchingNotification = (n: NotificationItem) =>
          n.channel_id === channel.id ||
          (channel.server === 'dm' && n.type === 'dm' &&
            (n.private_chat_id === channel.id.replace('dm-server-', '') || n.channel_name === channel.name));
        const hasUnread = notificationsList.some((n) => matchingNotification(n) && !n.read);
        if (hasUnread) {
          const updated = notificationsList.map((n) => matchingNotification(n) ? { ...n, read: true } : n);
          setNotificationsList(updated);
          // Persist only when the selection actually changed unread state; never
          // issue a write from inside a React state updater.
          void pbService.updateUserNotifications(currentUser.id, updated);
        }
      }

      if (channel.server === 'dm' || channel.name.startsWith('@')) {
        setActiveDmChannel(channel);
      } else {
        setActiveServerChannel(channel);
      }

      setActiveChannel(channel);
    }
  };

  const handleNavigateToMessageLink = (serverId: string, channelId: string, messageId: string) => {
    if (serverId && serverId !== 'dm' && serverId !== activeServer?.id) {
      const parentServer = servers.find((s) => s.id === serverId);
      if (parentServer) {
        setActiveServer(parentServer);
      }
    }
    const targetChan = channels.find((c) => c.id === channelId) || allDmChannels.find((c) => c.id === channelId);
    if (targetChan) {
      handleSelectChannel(targetChan, messageId);
    }
  };

  const handleCloseDm = useCallback(
    (dmChannelToClose: Channel) => {
      if (!currentUser?.id || !dmChannelToClose) return;
      const userId = currentUser.id;
      const recipientId = dmChannelToClose.recipientUser?.id;

      setClosedDmIds((prev) => {
        const next = new Set(prev);
        next.add(dmChannelToClose.id);
        if (recipientId) {
          next.add(recipientId);
          next.add(`dm-user-${recipientId}`);
        }
        try {
          localStorage.setItem(
            `closed_dms_${userId}`,
            JSON.stringify(Array.from(next))
          );
        } catch (e) {}
        return next;
      });

      setAllDmChannels((prev) =>
        prev.filter(
          (c) =>
            c.id !== dmChannelToClose.id &&
            (!recipientId || c.recipientUser?.id !== recipientId)
        )
      );

      const currentCached = inMemoryDmCacheRef.current.get(userId) || [];
      const filteredCached = currentCached.filter(
        (c) =>
          c.id !== dmChannelToClose.id &&
          (!recipientId || c.recipientUser?.id !== recipientId)
      );
      inMemoryDmCacheRef.current.set(userId, filteredCached);
      offlineCacheService.saveDmChannels(userId, filteredCached);

      if (
        activeChannel?.id === dmChannelToClose.id ||
        (recipientId && activeChannel?.recipientUser?.id === recipientId)
      ) {
        setActiveChannel(null);
        setActiveDmChannel(null);
        setMessages([]);
      }
    },
    [currentUser?.id, activeChannel]
  );

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarOpen((prev) => !prev);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setIsSidebarOpen(false);
  }, []);

  const handleToggleMuteCallback = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  const handleToggleDeafenCallback = useCallback(() => {
    setIsDeafened((prev) => !prev);
  }, []);

  const handleSelectServerFromSidebar = useCallback((server: Server) => {
    if (activeServerRef.current?.id === server.id) {
      setIsSidebarOpen(false);
      return;
    }
    setActiveServer(server);
    setShowDiscoveryCenter(false);
    setIsSidebarOpen(false);
  }, []);

  const handleSelectChannelFromSidebar = useCallback((chan: Channel) => {
    handleSelectChannel(chan);
    setIsSidebarOpen(false);
  }, []);

  const handleOpenSettingsFromSidebar = useCallback(() => {
    setShowSettings(true);
    setIsSidebarOpen(false);
  }, []);

  const handleOpenCreateServerFromSidebar = useCallback(() => {
    setShowCreateServer(true);
    setIsSidebarOpen(false);
  }, []);

  const handleSelectFriendsFromSidebar = useCallback(() => {
    setDiscoveryTab('friends');
    setShowDiscoveryCenter(true);
    setActiveChannel(null);
    setActiveVoiceChannel(null);
    setIsSidebarOpen(false);
  }, []);

  const handleSelectDiscoveryFromSidebar = useCallback(() => {
    setDiscoveryTab('servers');
    setShowDiscoveryCenter(true);
    setActiveChannel(null);
    setActiveVoiceChannel(null);
    setIsSidebarOpen(false);
  }, []);

  const handleOpenNewDmModalFromSidebar = useCallback(() => {
    setShowNewDmModal(true);
  }, []);

  const handleOpenServerSettingsFromSidebar = useCallback((srv: Server) => {
    setServerSettingsModalServer(srv);
  }, []);

  const handleUpdateUserFromSidebar = useCallback((updated: User) => {
    setCurrentUser(updated);
  }, []);

  const handlePlayGlobalTrack = useCallback((track: any) => {
    setActiveGlobalTrack(track);
  }, []);

  const handleClearTargetMessage = useCallback(() => {
    setTargetMessageId(null);
  }, []);

  const handleUpdateChannelInChat = useCallback((updated: Channel) => {
    setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setActiveChannel(updated);
    if (updated.server === 'dm' || updated.name.startsWith('@')) {
      setActiveDmChannel(updated);
    } else {
      setActiveServerChannel(updated);
    }
  }, []);

  const handleUpdateServerInChat = useCallback((updated: Server) => {
    setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setActiveServer(updated);
  }, []);

  const handleExpandVoice = useCallback(() => {
    let targetVoice = activeVoiceChannel || lastVoiceChannelRef.current;
    if (!targetVoice && activeRoom?.channelId) {
      targetVoice = channels.find((c) => c.id === activeRoom.channelId) || null;
    }
    if (targetVoice) {
      if (targetVoice.server && targetVoice.server !== 'dm') {
        const parentServer = servers.find((s) => s.id === targetVoice.server);
        if (parentServer) setActiveServer(parentServer);
      }
      setActiveChannel(targetVoice);
    }
  }, [activeVoiceChannel, activeRoom?.channelId, channels, servers]);

  const handleStartDm = async (targetUser: User) => {
    try {
      const targetChanName = `@${targetUser.username}`;
      const existingDm = allDmChannels.find(
        (c) => c.recipientUser?.id === targetUser.id || c.name.toLowerCase() === targetChanName.toLowerCase()
      );

      // Un-close this DM if it was previously closed
      setClosedDmIds((prev) => {
        const targetServerDmId = existingDm?.id;
        if (
          prev.has(targetUser.id) ||
          prev.has(`dm-user-${targetUser.id}`) ||
          (targetServerDmId && prev.has(targetServerDmId))
        ) {
          const next = new Set(prev);
          next.delete(targetUser.id);
          next.delete(`dm-user-${targetUser.id}`);
          if (targetServerDmId) next.delete(targetServerDmId);
          if (currentUser?.id) {
            try {
              localStorage.setItem(
                `closed_dms_${currentUser.id}`,
                JSON.stringify(Array.from(next))
              );
            } catch (e) {}
          }
          return next;
        }
        return prev;
      });

      // Never fabricate a `dm-user-*` conversation id. Existing conversations
      // can open from cache immediately; a new conversation is resolved once
      // and only the server-issued `dm-server-*` id is put in any cache.
      setShowDiscoveryCenter(false);
      if (existingDm) {
        setActiveChannel(existingDm);
        setActiveDmChannel(existingDm);
        const cached = messagesCache.current[existingDm.id];
        setMessages(cached?.items || []);
        setHasMoreMessages(cached?.remoteHasMore ?? true);
        setMessagesPage(cached?.page || 1);
        setUnreadCounts((prev) => {
          if (!prev[existingDm.id]) return prev;
          const copy = { ...prev };
          delete copy[existingDm.id];
          return copy;
        });
      }

      try {
        const privateChatServer = await pbService.getOrCreatePrivateChatServer(targetUser.id);
        const realDmChannelId = `dm-server-${privateChatServer.id}`;
        const resolvedDmChannel: Channel = {
          ...(existingDm || {}),
          id: realDmChannelId,
          name: targetChanName,
          type: 'text',
          server: 'dm',
          description: `Direct Messages with ${targetUser.display_name || targetUser.username}`,
          recipientUser: targetUser,
          created: privateChatServer.created || existingDm?.created || new Date().toISOString(),
        };

        setActiveChannel(resolvedDmChannel);
        setActiveDmChannel(resolvedDmChannel);
        setUnreadCounts((prev) => {
          if (!prev[realDmChannelId]) return prev;
          const copy = { ...prev };
          delete copy[realDmChannelId];
          return copy;
        });

        // Changing the active id lets the shared conversation effect perform
        // exactly one cache-first page request.
        void loadAllDmChannels();
      } catch (err) {
        // Keep the previous conversation intact. The failed operation can be
        // retried without leaving a fabricated id in memory or IndexedDB.
        console.warn('DM resolution failed; retryable:', err);
      }
    } catch (err) {
      console.error('Failed to start DM:', err);
    }
  };

  const handleStartCallDm = async (targetUser: User, mode: 'voice' | 'video' | 'screen' = 'voice') => {
    try {
      const targetChanName = `@${targetUser.username}`;
      const existingDm = allDmChannels.find(
        (c) => c.recipientUser?.id === targetUser.id || c.name.toLowerCase() === targetChanName.toLowerCase()
      );
      const dmChannel: Channel = existingDm || {
        id: `dm-user-${targetUser.id}`,
        name: targetChanName,
        type: 'text',
        server: 'dm',
        recipientUser: targetUser,
        description: `Direct Messages with ${targetUser.display_name || targetUser.username}`
      };

      if (currentUser) {
        startDmCall(targetUser, currentUser, dmChannel, mode);
      }
      setActiveCallMode(mode);

      // Perform background DM channel creation/selection asynchronously without delaying the call UI
      handleStartDm(targetUser).catch(() => {});
    } catch (e) {
      console.error('Failed to start call with user:', e);
    }
  };

  const handleStartCall = async (mode: 'voice' | 'video' | 'screen' = 'voice') => {
    // 1. Direct DM Channel with attached recipient user
    if (activeDmChannel && activeDmChannel.recipientUser) {
      handleStartCallDm(activeDmChannel.recipientUser, mode);
      return;
    }

    // 2. Active channel is DM or starts with @
    if (activeChannel?.server === 'dm' || activeChannel?.name.startsWith('@') || activeChannel?.id.startsWith('dm-')) {
      if (activeChannel.recipientUser) {
        handleStartCallDm(activeChannel.recipientUser, mode);
        return;
      }
      const match = allDmChannels.find(
        (c) => (c.name.toLowerCase() === activeChannel.name.toLowerCase() || c.id === activeChannel.id) && c.recipientUser
      )?.recipientUser;
      if (match) {
        handleStartCallDm(match, mode);
        return;
      }

      // Try resolving user by username from channel name
      const rawUsername = activeChannel.name.replace(/^@/, '').trim();
      if (rawUsername) {
        try {
          const results = await pbService.searchUsers(rawUsername);
          const userObj = results.find(
            (u) => u.username.toLowerCase() === rawUsername.toLowerCase() || u.display_name?.toLowerCase() === rawUsername.toLowerCase()
          ) || results[0];
          if (userObj) {
            handleStartCallDm(userObj, mode);
            return;
          }
        } catch {}
      }
    }

    // 3. Active server is a private 1-on-1 DM server
    if (activeServer && (activeServer.type === 'dm' || (activeServer as any).is_private || activeServer.id.startsWith('dm-'))) {
      try {
        const members = await pbService.fetchServerMembers(activeServer.id);
        const otherMember = members.find((m) => m.id !== currentUser?.id && (m as any).user !== currentUser?.id);
        if (otherMember) {
          const userObj = (otherMember as any).expand?.user || (otherMember as any).userRef || otherMember;
          if (userObj) {
            handleStartCallDm(userObj as User, mode);
            return;
          }
        }
      } catch {}
    }

    if (!activeServer) return;
    try {
      // Find the voice channel of the current server
      const list = await pbService.fetchChannels(activeServer.id);
      const voiceChan = list.find((c) => c.type === 'voice');
      if (voiceChan) {
        if (activeVoiceChannel && activeVoiceChannel.id === voiceChan.id) {
          return;
        }

        if (activeVoiceChannel && activeVoiceChannel.id !== voiceChan.id) {
          setPendingVoiceSwitchChannel(voiceChan);
          return;
        }
        if (activeChannel && activeChannel.type === 'text') {
          previousTextChannelRef.current = activeChannel;
        }
        setActiveCallMode(mode);
        setActiveVoiceChannel(voiceChan);
        lastVoiceChannelRef.current = voiceChan;
        if (currentUser) {
          joinVoiceRoom(voiceChan, currentUser, mode).catch((err) => {
            console.error('Failed to join voice channel from call button:', err);
          });
        }
      }
    } catch (e) {
      console.error('Failed to start call:', e);
    }
  };

  const handleLeaveVoice = useCallback(() => {
    setActiveVoiceChannel(null);
    lastVoiceChannelRef.current = null;
    leaveRoomOrCall();

    let targetTextChan = previousTextChannelRef.current;
    if (!targetTextChan || targetTextChan.type === 'voice') {
      if (activeServer) {
        const serverChans = channels.filter((c) => c.server === activeServer.id);
        targetTextChan = serverChans.find((c) => c.type === 'text' || c.type === 'announcement') || null;
      }
      if (!targetTextChan && channels.length > 0) {
        targetTextChan = channels.find((c) => c.type === 'text' || c.type === 'announcement') || null;
      }
    }

    if (targetTextChan) {
      setActiveChannel(targetTextChan);
      previousTextChannelRef.current = targetTextChan;
    }
  }, [activeServer, channels, leaveRoomOrCall]);

  // Auto-restore text channel when activeRoom disconnects while viewing a voice channel
  useEffect(() => {
    if (!activeRoom && activeChannel && activeChannel.type === 'voice') {
      // Do not navigate away if the user explicitly has this voice channel selected or is connecting to it
      if (activeVoiceChannel?.id === activeChannel.id) {
        return;
      }
      let targetTextChan = previousTextChannelRef.current;
      if (!targetTextChan || targetTextChan.type === 'voice') {
        if (activeServer) {
          const serverChans = channels.filter((c) => c.server === activeServer.id);
          targetTextChan = serverChans.find((c) => c.type === 'text' || c.type === 'announcement') || null;
        }
        if (!targetTextChan && channels.length > 0) {
          targetTextChan = channels.find((c) => c.type === 'text' || c.type === 'announcement') || null;
        }
      }
      if (targetTextChan) {
        setActiveChannel(targetTextChan);
        previousTextChannelRef.current = targetTextChan;
      }
    }
  }, [activeRoom, activeChannel, activeVoiceChannel, activeServer, channels]);

  const handleLogout = () => {
    realtimeMediaProvider.disconnect().catch(() => {});
    offlineCacheService.clearUserCache();
    pbService.logout();
    setCurrentUser(null);
    setServers([]);
    setChannels([]);
    setMessages([]);
    setServerMessages([]);
    setActiveServer(null);
    setActiveChannel(null);
    setActiveVoiceChannel(null);
    setShowDiscoveryCenter(false);
    localStorage.removeItem('last_active_server_id');
  };

  const handleSelectNotification = async (notif: NotificationItem) => {
    // 1. Mark notification as read in state and persist to database (keeping in history)
    const updatedList = notificationsList.map((n) => (n.id === notif.id ? { ...n, read: true } : n));
    setNotificationsList(updatedList);
    if (currentUser?.id) {
      await pbService.updateUserNotifications(currentUser.id, updatedList);
    }

    // 2. Dismiss activeToast if it matches
    if (activeToast && activeToast.id === notif.message_id) {
      setActiveToast(null);
    }

    // 3. Friend request notification: navigate to Discovery Center
    if (notif.type === 'friend_request' || notif.channel_name === 'Friend Request') {
      setShowDiscoveryCenter(true);
      return;
    }


    // 4. Set target message ID for ChatPanel scrolling and highlighting
    if (notif.message_id) {
      setTargetMessageId(notif.message_id);
    }

    // 5. Navigate to DM or Server Channel
    if (notif.type === 'dm' || notif.channel_id === 'dm' || notif.private_chat_id) {
      if (notif.sender_id) {
        try {
          const senderUser = await pbService.fetchUserById(notif.sender_id);
          if (senderUser) {
            await handleStartDm(senderUser);
          } else {
            await handleStartDm({
              id: notif.sender_id,
              username: notif.sender_name,
              display_name: notif.sender_name,
              email: '',
              role: 'user',
              status: 'online',
              avatar: notif.sender_avatar
            } as User);
          }
          if (notif.message_id) {
            setTargetMessageId(notif.message_id);
          }
        } catch (e) {
          console.warn('Failed to start DM for notification:', e);
        }
      }
    } else if (notif.server_id) {
      let targetServer = servers.find((s) => s.id === notif.server_id);
      if (!targetServer) {
        try {
          targetServer = await pbService.getServerById(notif.server_id);
          if (targetServer) setServers((prev) => [...prev, targetServer!]);
        } catch (e) {
          console.warn('Could not fetch target server for notification:', e);
        }
      }
      if (targetServer) {
        setActiveServer(targetServer);
        setShowDiscoveryCenter(false);
        let serverChans = channelsCache.current[targetServer.id];
        if (!serverChans || serverChans.length === 0) {
          serverChans = await pbService.fetchChannels(targetServer.id);
          channelsCache.current[targetServer.id] = serverChans;
        }
        let targetChan = serverChans.find((c) => c.id === notif.channel_id);
        if (!targetChan && notif.channel_id) {
          try {
            targetChan = await pbService.getChannelById(notif.channel_id);
          } catch (e) {
            console.warn('Could not fetch channel by ID:', e);
          }
        }
        if (targetChan) {
          handleSelectChannel(targetChan, notif.message_id);
        }
      }
    } else if (notif.channel_id) {
      let targetChan = channels.find((c) => c.id === notif.channel_id);
      if (!targetChan) {
        try {
          targetChan = await pbService.getChannelById(notif.channel_id);
        } catch (e) {
          console.warn('Could not fetch channel by ID:', e);
        }
      }
      if (targetChan) {
        handleSelectChannel(targetChan, notif.message_id);
      }
    }
  };

  useEffect(() => {
    handleSelectNotificationRef.current = handleSelectNotification;
  }, [handleSelectNotification]);

  const handleMarkAllAsRead = async () => {
    const updatedList = notificationsList.map((n) => ({ ...n, read: true }));
    setNotificationsList(updatedList);
    if (currentUser?.id) {
      await pbService.updateUserNotifications(currentUser.id, updatedList);
    }
  };

  const handleClearNotifications = async () => {
    setNotificationsList([]);
    if (currentUser?.id) {
      await pbService.updateUserNotifications(currentUser.id, []);
    }
  };

  const handleAcceptFriendRequestNotif = async (notif: NotificationItem) => {
    if (!currentUser || !notif.sender_id) return;
    try {
      let mySettings = currentUser.settings;
      if (typeof mySettings === 'string') {
        try { mySettings = JSON.parse(mySettings); } catch { mySettings = {}; }
      }
      if (!mySettings) mySettings = {};

      const currentFriends = (Array.isArray(currentUser.friends) && currentUser.friends.length > 0)
        ? currentUser.friends
        : (mySettings.friends || []);
      const updatedFriends = Array.from(new Set([...currentFriends, notif.sender_id]));

      const currentReqs = mySettings.friend_requests || [];
      const updatedReqs = currentReqs.filter((r: any) => r.targetId !== notif.sender_id);

      const updatedSettings = {
        ...mySettings,
        friends: updatedFriends,
        friend_requests: updatedReqs
      };

      await pbService.updateProfile(currentUser.id, {
        friends: updatedFriends,
        settings: updatedSettings
      });
      currentUser.friends = updatedFriends;
      currentUser.settings = updatedSettings;

      // Update target sender settings in PocketBase schema
      try {
        const senderRecord = await pbService.fetchUserById(notif.sender_id);
        if (senderRecord) {
          let sSettings = senderRecord.settings;
          if (typeof sSettings === 'string') {
            try { sSettings = JSON.parse(sSettings); } catch { sSettings = {}; }
          }
          if (!sSettings) sSettings = {};

          const sFriends = (Array.isArray(senderRecord.friends) && senderRecord.friends.length > 0)
            ? senderRecord.friends
            : (sSettings.friends || []);
          const sReqs = sSettings.friend_requests || [];

          const newSFriends = Array.from(new Set([...sFriends, currentUser.id]));

          await pbService.updateProfile(notif.sender_id, {
            friends: newSFriends,
            settings: {
              ...sSettings,
              friends: newSFriends,
              friend_requests: sReqs.filter((r: any) => r.targetId !== currentUser.id)
            }
          });
        }
      } catch (e) {
        console.warn('Failed to update sender friend settings:', e);
      }

      const myAvatarUrl = currentUser.avatar ? (
        currentUser.avatar.startsWith('http') || currentUser.avatar.startsWith('blob:')
          ? currentUser.avatar
          : `${pbService.getServerUrl()}/api/files/users/${currentUser.id}/${currentUser.avatar}`
      ) : undefined;

      // Notify sender
      await pbService.addNotificationToUser(notif.sender_id, {
        id: 'notif-fra-' + Date.now(),
        type: 'mention',
        sender_id: currentUser.id,
        sender_name: currentUser.display_name || currentUser.username,
        sender_avatar: myAvatarUrl,
        channel_id: 'dm',
        channel_name: 'Friend Request Accepted',
        message_id: 'fra-' + Date.now(),
        message_content: lang === 'ar' ? `قبل ${currentUser.display_name || currentUser.username} طلب الصداقة!` : `${currentUser.display_name || currentUser.username} accepted your friend request!`,
        created: new Date().toISOString(),
        read: false
      });

      const updatedList = notificationsList.map((n) => (n.id === notif.id ? { ...n, read: true } : n));
      setNotificationsList(updatedList);
      if (currentUser?.id) {
        await pbService.updateUserNotifications(currentUser.id, updatedList);
      }
    } catch (err) {
      console.error('Failed to accept friend request from notification:', err);
    }
  };

  const handleDeclineFriendRequestNotif = async (notif: NotificationItem) => {
    if (!currentUser || !notif.sender_id) return;
    try {
      let mySettings = currentUser.settings;
      if (typeof mySettings === 'string') {
        try { mySettings = JSON.parse(mySettings); } catch { mySettings = {}; }
      }
      if (!mySettings) mySettings = {};

      const currentReqs = mySettings.friend_requests || [];
      const updatedReqs = currentReqs.filter((r: any) => r.targetId !== notif.sender_id);

      const updatedSettings = {
        ...mySettings,
        friend_requests: updatedReqs
      };

      await pbService.updateProfile(currentUser.id, { settings: updatedSettings });
      currentUser.settings = updatedSettings;

      const updatedList = notificationsList.map((n) => (n.id === notif.id ? { ...n, read: true } : n));
      setNotificationsList(updatedList);
      if (currentUser?.id) {
        await pbService.updateUserNotifications(currentUser.id, updatedList);
      }
    } catch (err) {
      console.error('Failed to decline friend request from notification:', err);
    }
  };

  const t = (key: string): string => {
    return langConfig[key] || key;
  };

  const handleSetLangAndPersist = (l: 'en' | 'ar') => {
    setLang(l);
    localStorage.setItem('app_lang', l);
  };

  const retryBackendReads = useCallback(() => {
    backendAvailability.reset();
    gatewayBootstrapStateRef.current = 'idle';
    gatewayBootstrapFailureAtRef.current = 0;
    gatewayBootstrapRef.current = null;
    if (currentUser?.id) {
      void loadServers();
      void loadAllDmChannels();
      if (activeServer?.id) void loadChannels(activeServer.id);
      if (activeChannel?.id) void loadMessages(activeChannel.id, 1, false, null, INITIAL_MESSAGE_PAGE_SIZE);
    }
  }, [currentUser?.id, activeServer?.id, activeChannel?.id]);

  // Map theme variables to CSS custom properties
  const themeClasses: any = {
    rootBg: 'bg-[var(--theme-bg-primary)] text-[var(--theme-text-primary)]',
    sidebarBg: 'bg-[var(--theme-bg-secondary)] border-[var(--theme-border)]',
    panelBg: 'bg-[var(--theme-bg-primary)]',
    cardBg: 'bg-[var(--theme-bg-card)] border-[var(--theme-border)]',
    inputBg: 'bg-[var(--theme-bg-tertiary)] border-[var(--theme-border)] text-[var(--theme-text-primary)]',
    activeChannelBg: 'bg-accent/20 text-accent',
    primaryBtn: 'bg-accent hover:opacity-90 text-white',
  };

  const fontClass = 'font-sans';

  const sizeClass = {
    small: 'text-xs',
    medium: 'text-sm',
    large: 'text-base',
    xlarge: 'text-lg'
  }[userSettings.appearance.fontSize] || 'text-sm';

  const animClass = `anim-${userSettings.appearance.animations || 'high'}`;

  return (
    <>
      <div id="theme-wallpaper-layer" aria-hidden="true" />
      <div
        dir={lang === 'ar' ? 'rtl' : 'ltr'}
        className={`app-root-container h-full w-full overflow-hidden flex flex-col antialiased select-none ${themeClasses.rootBg} ${fontClass} ${sizeClass} ${animClass}`}
      >
      {isDesktop && (
        <TitleBar
          appName="SirverData"
          isLight={effectiveTheme === 'light'}
          lang={lang}
          onOpenSettings={() => setShowSettings(true)}
          isConnected={backendStatus === 'online'}
        />
      )}
      {currentUser && backendStatus !== 'online' && (
        <div className="absolute top-2 start-1/2 -translate-x-1/2 z-40 pointer-events-auto max-w-[90vw] animate-in fade-in duration-200">
          <div
            role="status"
            aria-live="polite"
            className={`px-3 py-1 rounded-full flex items-center gap-2 text-[11px] font-semibold shadow-lg backdrop-blur-md border ${
              backendStatus === 'offline'
                ? 'bg-rose-950/90 border-rose-500/40 text-rose-300 shadow-rose-950/40'
                : 'bg-amber-950/90 border-amber-500/40 text-amber-300 shadow-amber-950/40'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${backendStatus === 'offline' ? 'bg-rose-400' : 'bg-amber-400'} animate-pulse`} />
            <span className="truncate">
              {backendStatus === 'offline'
                ? (lang === 'ar' ? 'الخدمة غير متاحة — يتم عرض البيانات المحفوظة' : 'Chat service unavailable — showing saved data')
                : (lang === 'ar' ? 'اتصال متدهور — يتم تحديث البيانات في الخلفية' : 'Connection degraded — refreshing in the background')}
            </span>
            {backendError && <span className="hidden sm:inline opacity-70 truncate max-w-[200px] text-[10px] font-mono">({backendError})</span>}
            <button
              type="button"
              onClick={retryBackendReads}
              className="px-2 py-0.5 rounded-md border border-current/30 hover:bg-white/10 cursor-pointer text-[10px] shrink-0 font-bold active:scale-95 transition-transform"
            >
              {lang === 'ar' ? 'إعادة المحاولة' : 'Retry'}
            </button>
          </div>
        </div>
      )}
      <div className="flex-1 flex w-full min-h-0 overflow-hidden relative">
        <AnimatePresence mode="wait">
          {resetToken ? (
            <motion.div
              key="reset-password-screen"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="w-full h-full"
            >
              <ResetPasswordScreen
                token={resetToken}
                onComplete={() => {
                  setResetToken(null);
                  if (typeof window !== 'undefined' && window.history?.replaceState) {
                    window.history.replaceState({}, document.title, window.location.pathname);
                  }
                }}
                onCancel={() => {
                  setResetToken(null);
                  if (typeof window !== 'undefined' && window.history?.replaceState) {
                    window.history.replaceState({}, document.title, window.location.pathname);
                  }
                }}
                lang={lang}
                t={t}
                toggleLang={() => handleSetLangAndPersist(lang === 'en' ? 'ar' : 'en')}
              />
            </motion.div>
          ) : !currentUser ? (
            <motion.div
              key="auth"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="w-full h-full"
            >
              <AuthScreen
                onAuthSuccess={(user) => {
                  setCurrentUser(user);
                  let userSet = user.settings;
                  if (typeof userSet === 'string') {
                    try { userSet = JSON.parse(userSet); } catch (e) {}
                  }
                  const cachedSettings = getCachedUserSettings();
                  const merged = mergeWithDefaults({
                    ...cachedSettings,
                    ...(userSet || {}),
                    appearance: {
                      ...cachedSettings.appearance,
                      ...(userSet?.appearance || {}),
                    },
                    languageRegion: {
                      ...cachedSettings.languageRegion,
                      ...(userSet?.languageRegion || {}),
                    },
                  });
                  setUserSettings(merged);
                  saveCachedUserSettings(merged);
                  applySettingsToDocument(merged);

                  const settingsLang = merged.languageRegion?.appLanguage;
                  const rawPref = (user as any)?.preferred_language || (user as any)?.preferredLanguage || user?.language;
                  let targetLang: 'en' | 'ar' | null = null;
                  if (settingsLang === 'en' || settingsLang === 'ar') {
                    targetLang = settingsLang;
                  } else if (rawPref) {
                    const lower = String(rawPref).toLowerCase().trim();
                    if (lower.startsWith('ar') || lower.includes('arabic') || lower.includes('العربية')) targetLang = 'ar';
                    else if (lower.startsWith('en') || lower.includes('english')) targetLang = 'en';
                  }
                  if (targetLang) {
                    setLang(targetLang);
                    localStorage.setItem('app_lang', targetLang);
                  }

                  // Avatar processing is an opt-in post-login enhancement.
                  // Keep its canvas/optimizer code out of the startup chunk
                  // and never delay the first usable workspace.
                  void import('./services/avatarProcessor').then(({ processAndOptimizeUserAvatar }) =>
                    processAndOptimizeUserAvatar(user).then((optimized) => {
                      if (optimized) setCurrentUser(optimized);
                    }),
                  ).catch(() => {});
                }}
                lang={lang}
                t={t}
                toggleLang={() => handleSetLangAndPersist(lang === 'en' ? 'ar' : 'en')}
                serverUrl={serverUrl}
                setServerUrl={(url) => {
                  setServerUrl(url);
                  pbService.setServerUrl(url);
                }}
              />
            </motion.div>
          ) : (
            <motion.div
              key="app-workspace"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="w-full h-full flex"
            >
            {/* Unified Collaboration Sidebar Navigation */}
            {/* Desktop Static Sidebar */}
            {!isMobile && (
              <div className="hidden md:flex md:relative md:inset-auto md:z-auto w-80 h-full shrink-0">
                <ChannelList
                  servers={servers}
                  activeServer={activeServer}
                  onSelectServer={handleSelectServerFromSidebar}
                  channels={channels}
                  activeChannel={activeChannel}
                  onSelectChannel={handleSelectChannelFromSidebar}
                  currentUser={currentUser}
                  onOpenSettings={handleOpenSettingsFromSidebar}
                  onOpenCreateServer={handleOpenCreateServerFromSidebar}
                  onLogout={handleLogout}
                  serverUrl={serverUrl}
                  lang={lang}
                  t={t}
                  activeVoiceChannel={activeVoiceChannel}
                  onLeaveVoice={handleLeaveVoice}
                  onExpandVoice={handleExpandVoice}
                  isMuted={isMuted}
                  onToggleMute={handleToggleMuteCallback}
                  isDeafened={isDeafened}
                  onToggleDeafen={handleToggleDeafenCallback}
                  activeCalls={EMPTY_ACTIVE_CALLS}
                  theme={effectiveTheme}
                  onSelectUser={(u, anchor) => {
                    setIsGlobalSelfProfile(false);
                    handleSelectUser(u, anchor);
                    setIsSidebarOpen(false);
                  }}
                  onSelectSelfGlobalProfile={(e) => {
                    setIsGlobalSelfProfile(true);
                    if (currentUser) {
                      handleSelectUser(currentUser, e || null);
                    }
                    setIsSidebarOpen(false);
                  }}
                  activeFriends={showDiscoveryCenter && discoveryTab === 'friends'}
                  onSelectFriends={handleSelectFriendsFromSidebar}
                  activeDiscovery={showDiscoveryCenter && discoveryTab === 'servers'}
                  onSelectDiscovery={handleSelectDiscoveryFromSidebar}
                  unreadCounts={unreadCounts}
                  allDmChannels={allDmChannels}
                  onOpenNewDmModal={handleOpenNewDmModalFromSidebar}
                  onDeleteChannel={handleDeleteChannel}
                  onDeleteServer={activeServer ? () => handleDeleteServer(activeServer.id) : undefined}
                  onLeaveServer={activeServer ? handleLeaveServer : undefined}
                  onUpdateUser={handleUpdateUserFromSidebar}
                  onOpenServerSettings={handleOpenServerSettingsFromSidebar}
                  onCloseDm={handleCloseDm}
                />
              </div>
            )}

            {/* In-App Floating Liquid Glass Notification Toast */}
            <NotificationToast
              toast={activeToast}
              onDismiss={() => setActiveToast(null)}
              onOpenToast={(toast) => {
                const matchingNotif = notificationsList.find((n) => n.message_id === toast.id);
                if (matchingNotif) {
                  handleSelectNotification(matchingNotif);
                } else {
                  handleSelectNotification({
                    id: 'toast-' + toast.id,
                    sender_id: '',
                    sender_name: toast.senderName || toast.title,
                    channel_id: toast.channelId || '',
                    channel_name: '',
                    server_id: toast.serverId,
                    message_id: toast.id,
                    message_content: toast.body,
                    created: new Date().toISOString(),
                    read: true
                  });
                }
              }}
              lang={lang}
            />

            {/* Mobile Slide-Over Left Channels Drawer */}
            <AnimatePresence>
              {(isSidebarOpen || sidebarDragState.isDragging) && (
                <>
                  <motion.div
                    key="channels-drawer-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: sidebarDragState.isDragging ? sidebarDragState.opacity : 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: sidebarDragState.isDragging ? 0 : 0.28, ease: 'easeOut' }}
                    onClick={handleCloseSidebar}
                    className="fixed inset-0 bg-black/60 z-[70] md:hidden pointer-events-auto"
                  />
                  <motion.div
                    key="channels-drawer-panel"
                    initial={{ transform: `translate3d(${lang === 'ar' ? '100%' : '-100%'}, 0px, 0px)` }}
                    animate={{
                      transform: sidebarDragState.isDragging
                        ? `translate3d(${sidebarDragState.dragX}px, 0px, 0px)`
                        : 'translate3d(0px, 0px, 0px)',
                    }}
                    exit={{
                      transform: `translate3d(${lang === 'ar' ? '100%' : '-100%'}, 0px, 0px)`,
                    }}
                    transition={{
                      duration: sidebarDragState.isDragging ? 0 : 0.32,
                      ease: sidebarDragState.isDragging ? 'linear' : [0.32, 0.72, 0, 1],
                    }}
                    style={{ willChange: 'transform' }}
                    onClick={(e) => e.stopPropagation()}
                    data-mobile-drawer="channels"
                    className={`fixed inset-y-0 ${lang === 'ar' ? 'right-0 border-l' : 'left-0 border-r'} border-[var(--theme-border)] z-[70] w-[78vw] max-w-[320px] sm:w-[50vw] sm:max-w-[340px] md:w-80 shrink-0 md:hidden bg-[var(--theme-bg-secondary)] text-[var(--theme-text-primary)] flex flex-col overflow-hidden shadow-2xl mobile-drawer-panel`}
                  >
                    <ChannelList
                      servers={servers}
                      activeServer={activeServer}
                      onSelectServer={handleSelectServerFromSidebar}
                      channels={channels}
                      activeChannel={activeChannel}
                      onSelectChannel={handleSelectChannelFromSidebar}
                      currentUser={currentUser}
                      onOpenSettings={handleOpenSettingsFromSidebar}
                      onOpenCreateServer={handleOpenCreateServerFromSidebar}
                      onLogout={handleLogout}
                      serverUrl={serverUrl}
                      lang={lang}
                      t={t}
                      activeVoiceChannel={activeVoiceChannel}
                      onLeaveVoice={handleLeaveVoice}
                      onExpandVoice={handleExpandVoice}
                      isMuted={isMuted}
                      onToggleMute={handleToggleMuteCallback}
                      isDeafened={isDeafened}
                      onToggleDeafen={handleToggleDeafenCallback}
                      activeCalls={EMPTY_ACTIVE_CALLS}
                      theme={effectiveTheme}
                      onSelectUser={(u, anchor) => {
                        setIsGlobalSelfProfile(false);
                        handleSelectUser(u, anchor);
                        setIsSidebarOpen(false);
                      }}
                      onSelectSelfGlobalProfile={(e) => {
                        setIsGlobalSelfProfile(true);
                        if (currentUser) {
                          handleSelectUser(currentUser, e || null);
                        }
                        setIsSidebarOpen(false);
                      }}
                      activeFriends={showDiscoveryCenter && discoveryTab === 'friends'}
                      onSelectFriends={handleSelectFriendsFromSidebar}
                      activeDiscovery={showDiscoveryCenter && discoveryTab === 'servers'}
                      onSelectDiscovery={handleSelectDiscoveryFromSidebar}
                      unreadCounts={unreadCounts}
                      allDmChannels={allDmChannels}
                      onOpenNewDmModal={handleOpenNewDmModalFromSidebar}
                      onDeleteChannel={handleDeleteChannel}
                      onDeleteServer={activeServer ? () => handleDeleteServer(activeServer.id) : undefined}
                      onLeaveServer={activeServer ? handleLeaveServer : undefined}
                      onUpdateUser={handleUpdateUserFromSidebar}
                      onOpenServerSettings={handleOpenServerSettingsFromSidebar}
                      onCloseDm={handleCloseDm}
                    />
                  </motion.div>
                </>
              )}
            </AnimatePresence>

            {/* 3. Main Action Panel (Swaps between Mobile Settings Page, Discovery, Voice Stage, or Chat) */}
            <div className="flex-1 flex min-w-0 w-full h-full relative">
              {isMobile && showSettings && currentUser ? (
                <Suspense fallback={null}>
                  <SettingsModal
                    isMobilePage={true}
                    currentUser={currentUser}
                    onUpdateUser={(updated) => setCurrentUser(updated)}
                    onClose={() => setShowSettings(false)}
                    serverUrl={serverUrl}
                    setServerUrl={(url) => {
                      setServerUrl(url);
                      pbService.setServerUrl(url);
                    }}
                    lang={lang}
                    setLang={handleSetLangAndPersist}
                    t={t}
                    userSettings={userSettings}
                    onUpdateUserSettings={handleUpdateUserSettings}
                    onLogout={handleLogout}
                    servers={servers}
                    activeServer={activeServer}
                    channels={channels}
                    onChannelCreated={(newChan) => setChannels((prev) => [...prev, newChan])}
                    onChannelUpdated={(updatedChan) => {
                      setChannels((prev) => prev.map((c) => (c.id === updatedChan.id ? updatedChan : c)));
                      if (activeChannel?.id === updatedChan.id) {
                        setActiveChannel(updatedChan);
                      }
                    }}
                    onDeleteChannel={handleDeleteChannel}
                    onDeleteServer={handleDeleteServer}
                    onOpenServerSettings={(srv) => setServerSettingsModalServer(srv)}
                    onServerUpdated={(updated) => {
                      setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                      if (activeServer?.id === updated.id) {
                        setActiveServer(updated);
                      }
                    }}
                  />
                </Suspense>
              ) : showDiscoveryCenter ? (
                <Suspense fallback={null}>
                  <DiscoveryCenter
                    initialTab={discoveryTab}
                    currentUser={currentUser}
                    onJoinServerSuccess={async (serverId) => {
                      await loadServers();
                      // Load server channels
                      try {
                        const list = await pbService.fetchServers();
                        const match = list.find((s) => s.id === serverId);
                        if (match) {
                          setActiveServer(match);
                          await loadChannels(serverId);
                        }
                      } catch (e) {
                        console.warn(e);
                      }
                      setShowDiscoveryCenter(false);
                    }}
                    joinedServers={servers}
                    t={t}
                    lang={lang}
                    theme={effectiveTheme}
                    onSelectUser={handleSelectUser}
                    onToggleSidebar={handleToggleSidebar}
                    onStartDm={handleStartDm}
                    onStartCall={handleStartCallDm}
                  />
                </Suspense>
              ) : (activeChannel && activeChannel.type === 'voice') ? (
                <Suspense fallback={
                  <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--theme-text-muted)]">
                    <div className="w-8 h-8 rounded-full border-2 border-[var(--theme-accent)] border-t-transparent animate-spin" />
                    <span className="text-xs font-semibold">{lang === 'ar' ? 'جارٍ تحميل المكالمة…' : 'Loading call…'}</span>
                  </div>
                }>
                  <VoicePanel
                    channel={activeChannel}
                    currentUser={currentUser}
                    isMuted={isMuted}
                    isDeafened={isDeafened}
                    onToggleMute={handleToggleMuteCallback}
                    onToggleDeafen={handleToggleDeafenCallback}
                    onLeave={handleLeaveVoice}
                    t={t}
                    lang={lang}
                    theme={effectiveTheme}
                    onSelectUser={handleSelectUser}
                    onToggleSidebar={handleToggleSidebar}
                    initialMode={activeCallMode}
                  />
                </Suspense>
              ) : (activeChannel || activeServerChannel || activeDmChannel) ? (
                <div className="flex-1 flex min-w-0 w-full h-full relative overflow-hidden">
                  {(() => {
                    const currentChatChannel = activeChannel || activeServerChannel || activeDmChannel;
                    if (!currentChatChannel) return null;

                    const isDm = Boolean(currentChatChannel.server === 'dm' || currentChatChannel.name.startsWith('@'));
                    const targetServer = !isDm
                      ? (servers.find((s) => s.id === currentChatChannel.server || s.id === (currentChatChannel as any).server_id) ||
                         (activeServer?.id === currentChatChannel.server ? activeServer : undefined) ||
                         servers.find((s) => s.id === activeServer?.id) ||
                         activeServer ||
                         pbService.getCachedServers?.()?.find((s) => s.id === currentChatChannel.server) ||
                         (currentChatChannel.server && currentChatChannel.server !== 'dm' ? ({ id: currentChatChannel.server, name: currentChatChannel.name } as Server) : undefined))
                      : undefined;

                    return (
                      <Suspense fallback={
                        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--theme-text-muted)]">
                          <div className="w-8 h-8 rounded-full border-2 border-[var(--theme-accent)] border-t-transparent animate-spin" />
                          <span className="text-xs font-semibold">{lang === 'ar' ? 'جارٍ تحميل المحادثة…' : 'Loading conversation…'}</span>
                        </div>
                      }>
                      <ChatPanel
                        isActive={true}
                        isInitialLoading={isInitialLoadingChannel}
                        readOnly={backendStatus === 'offline'}
                        channel={currentChatChannel}
                        messages={messages}
                        currentUser={currentUser}
                        onSendMessage={handleSendMessage}
                        onDeleteMessage={handleDeleteMessage}
                        onEditMessage={handleEditMessage}
                        onToggleReaction={handleToggleReaction}
                        onDeleteChannel={handleDeleteChannel}
                        onDeleteServer={!isDm && targetServer ? () => handleDeleteServer(targetServer.id) : undefined}
                        t={t}
                        lang={lang}
                        theme={effectiveTheme}
                        onSelectUser={handleSelectUser}
                        server={targetServer}
                        onUpdateChannel={handleUpdateChannelInChat}
                        onUpdateServer={handleUpdateServerInChat}
                        isSidebarOpen={isSidebarOpen}
                        onToggleSidebar={handleToggleSidebar}
                        onStartCall={backendStatus === 'offline' ? undefined : handleStartCall}
                        hasMoreMessages={hasMoreMessages}
                        isLoadingMore={isLoadingMore}
                        onLoadMoreMessages={handleLoadMoreMessages}
                        onPlayGlobalTrack={handlePlayGlobalTrack}
                        targetMessageId={targetMessageId}
                        onClearTargetMessage={handleClearTargetMessage}
                        notificationsList={notificationsList}
                        onSelectNotification={handleSelectNotification}
                        onMarkAllAsRead={handleMarkAllAsRead}
                        onClearNotifications={handleClearNotifications}
                        onAcceptFriendRequest={handleAcceptFriendRequestNotif}
                        onDeclineFriendRequest={handleDeclineFriendRequestNotif}
                        activeUpload={activeUpload}
                        onSkipUploadFile={handleSkipUploadFile}
                        onCancelUploadMessage={handleCancelUploadMessage}
                        unreadCountOnOpen={activeUnreadCountOnOpen && activeUnreadCountOnOpen.channelId === currentChatChannel.id ? activeUnreadCountOnOpen.count : 0}
                        serverChannels={channels}
                        onNavigateToMessageLink={handleNavigateToMessageLink}
                        activeVoiceChannel={activeVoiceChannel}
                        onCloseDm={isDm ? () => handleCloseDm(currentChatChannel) : undefined}
                        onExpandVoice={handleExpandVoice}
                      />
                      </Suspense>
                    );
                  })()}
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-2 select-none">
                  {/* Toggle button on empty screen for mobile */}
                  <button
                    onClick={handleToggleSidebar}
                    className="md:hidden px-4 py-2 bg-accent hover:opacity-90 text-[var(--theme-bg-primary)] rounded-xl text-xs font-bold mb-4 flex items-center gap-2 border-0 cursor-pointer"
                  >
                    <span>{lang === 'ar' ? 'عرض القنوات' : 'Show Channels'}</span>
                  </button>
                  <span className="text-sm italic">{lang === 'ar' ? 'انضم إلى إحدى القنوات لبدء المحادثة.' : 'Join or create a channel to begin communicating.'}</span>
                </div>
              )}
            </div>

            {/* Modals Drawers */}
            <Suspense fallback={null}>
              <AnimatePresence>
                {/* Profile Settings Modal (Desktop Only Overlay) */}
                {!isMobile && showSettings && currentUser && (
                  <SettingsModal
                    currentUser={currentUser}
                    onUpdateUser={(updated) => setCurrentUser(updated)}
                    onClose={() => setShowSettings(false)}
                    serverUrl={serverUrl}
                    setServerUrl={(url) => {
                      setServerUrl(url);
                      pbService.setServerUrl(url);
                    }}
                    lang={lang}
                    setLang={handleSetLangAndPersist}
                    t={t}
                    userSettings={userSettings}
                    onUpdateUserSettings={handleUpdateUserSettings}
                    onLogout={handleLogout}
                    servers={servers}
                    activeServer={activeServer}
                    channels={channels}
                    onChannelCreated={(newChan) => setChannels((prev) => [...prev, newChan])}
                    onChannelUpdated={(updatedChan) => {
                      setChannels((prev) => prev.map((c) => (c.id === updatedChan.id ? updatedChan : c)));
                      if (activeChannel?.id === updatedChan.id) {
                        setActiveChannel(updatedChan);
                      }
                    }}
                    onDeleteChannel={handleDeleteChannel}
                    onDeleteServer={handleDeleteServer}
                    onOpenServerSettings={(srv) => setServerSettingsModalServer(srv)}
                    onServerUpdated={(updated) => {
                      setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                      if (activeServer?.id === updated.id) {
                        setActiveServer(updated);
                      }
                    }}
                  />
                )}

                {/* Dedicated Server Settings & Roles Modal */}
                {serverSettingsModalServer && currentUser && (
                  <ServerSettingsModal
                    server={serverSettingsModalServer}
                    currentUser={currentUser}
                    channels={channels.filter((c) => c.server === serverSettingsModalServer.id)}
                    onClose={() => setServerSettingsModalServer(null)}
                    onServerUpdated={(updated) => {
                      setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                      if (activeServer?.id === updated.id) {
                        setActiveServer(updated);
                      }
                    }}
                    onChannelCreated={(newChan) => setChannels((prev) => [...prev, newChan])}
                    onChannelUpdated={(updatedChan) => {
                      setChannels((prev) => prev.map((c) => (c.id === updatedChan.id ? updatedChan : c)));
                      if (activeChannel?.id === updatedChan.id) {
                        setActiveChannel(updatedChan);
                      }
                    }}
                    onChannelDeleted={handleDeleteChannel}
                    onServerDeleted={(sId) => {
                      handleDeleteServer(sId);
                      setServerSettingsModalServer(null);
                    }}
                    onLeaveServer={(srv) => {
                      handleLeaveServer(srv);
                      setServerSettingsModalServer(null);
                    }}
                    t={t}
                    lang={lang}
                    theme={effectiveTheme}
                  />
                )}

                {/* Create Server */}
                {showCreateServer && (
                  <CreateServerModal
                    onClose={() => setShowCreateServer(false)}
                    onServerCreated={(newServer) => {
                      setServers((prev) => [...prev, newServer]);
                      setActiveServer(newServer);
                    }}
                    t={t}
                    theme={effectiveTheme}
                  />
                )}

                {/* User Profile Modal */}
                {selectedUserProfile && (
                  <UserProfileModal
                    key={`${selectedUserProfile.id}-${profileAnchorRect?.left || 0}-${profileAnchorRect?.top || 0}`}
                    user={selectedUserProfile.id === currentUser?.id ? (currentUser as User) : selectedUserProfile}
                    currentUser={currentUser || undefined}
                    currentServer={
                      (!isGlobalSelfProfile && !showDiscoveryCenter && activeServer && activeChannel && activeChannel.server === activeServer.id && activeChannel.server !== 'dm' && !activeChannel.name.startsWith('@'))
                        ? activeServer
                        : undefined
                    }
                    onClose={() => handleSelectUser(null)}
                    lang={lang}
                    t={t}
                    theme={effectiveTheme}
                    animations={userSettings.appearance.animations}
                    onStartDm={handleStartDm}
                    onStartCall={handleStartCallDm}
                    onKickMember={handleKickMember}
                    anchorRect={profileAnchorRect}
                    preferredPlacement={isGlobalSelfProfile ? 'above' : undefined}
                    onUpdateUser={(updated) => setCurrentUser(updated)}
                    isEditable={isGlobalSelfProfile}
                  />
                )}

                {/* New DM Search Modal */}
                {showNewDmModal && currentUser && (
                  <NewDmModal
                    currentUser={currentUser}
                    onClose={() => setShowNewDmModal(false)}
                    onSelectUserToDm={(targetUser) => {
                      handleStartDm(targetUser);
                    }}
                    lang={lang}
                    allDmChannels={allDmChannels}
                  />
                )}

                {/* Leave Server Modal */}
                {leavingServer && currentUser && (
                  <LeaveServerModal
                    isOpen={Boolean(leavingServer)}
                    server={leavingServer}
                    currentUser={currentUser}
                    lang={lang}
                    onClose={() => setLeavingServer(null)}
                    onSuccess={handleLeaveServerSuccess}
                  />
                )}
              </AnimatePresence>
            </Suspense>

            {/* Switch Voice Channel Confirmation Modal */}
            {pendingVoiceSwitchChannel && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 animate-in fade-in duration-200">
                <div className="w-full max-w-md p-6 rounded-2xl border shadow-2xl bg-[var(--theme-bg-card)] border-[var(--theme-border)] text-[var(--theme-text-primary)]">
                  <div className="flex items-center gap-3 mb-4 text-amber-500">
                    <Volume2 className="w-6 h-6 animate-pulse" />
                    <h3 className="text-lg font-bold">
                      {lang === 'ar' ? 'تبديل القناة الصوتية؟' : 'Switch Voice Channel?'}
                    </h3>
                  </div>
                  <p className="text-sm text-[var(--theme-text-secondary)] mb-6">
                    {lang === 'ar'
                      ? `أنت متصل حالياً بالقناة "${activeVoiceChannel?.name}". هل تريد قطع الاتصال والانضمام إلى "${pendingVoiceSwitchChannel.name}"؟`
                      : `You are currently connected to "${activeVoiceChannel?.name}". Would you like to disconnect and join "${pendingVoiceSwitchChannel.name}"?`}
                  </p>
                  <div className="flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setPendingVoiceSwitchChannel(null)}
                      className="px-4 py-2 rounded-xl bg-[var(--theme-bg-tertiary)] text-[var(--theme-text-primary)] hover:opacity-80 transition-opacity font-medium text-sm cursor-pointer border-0"
                    >
                      {lang === 'ar' ? 'إلغاء' : 'Cancel'}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const targetChan = pendingVoiceSwitchChannel;
                        setPendingVoiceSwitchChannel(null);
                        if (targetChan) {
                          await leaveRoomOrCall();
                          setActiveVoiceChannel(targetChan);
                          setActiveChannel(targetChan);
                          lastVoiceChannelRef.current = targetChan;
                        }
                      }}
                      className="px-4 py-2 rounded-xl bg-accent text-white hover:opacity-90 transition-opacity font-bold text-sm cursor-pointer border-0 shadow-md shadow-accent/20"
                    >
                      {lang === 'ar' ? 'تبديل القناة' : 'Switch Channel'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Global Floating Call Window (Incoming Ringing, Outgoing Calling & Active Room Overlay) */}
            <FloatingCallWindow
              lang={lang}
              t={t}
              currentChannel={activeChannel}
              onExpand={() => {
                const voiceRoomId = activeVoiceChannel?.id;
                if (voiceRoomId) {
                  const targetChan = channels.find((c) => c.id === voiceRoomId) || allDmChannels.find((c) => c.id === voiceRoomId);
                  if (targetChan) {
                    handleSelectChannel(targetChan);
                  }
                }
              }}
            />

            {/* Persistent Global Music Player */}
            {activeGlobalTrack && (
              <GlobalMusicPlayer
                track={activeGlobalTrack}
                onClose={() => setActiveGlobalTrack(null)}
                lang={lang}
                isLight={effectiveTheme === 'light'}
              />
            )}

            {/* Double Back Exit Toast Notification */}
            <AnimatePresence>
              {exitToast && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] bg-slate-900/95 text-white px-5 py-2.5 rounded-full text-xs font-bold shadow-2xl border border-slate-700/80 pointer-events-none flex items-center gap-2"
                >
                  <span>{exitToast}</span>
                </motion.div>
              )}
            </AnimatePresence>

          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
    </>
  );
}
