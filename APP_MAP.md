# Sirver - Master Application Architecture & Map (APP_MAP)

This document provides a complete, high-level and detailed architectural map of the **Sirver** platform. Consult this file to understand any module, data flow, state hierarchy, or caching tier across the codebase without reading the entire repository.

---

## 1. Directory & File Map

```
/
├── index.html                   # HTML entry point, SEO meta tags, Google Fonts, theme init
├── metadata.json                # Applet configuration, permissions, major capabilities
├── vite.config.ts               # Vite configuration (port 3000, React plugin, Tailwind)
├── tailwind.config.js           # Tailwind CSS theme configuration (custom colors, Avocado Green #7BAE37)
├── package.json                 # Dependencies & build scripts (Vite, React 18, PocketBase, LiveKit, Lucide)
├── THEME_GUIDE.md               # Visual design tokens, light/dark themes, Avocado accents
├── PROJECT_CONTEXT.md           # Brief project context
├── APP_MAP.md                   # MASTER ARCHITECTURE MAP (This file)
│
└── src/
    ├── main.tsx                 # React DOM mount, StrictMode, error boundaries
    ├── App.tsx                  # ROOT ORCHESTRATOR: State management, routing, navigation, modals, feeds
    ├── types.ts                 # Master TypeScript interfaces, entities, pagination, and data contracts
    ├── pocketbase.ts            # POCKETBASE CLIENT SERVICE: All API calls, subscriptions, error wrappers
    │
    ├── config/
    │   ├── endpoints.ts         # Backend API URLs, WebSocket endpoints
    │   └── urls.ts              # External URLs, CDN links, asset paths
    │
    ├── context/
    │   ├── MediaContext.tsx     # Voice/Video WebRTC state manager, room transitions, devices, calls
    │   └── ThemeContext.tsx     # Light/Dark theme provider, token injection, persistence
    │
    ├── services/
    │   ├── sessionSnapshot.ts   # L2 fast startup snapshot: synchronous localStorage recovery
    │   ├── offlineCacheService.ts # L3 IndexedDB durable persistence & L1 memory cache
    │   ├── messagePagination.ts # Pagination constants (20/page), cursor calculation, merge logic
    │   ├── backendAvailability.ts # Circuit breaker & backend health monitor
    │   ├── callSignaling.ts     # WebRTC 1:1 call signaling via PocketBase/WebSocket
    │   ├── voicePresenceStore.ts# Live voice participant tracking & speaking events
    │   ├── messageDeletionService.ts # Client-side deletion & tombstone tracking
    │   ├── audioMixer.ts        # Per-participant volume & audio processing
    │   ├── notificationService.ts # Native & web notification dispatch
    │   └── websocket.ts         # Low-latency WebSocket fallback for realtime events
    │
    ├── media/
    │   ├── RealtimeMediaProvider.ts # Audio/Video device acquisition & stream management
    │   └── livekit/
    │       └── LiveKitManager.ts # LiveKit SFU client implementation & token negotiation
    │
    └── components/
        ├── ChatPanel.tsx        # PRIMARY CHAT VIEW: Message feed, virtualization, scroll retention, input
        ├── VoicePanel.tsx       # VOICE STAGE: Grid of participants, audio/video toggles, instant join
        ├── ChannelList.tsx      # Sidebar channel tree (text/voice), DMs list, user footer
        ├── ServerRail.tsx       # Far-left server icon list, discovery button, add server
        ├── DiscoveryCenter.tsx  # Server explorer & friend finder modal
        ├── MessageItem.tsx      # Individual message bubble, avatar, timestamp, attachments, reactions
        ├── MessageReactions.tsx # Emoji reaction picker & counter badges
        ├── MessageLinkPreview.tsx # In-app quote preview for referenced messages
        ├── SmartWebLinkPreview.tsx# OpenGraph rich link previews
        ├── FloatingCallWindow.tsx# Picture-in-Picture mini call overlay when browsing text chats
        ├── AudioMixerModal.tsx  # Sliders for each voice participant volume
        ├── SettingsModal.tsx    # User settings, microphone selection, theme toggle, profile
        ├── ServerSettingsModal.ts # Server management, role assignment, channel creation
        ├── CreateServerModal.tsx# New server wizard
        └── NewDmModal.tsx       # Direct message creation & friend selector
```

---

## 2. Core State & Data Flow (`App.tsx`)

`App.tsx` is the central orchestrator. It manages:
- **Active Navigation State**:
  - `activeServer: Server | null` (null when viewing DMs or Discovery)
  - `activeChannel: Channel | null` (current text, voice, or DM channel)
  - `activeVoiceChannel: Channel | null` (voice room if user has joined one)
  - `activeConversationKind: 'channel' | 'dm' | null`
- **Messages State**:
  - `messages: Message[]` (bounded active window, chronologically sorted)
  - `messagesPage: number` (current pagination offset)
  - `hasMoreMessages: boolean` (indicates older history exists on server)
  - `isLoadingMore: boolean` (guard against concurrent pagination queries)
  - `isInitialLoadingChannel: boolean` (initial load spinner state)
- **Cache References**:
  - `messagesCache: useRef<Record<string, CachedConversation>>` (in-memory L1 cache)
  - `channelsCache: useRef<Record<string, Channel[]>>` (channels per server)
  - `loadChannelsGenerationRef` & `loadMessagesGenerationRef` (race condition guards)

---

## 3. Storage & Caching Tiers

To balance instant load times (<50ms), browser storage quotas (<5MB in web localStorage), and offline resilience, Sirver uses a 3-tier caching model:

| Tier | Technology | Max Size / Cap | Contents | Lifecycle |
|---|---|---|---|---|
| **L1 (Memory)** | In-memory `Map` / `useRef` | ~100KB | Active server, channels, and newest 20 messages per touched conversation | Per browser tab lifetime |
| **L2 (Snapshot)** | `localStorage` | ~250KB max | Last active server ID, last channel ID, user profile, and newest 20 messages for the current conversation only | Synchronously read on first paint (`readSessionSnapshot`) |
| **L3 (IndexedDB)** | `SirverOfflineCacheDB` | ~20MB | Full message pages indexed by cursor, servers list, full channel lists | Async background read/write |

### Session Restoration on Startup:
1. `readSessionSnapshot()` runs **synchronously** in `useState(() => ...)` before the first paint:
   - Restores `activeServerId`, `activeChannelId`, and last 20 messages instantly (0ms blank screen).
   - If user was last in a DM, `activeServer` is `null` and `activeChannel` is restored as the DM.
2. `fetchServers()` and `loadChannels()` run in the background after first paint:
   - Revalidates server list against PocketBase without replacing or flickering the active view.
   - If the last active channel ID is still valid, it remains selected.

---

## 4. Message Pagination & Feed System

### Page Sizing Standards:
- `INITIAL_MESSAGE_PAGE_SIZE = 20`: The exact number of messages fetched when entering a channel.
- `OLDER_MESSAGE_PAGE_SIZE = 20`: The exact number of older messages fetched per pagination trigger (scrolling up or clicking "Load older messages").
- `MAX_ACTIVE_MESSAGES = 500`: Bounded ceiling on rendered DOM elements to prevent browser lag.

### Cursor Calculation:
- PocketBase pagination uses composite cursors: `{ created: string, id: string }`.
- **Oldest Cursor Rule**: Always calculate the oldest cursor from real persisted messages (`!m.id.startsWith('optimistic-') && !m.is_pending`).
- **No Message Dropping**: Messages MUST NOT be discarded during query mapping based on `has_attachment`. Non-deleted messages are ALWAYS rendered even if attachments are pending or expand fields differ.

### Scroll Retention (`ChatPanel.tsx`):
- When older messages arrive, `loadMoreScrollAnchorRef` records the relative offset of the first visible message before prepend.
- In `useLayoutEffect`, the scroll container's `scrollTop` is shifted by the exact rendered pixel height of the prepended messages, completely eliminating scroll jumps.

---

## 5. Voice & Video Architecture (`MediaContext.tsx`)

### Voice Lifecycle & Speed:
- **Instant UI Feedback**: When a voice channel is clicked, `setActiveRoom` and `setConnectionState('connecting')` update immediately. The voice stage renders right away with the connecting state, rather than showing a disconnected preview or delayed modal.
- **Fast Switching**: When switching from Voice Channel A to Voice Channel B:
  1. `MediaContext` maintains `isSwitching = true`.
  2. The UI immediately displays Channel B with `connectionState = 'connecting'`.
  3. Previous room teardown (`leaveRoom()`) is executed cleanly without resetting `activeRoom` to null or flickering the UI to 'disconnected'.
  4. WebRTC session connects to Channel B and updates to `'connected'`.
- **Participants**: Maximum 8 participants per voice channel. Union of `voicePresenceStore` and active WebRTC tracks.

---

## 6. PocketBase Collections & Schema

| Collection | Purpose | Key Fields |
|---|---|---|
| `users` | User accounts | `id`, `username`, `display_name`, `avatar`, `status`, `custom_status` |
| `servers` | Community servers | `id`, `name`, `icon`, `owner`, `members`, `description` |
| `channels` | Server channels | `id`, `server`, `name`, `type` (`text` \| `voice`), `topic` |
| `messages` | Server text chat | `id`, `channel`, `sender`, `content`, `has_attachment`, `reply_to`, `created` |
| `private_chat_servers` | 1:1 DM servers | `id`, `user1`, `user2` |
| `private_messages` | 1:1 DM text chat | `id`, `chat_server`, `sender`, `content`, `has_attachment`, `created` |
| `attachments` / `private_attachments` | Files & media | `id`, `message`, `file`, `file_type`, `file_size` |

---

## 7. Operational Guidelines for Future Turns

1. **Do not read the whole project**: Reference `APP_MAP.md` for components, state keys, and architecture before making surgical edits.
2. **Preserve page sizes**: Always enforce 20 messages for both initial and older pages.
3. **No unsolicited features**: Respect the user's explicit scope; avoid adding tabs or unrequested external services.
4. **Maintain theme tokens**: Follow `THEME_GUIDE.md` for Avocado Green `#7BAE37` and dark/light color tokens.
