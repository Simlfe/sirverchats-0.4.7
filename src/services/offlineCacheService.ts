import { Server, Channel, Message, ConversationKind, MessageCursor, MessagePage } from '../types';
import { MessageDeletionService } from './messageDeletionService';
import { compareMessageOrder, cursorKey, dedupeMessages, MAX_ACTIVE_MESSAGES } from './messagePagination';

const DB_NAME = 'SirverOfflineCacheDB';
const DB_VERSION = 2;

const STORES = {
  SERVERS: 'servers',
  CHANNELS: 'channels',
  DM_CHANNELS: 'dm_channels',
  MESSAGES: 'messages',
  MESSAGE_PAGES: 'message_pages',
  MESSAGE_METADATA: 'message_metadata',
  META: 'meta',
};

export interface MessageCacheMetadata {
  kind: ConversationKind;
  conversationId: string;
  newestCursor: MessageCursor | null;
  oldestCursor: MessageCursor | null;
  cachedPagesAvailable: number;
  remoteHasMore: boolean;
  updatedAt: number;
}

export interface CachedMessagePage {
  key: string;
  kind: ConversationKind;
  conversationId: string;
  cursor: MessageCursor | null;
  items: Message[];
  nextCursor: MessageCursor | null;
  hasMore: boolean;
  savedAt: number;
}

class OfflineCacheService {
  private dbPromise: Promise<IDBDatabase> | null = null;
  // High-speed Synchronous L1 In-Memory Cache for 0ms reads
  private memServers: Map<string, Server[]> = new Map();
  private memChannels: Map<string, Channel[]> = new Map();
  private memDmChannels: Map<string, Channel[]> = new Map();
  private memMessages: Map<string, { items: Message[]; hasMore: boolean; page: number; lastSyncTime: number }> = new Map();
  private memMessagePages: Map<string, CachedMessagePage> = new Map();
  private memMessageMetadata: Map<string, MessageCacheMetadata> = new Map();
  private fullyHydratedPageConversations: Set<string> = new Set();
  private messagePersistenceQueues: Map<string, Promise<void>> = new Map();

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.indexedDB) {
        reject(new Error('IndexedDB not available in this environment'));
        return;
      }

      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.SERVERS)) {
          db.createObjectStore(STORES.SERVERS, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORES.CHANNELS)) {
          db.createObjectStore(STORES.CHANNELS, { keyPath: 'serverId' });
        }
        if (!db.objectStoreNames.contains(STORES.DM_CHANNELS)) {
          db.createObjectStore(STORES.DM_CHANNELS, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORES.MESSAGES)) {
          db.createObjectStore(STORES.MESSAGES, { keyPath: 'channelId' });
        }
        const pages = db.objectStoreNames.contains(STORES.MESSAGE_PAGES)
          ? request.transaction?.objectStore(STORES.MESSAGE_PAGES)
          : db.createObjectStore(STORES.MESSAGE_PAGES, { keyPath: 'key' });
        // Existing installs may have the store from an earlier partial
        // rollout without the indexes. Add them during the version bump so
        // cached-page reveal remains reliable instead of silently falling
        // back to a network request on every scroll.
        if (pages && !pages.indexNames.contains('conversation')) {
          pages.createIndex('conversation', ['kind', 'conversationId'], { unique: false });
        }
        if (pages && !pages.indexNames.contains('savedAt')) {
          pages.createIndex('savedAt', 'savedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.MESSAGE_METADATA)) {
          db.createObjectStore(STORES.MESSAGE_METADATA, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORES.META)) {
          db.createObjectStore(STORES.META, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error);
      };
    });

    return this.dbPromise;
  }

  // --- SERVERS ---
  getServersSync(userId: string): Server[] | null {
    if (this.memServers.has(userId)) {
      return this.memServers.get(userId) || null;
    }
    try {
      const ls = localStorage.getItem(`offline_servers_${userId}`);
      if (ls) {
        const parsed = JSON.parse(ls);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.memServers.set(userId, parsed);
          return parsed;
        }
      }
    } catch (e) {}
    return null;
  }

  async getServers(userId: string): Promise<Server[] | null> {
    const syncRes = this.getServersSync(userId);
    if (syncRes && syncRes.length > 0) return syncRes;

    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORES.SERVERS, 'readonly');
        const store = tx.objectStore(STORES.SERVERS);
        const req = store.get(userId);
        req.onsuccess = () => {
          if (req.result && Array.isArray(req.result.servers)) {
            this.memServers.set(userId, req.result.servers);
            try {
              localStorage.setItem(`offline_servers_${userId}`, JSON.stringify(req.result.servers));
            } catch (e) {}
            resolve(req.result.servers);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      console.warn('Failed to get cached servers from IndexedDB:', e);
      return null;
    }
  }

  async saveServers(userId: string, servers: Server[]): Promise<void> {
    this.memServers.set(userId, servers);
    try {
      localStorage.setItem(`offline_servers_${userId}`, JSON.stringify(servers));
    } catch (e) {}

    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.SERVERS, 'readwrite');
        const store = tx.objectStore(STORES.SERVERS);
        const req = store.put({ userId, servers, timestamp: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('Failed to save servers to IndexedDB:', e);
    }
  }

  // --- CHANNELS ---
  getChannelsSync(serverId: string): Channel[] | null {
    if (this.memChannels.has(serverId)) {
      return this.memChannels.get(serverId) || null;
    }
    try {
      const ls = localStorage.getItem(`offline_channels_${serverId}`);
      if (ls) {
        const parsed = JSON.parse(ls);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.memChannels.set(serverId, parsed);
          return parsed;
        }
      }
    } catch (e) {}
    return null;
  }

  async getChannels(serverId: string): Promise<Channel[] | null> {
    const syncRes = this.getChannelsSync(serverId);
    if (syncRes && syncRes.length > 0) return syncRes;

    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORES.CHANNELS, 'readonly');
        const store = tx.objectStore(STORES.CHANNELS);
        const req = store.get(serverId);
        req.onsuccess = () => {
          if (req.result && Array.isArray(req.result.channels)) {
            this.memChannels.set(serverId, req.result.channels);
            try {
              localStorage.setItem(`offline_channels_${serverId}`, JSON.stringify(req.result.channels));
            } catch (e) {}
            resolve(req.result.channels);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      console.warn('Failed to get cached channels from IndexedDB:', e);
      return null;
    }
  }

  async saveChannels(serverId: string, channels: Channel[]): Promise<void> {
    this.memChannels.set(serverId, channels);
    try {
      localStorage.setItem(`offline_channels_${serverId}`, JSON.stringify(channels));
    } catch (e) {}

    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.CHANNELS, 'readwrite');
        const store = tx.objectStore(STORES.CHANNELS);
        const req = store.put({ serverId, channels, timestamp: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('Failed to save channels to IndexedDB:', e);
    }
  }

  // --- DM CHANNELS ---
  getDmChannelsSync(userId: string): Channel[] | null {
    if (this.memDmChannels.has(userId)) {
      return this.memDmChannels.get(userId) || null;
    }
    try {
      const ls = localStorage.getItem(`offline_dms_${userId}`);
      if (ls) {
        const parsed = JSON.parse(ls);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.memDmChannels.set(userId, parsed);
          return parsed;
        }
      }
    } catch (e) {}
    return null;
  }

  async getDmChannels(userId: string): Promise<Channel[] | null> {
    const syncRes = this.getDmChannelsSync(userId);
    if (syncRes && syncRes.length > 0) return syncRes;

    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORES.DM_CHANNELS, 'readonly');
        const store = tx.objectStore(STORES.DM_CHANNELS);
        const req = store.get(userId);
        req.onsuccess = () => {
          if (req.result && Array.isArray(req.result.channels)) {
            this.memDmChannels.set(userId, req.result.channels);
            try {
              localStorage.setItem(`offline_dms_${userId}`, JSON.stringify(req.result.channels));
            } catch (e) {}
            resolve(req.result.channels);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      console.warn('Failed to get cached DM channels from IndexedDB:', e);
      return null;
    }
  }

  async saveDmChannels(userId: string, channels: Channel[]): Promise<void> {
    this.memDmChannels.set(userId, channels);
    try {
      localStorage.setItem(`offline_dms_${userId}`, JSON.stringify(channels));
    } catch (e) {}

    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.DM_CHANNELS, 'readwrite');
        const store = tx.objectStore(STORES.DM_CHANNELS);
        const req = store.put({ userId, channels, timestamp: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('Failed to save DM channels to IndexedDB:', e);
    }
  }

  // --- CURSOR MESSAGE PAGES ---
  private messageMetadataKey(kind: ConversationKind, conversationId: string): string {
    return `${kind}:${conversationId}`;
  }

  private messagePageKey(kind: ConversationKind, conversationId: string, cursor: MessageCursor | null): string {
    return `${this.messageMetadataKey(kind, conversationId)}:${cursorKey(cursor)}`;
  }

  getMessageMetadataSync(kind: ConversationKind, conversationId: string): MessageCacheMetadata | null {
    return this.memMessageMetadata.get(this.messageMetadataKey(kind, conversationId)) || null;
  }

  async getMessageMetadata(kind: ConversationKind, conversationId: string): Promise<MessageCacheMetadata | null> {
    const sync = this.getMessageMetadataSync(kind, conversationId);
    if (sync) return sync;
    try {
      const db = await this.getDB();
      return await new Promise((resolve) => {
        const req = db.transaction(STORES.MESSAGE_METADATA, 'readonly')
          .objectStore(STORES.MESSAGE_METADATA)
          .get(this.messageMetadataKey(kind, conversationId));
        req.onsuccess = () => {
          const value = req.result as MessageCacheMetadata | undefined;
          if (value) this.memMessageMetadata.set(this.messageMetadataKey(kind, conversationId), value);
          resolve(value || null);
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async saveMessageMetadata(metadata: MessageCacheMetadata): Promise<void> {
    const key = this.messageMetadataKey(metadata.kind, metadata.conversationId);
    this.memMessageMetadata.set(key, metadata);
    try {
      const db = await this.getDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORES.MESSAGE_METADATA, 'readwrite');
        tx.objectStore(STORES.MESSAGE_METADATA).put({ ...metadata, key });
        // Request success only means the write was queued. Transaction
        // completion is the durable IndexedDB boundary.
        tx.oncomplete = () => resolve();
        tx.onabort = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      // IndexedDB is an enhancement; the in-memory cache remains usable.
    }
  }

  getMessagePageSync(kind: ConversationKind, conversationId: string, cursor: MessageCursor | null = null): CachedMessagePage | null {
    return this.memMessagePages.get(this.messagePageKey(kind, conversationId, cursor)) || null;
  }

  async getMessagePage(kind: ConversationKind, conversationId: string, cursor: MessageCursor | null = null): Promise<CachedMessagePage | null> {
    const key = this.messagePageKey(kind, conversationId, cursor);
    const sync = this.memMessagePages.get(key);
    if (sync) return sync;
    try {
      const db = await this.getDB();
      return await new Promise((resolve) => {
        const req = db.transaction(STORES.MESSAGE_PAGES, 'readonly').objectStore(STORES.MESSAGE_PAGES).get(key);
        req.onsuccess = () => {
          const value = req.result as CachedMessagePage | undefined;
          if (value) this.memMessagePages.set(key, value);
          resolve(value || null);
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  /**
   * Read the exact cached page that follows the visible oldest cursor. Pages
   * are keyed by their request cursor, so this remains O(1) as cached history
   * grows and avoids flattening/sorting every page on each scroll gesture.
   */
  async getNextOlderMessagePage(
    kind: ConversationKind,
    conversationId: string,
    before: MessageCursor | null,
  ): Promise<CachedMessagePage | null> {
    if (!before) return null;
    const exact = await this.getMessagePage(kind, conversationId, before);
    if (exact) return exact;

    // A realtime insertion can move a capped window's oldest row by one, so
    // its exact request cursor may no longer match a stored page key. This is
    // a compatibility fallback; the full page set is hydrated once and then
    // retained in memory, while ordinary pagination stays on the exact O(1)
    // lookup above.
    const pages = await this.listMessagePages(kind, conversationId);
    let closest: CachedMessagePage | null = null;
    let closestNewest: Message | null = null;
    for (const page of pages) {
      const olderItems = page.items
        .filter((message) => compareMessageOrder(message, before) < 0)
        .sort(compareMessageOrder);
      const newestOlder = olderItems[olderItems.length - 1];
      if (!newestOlder) continue;
      if (!closestNewest || compareMessageOrder(newestOlder, closestNewest) > 0) {
        closestNewest = newestOlder;
        closest = { ...page, items: olderItems };
      }
    }
    return closest;
  }

  async saveMessagePage(
    kind: ConversationKind,
    conversationId: string,
    page: MessagePage<Message>,
    cursor: MessageCursor | null = null,
  ): Promise<void> {
    const key = this.messagePageKey(kind, conversationId, cursor);
    const alreadyStored = this.memMessagePages.has(key);
    const record: CachedMessagePage = {
      key,
      kind,
      conversationId,
      cursor,
      items: dedupeMessages(page.items),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      savedAt: Date.now(),
    };
    this.memMessagePages.set(key, record);

    const previous = this.getMessageMetadataSync(kind, conversationId);
    const nextMetadata: MessageCacheMetadata = {
      kind,
      conversationId,
      newestCursor: previous?.newestCursor || (record.items.length ? { created: record.items[record.items.length - 1].created || '', id: record.items[record.items.length - 1].id } : null),
      oldestCursor: record.nextCursor || previous?.oldestCursor || (record.items.length ? { created: record.items[0].created || '', id: record.items[0].id } : null),
      cachedPagesAvailable: Math.max(1, (previous?.cachedPagesAvailable || 0) + (alreadyStored ? 0 : 1)),
      // This method is called only after a successful page response. A valid
      // empty final page is authoritative and must stop retry loops.
      remoteHasMore: page.hasMore,
      updatedAt: Date.now(),
    };
    this.memMessageMetadata.set(this.messageMetadataKey(kind, conversationId), nextMetadata);
    try {
      const db = await this.getDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(
          [STORES.MESSAGE_PAGES, STORES.MESSAGE_METADATA],
          'readwrite',
        );
        tx.objectStore(STORES.MESSAGE_PAGES).put(record);
        tx.objectStore(STORES.MESSAGE_METADATA).put({
          ...nextMetadata,
          key: this.messageMetadataKey(kind, conversationId),
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      // IndexedDB is an enhancement; the in-memory cache remains usable.
    }
  }

  /**
   * Persist a successful page after React and the memory cache have already
   * been updated. Writes are serialized per conversation so rapid refresh and
   * pagination results cannot commit metadata out of order.
   */
  enqueueMessagePersistence(
    kind: ConversationKind,
    conversationId: string,
    page: MessagePage<Message>,
    cursor: MessageCursor | null,
    pageNumber: number,
  ): void {
    const queueKey = this.messageMetadataKey(kind, conversationId);
    const previous = this.messagePersistenceQueues.get(queueKey) || Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        await this.mergeChannelMessages(
          conversationId,
          page.items,
          page.hasMore,
          pageNumber,
        );
        await this.saveMessagePage(kind, conversationId, page, cursor);
      })
      .catch((error) => {
        console.warn(`Failed to persist cached ${kind} message page:`, error);
      })
      .finally(() => {
        if (this.messagePersistenceQueues.get(queueKey) === task) {
          this.messagePersistenceQueues.delete(queueKey);
        }
      });
    this.messagePersistenceQueues.set(queueKey, task);
  }

  async listMessagePages(kind: ConversationKind, conversationId: string): Promise<CachedMessagePage[]> {
    const prefix = `${this.messageMetadataKey(kind, conversationId)}:`;
    const fromMemory = Array.from(this.memMessagePages.values()).filter((page) => page.key.startsWith(prefix));
    const hydrationKey = this.messageMetadataKey(kind, conversationId);
    if (this.fullyHydratedPageConversations.has(hydrationKey)) {
      return fromMemory.sort((a, b) => a.savedAt - b.savedAt);
    }
    try {
      const db = await this.getDB();
      return await new Promise((resolve) => {
        const req = db.transaction(STORES.MESSAGE_PAGES, 'readonly').objectStore(STORES.MESSAGE_PAGES)
          .index('conversation').getAll(IDBKeyRange.only([kind, conversationId]));
        req.onsuccess = () => {
          const rows = (req.result || []) as CachedMessagePage[];
          rows.forEach((row) => this.memMessagePages.set(row.key, row));
          this.fullyHydratedPageConversations.add(hydrationKey);
          const complete = Array.from(this.memMessagePages.values())
            .filter((page) => page.key.startsWith(prefix))
            .sort((a, b) => a.savedAt - b.savedAt);
          resolve(complete);
        };
        req.onerror = () => resolve([]);
      });
    } catch {
      return [];
    }
  }

  // --- MESSAGES ---
  getCachedMessagesSync(channelId: string): {
    items: Message[];
    hasMore: boolean;
    page: number;
    lastSyncTime: number;
  } | null {
    return this.memMessages.get(channelId) || null;
  }

  async getCachedMessages(channelId: string): Promise<{
    items: Message[];
    hasMore: boolean;
    page: number;
    lastSyncTime: number;
  } | null> {
    const syncRes = this.getCachedMessagesSync(channelId);
    if (syncRes && syncRes.items && syncRes.items.length > 0) return syncRes;

    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORES.MESSAGES, 'readonly');
        const store = tx.objectStore(STORES.MESSAGES);
        const req = store.get(channelId);
        req.onsuccess = () => {
          if (req.result && Array.isArray(req.result.items)) {
            const data = {
              // Legacy aggregate rows are only an acceleration cache. Keep
              // their in-memory/row payload bounded; full history lives in
              // the cursor-keyed MESSAGE_PAGES store.
              items: dedupeMessages(req.result.items, MAX_ACTIVE_MESSAGES),
              hasMore: Boolean(req.result.hasMore),
              page: req.result.page || 1,
              lastSyncTime: req.result.lastSyncTime || 0,
            };
            this.memMessages.set(channelId, data);
            resolve(data);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      console.warn('Failed to get cached messages from IndexedDB:', e);
      return null;
    }
  }

  async saveCachedMessages(
    channelId: string,
    messages: Message[],
    hasMore: boolean = true,
    page: number = 1
  ): Promise<void> {
    const data = {
      // Never let the compatibility aggregate cache grow with every scroll.
      // This does not evict cursor pages from IndexedDB, so remote history is
      // still available for later reveal.
      items: dedupeMessages(messages, MAX_ACTIVE_MESSAGES),
      hasMore,
      page,
      lastSyncTime: Date.now(),
    };
    this.memMessages.set(channelId, data);

    // Persist to IndexedDB asynchronously in the background without blocking the UI
    try {
      this.getDB().then((db) => {
        const tx = db.transaction(STORES.MESSAGES, 'readwrite');
        const store = tx.objectStore(STORES.MESSAGES);
        store.put({
          channelId,
          items: dedupeMessages(messages, MAX_ACTIVE_MESSAGES),
          hasMore,
          page,
          lastSyncTime: Date.now(),
        });
      }).catch((e) => {
        console.warn('Failed to save cached messages to IndexedDB:', e);
      });
    } catch (e) {}
  }

  mergeChannelMessagesSync(
    channelId: string,
    incoming: Message[],
    hasMore?: boolean,
    page?: number,
    deletedMessageIds?: string[]
  ): { items: Message[]; hasMore: boolean; page: number; lastSyncTime: number } {
    const cached = this.getCachedMessagesSync(channelId) || {
      items: [],
      hasMore: true,
      page: 1,
      lastSyncTime: 0,
    };

    let existingMap = new Map<string, Message>();
    for (const m of cached.items) {
      if (!m.deleted && !m.deleted_at && !MessageDeletionService.isMessageDeleted(m.id)) {
        existingMap.set(m.id, m);
      }
    }

    // Remove deleted messages if provided
    if (deletedMessageIds && deletedMessageIds.length > 0) {
      for (const delId of deletedMessageIds) {
        existingMap.delete(delId);
      }
    }

    // Insert or update incoming items
    const realMsgSignatures = new Set<string>();
    for (const item of incoming) {
      if (item.deleted || item.deleted_at || MessageDeletionService.isMessageDeleted(item.id)) {
        existingMap.delete(item.id);
      } else {
        existingMap.set(item.id, item);
        if (!item.id.startsWith('optimistic-') && !(item as any).is_pending) {
          const sId = item.sender || (item as any).user_id || item.expand?.sender?.id;
          if (sId && item.content) {
            realMsgSignatures.add(`${sId}_${item.content.trim()}`);
          }
        }
      }
    }

    // Prune stale optimistic messages that are now fulfilled by real messages
    for (const [id, m] of existingMap.entries()) {
      if (id.startsWith('optimistic-') || (m as any).is_pending) {
        const sId = m.sender || (m as any).user_id || m.expand?.sender?.id;
        const sig = sId && m.content ? `${sId}_${m.content.trim()}` : null;
        if (sig && realMsgSignatures.has(sig)) {
          existingMap.delete(id);
        }
      }
    }

    // Sort strictly by created timestamp ascending
    const mergedList = dedupeMessages(Array.from(existingMap.values()));

    const finalHasMore = hasMore !== undefined ? hasMore : cached.hasMore;
    const finalPage = page !== undefined ? Math.max(page, cached.page) : cached.page;

    this.saveCachedMessages(channelId, mergedList, finalHasMore, finalPage);

    return {
      items: mergedList,
      hasMore: finalHasMore,
      page: finalPage,
      lastSyncTime: Date.now(),
    };
  }

  async mergeChannelMessages(
    channelId: string,
    incoming: Message[],
    hasMore?: boolean,
    page?: number,
    deletedMessageIds?: string[]
  ): Promise<{ items: Message[]; hasMore: boolean; page: number; lastSyncTime: number }> {
    const memRes = this.getCachedMessagesSync(channelId);
    if (memRes) {
      return this.mergeChannelMessagesSync(channelId, incoming, hasMore, page, deletedMessageIds);
    }

    const cached = (await this.getCachedMessages(channelId)) || {
      items: [],
      hasMore: true,
      page: 1,
      lastSyncTime: 0,
    };

    let existingMap = new Map<string, Message>();
    for (const m of cached.items) {
      if (!m.deleted && !m.deleted_at && !MessageDeletionService.isMessageDeleted(m.id)) {
        existingMap.set(m.id, m);
      }
    }

    if (deletedMessageIds && deletedMessageIds.length > 0) {
      for (const delId of deletedMessageIds) {
        existingMap.delete(delId);
      }
    }

    const realMsgSignatures = new Set<string>();
    for (const item of incoming) {
      if (item.deleted || item.deleted_at || MessageDeletionService.isMessageDeleted(item.id)) {
        existingMap.delete(item.id);
      } else {
        existingMap.set(item.id, item);
        if (!item.id.startsWith('optimistic-') && !(item as any).is_pending) {
          const sId = item.sender || (item as any).user_id || item.expand?.sender?.id;
          if (sId && item.content) {
            realMsgSignatures.add(`${sId}_${item.content.trim()}`);
          }
        }
      }
    }

    for (const [id, m] of existingMap.entries()) {
      if (id.startsWith('optimistic-') || (m as any).is_pending) {
        const sId = m.sender || (m as any).user_id || m.expand?.sender?.id;
        const sig = sId && m.content ? `${sId}_${m.content.trim()}` : null;
        if (sig && realMsgSignatures.has(sig)) {
          existingMap.delete(id);
        }
      }
    }

    const mergedList = dedupeMessages(Array.from(existingMap.values()));

    const finalHasMore = hasMore !== undefined ? hasMore : cached.hasMore;
    const finalPage = page !== undefined ? Math.max(page, cached.page) : cached.page;

    this.saveCachedMessages(channelId, mergedList, finalHasMore, finalPage);

    return {
      items: mergedList,
      hasMore: finalHasMore,
      page: finalPage,
      lastSyncTime: Date.now(),
    };
  }

  // Prunes active UI messages when at bottom so DOM isn't overloaded with 500+ cards
  pruneActiveMessages(messages: Message[], keepCount: number = 60): Message[] {
    if (messages.length <= keepCount) {
      return messages;
    }
    // Return the latest keepCount messages
    return messages.slice(messages.length - keepCount);
  }

  // --- META & CLEAR CACHE ---
  async setMeta(key: string, value: any): Promise<void> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.META, 'readwrite');
        const store = tx.objectStore(STORES.META);
        const req = store.put({ key, value, timestamp: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('Failed to set meta in IndexedDB:', e);
    }
  }

  async getMeta(key: string): Promise<any | null> {
    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORES.META, 'readonly');
        const store = tx.objectStore(STORES.META);
        const req = store.get(key);
        req.onsuccess = () => {
          resolve(req.result ? req.result.value : null);
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async clearUserCache(): Promise<void> {
    try {
      const db = await this.getDB();
      const stores = [
        STORES.SERVERS,
        STORES.CHANNELS,
        STORES.DM_CHANNELS,
        STORES.MESSAGES,
        STORES.MESSAGE_PAGES,
        STORES.MESSAGE_METADATA,
        STORES.META,
      ];
      const tx = db.transaction(stores, 'readwrite');
      stores.forEach((s) => tx.objectStore(s).clear());
      this.memServers.clear();
      this.memChannels.clear();
      this.memDmChannels.clear();
      this.memMessages.clear();
      this.memMessagePages.clear();
      this.memMessageMetadata.clear();
      this.fullyHydratedPageConversations.clear();
      this.messagePersistenceQueues.clear();
    } catch (e) {
      console.warn('Failed to clear user cache in IndexedDB:', e);
    }
  }
}

export const offlineCacheService = new OfflineCacheService();
