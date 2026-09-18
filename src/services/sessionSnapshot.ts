import { Channel, Message, Server, User } from '../types';

const SNAPSHOT_KEY = 'sirver_last_session_v1';
const MAX_SNAPSHOT_BYTES = 250_000;

export interface SessionSnapshot {
  version: 1;
  savedAt: number;
  user: User | null;
  servers: Server[];
  channelsByServer: Record<string, Channel[]>;
  dms: Channel[];
  activeServerId: string | null;
  activeChannelId: string | null;
  activeConversationKind: 'channel' | 'dm' | null;
  newestMessages: Record<string, Message[]>;
  drafts: Record<string, string>;
  scrollPositions: Record<string, number>;
}

const EMPTY_SNAPSHOT: SessionSnapshot = {
  version: 1,
  savedAt: 0,
  user: null,
  servers: [],
  channelsByServer: {},
  dms: [],
  activeServerId: null,
  activeChannelId: null,
  activeConversationKind: null,
  newestMessages: {},
  drafts: {},
  scrollPositions: {},
};

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readSessionSnapshot(): SessionSnapshot | null {
  if (!storageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!raw || raw.length > MAX_SNAPSHOT_BYTES) return null;
    const parsed = JSON.parse(raw) as Partial<SessionSnapshot>;
    if (!parsed || parsed.version !== 1) return null;
    return {
      ...EMPTY_SNAPSHOT,
      ...parsed,
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      channelsByServer: parsed.channelsByServer && typeof parsed.channelsByServer === 'object' ? parsed.channelsByServer : {},
      dms: Array.isArray(parsed.dms) ? parsed.dms : [],
      newestMessages: parsed.newestMessages && typeof parsed.newestMessages === 'object' ? parsed.newestMessages : {},
      drafts: parsed.drafts && typeof parsed.drafts === 'object' ? parsed.drafts : {},
      scrollPositions: parsed.scrollPositions && typeof parsed.scrollPositions === 'object' ? parsed.scrollPositions : {},
    };
  } catch {
    return null;
  }
}

export function writeSessionSnapshot(update: Partial<SessionSnapshot>): void {
  if (!storageAvailable()) return;
  try {
    const previous = readSessionSnapshot() || { ...EMPTY_SNAPSHOT };
    const next: SessionSnapshot = {
      ...previous,
      ...update,
      channelsByServer: { ...previous.channelsByServer, ...(update.channelsByServer || {}) },
      newestMessages: { ...previous.newestMessages, ...(update.newestMessages || {}) },
      drafts: { ...previous.drafts, ...(update.drafts || {}) },
      scrollPositions: { ...previous.scrollPositions, ...(update.scrollPositions || {}) },
      version: 1,
      savedAt: Date.now(),
    };
    // Keep the synchronous startup payload intentionally small. Full history is
    // stored in IndexedDB; this snapshot only contains the newest 20 messages
    // for the 2 most recently active conversations.
    const entries = Object.entries(next.newestMessages)
      .map(([id, messages]) => [id, Array.isArray(messages) ? messages.slice(-20) : []] as const)
      .filter(([, messages]) => messages.length > 0)
      .slice(-2);
    next.newestMessages = Object.fromEntries(entries);
    const serialized = JSON.stringify(next);
    if (serialized.length <= MAX_SNAPSHOT_BYTES) {
      window.localStorage.setItem(SNAPSHOT_KEY, serialized);
    }
  } catch {
    // Storage is an optional acceleration layer and may be disabled/full.
  }
}

export function clearSessionSnapshot(): void {
  if (!storageAvailable()) return;
  try {
    window.localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function getSessionSnapshotKey(): string {
  return SNAPSHOT_KEY;
}
