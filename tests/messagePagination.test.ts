import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOlderMessageFilter,
  cursorFromMessage,
  dedupeMessages,
  didMessageWindowMoveOlder,
  mergeMessagePage,
  mergeOlderMessagePage,
  normalizeMessagePage,
  paginateMessages,
  revealCachedMessages,
} from '../src/services/messagePagination';
import type { Message } from '../src/types';

function message(id: string, created: string, content = id): Message {
  return { id, created, content, sender: 'user-1', channel: 'channel-1' };
}

test('cursor filter includes the id tie-breaker for equal timestamps', () => {
  const cursor = { created: '2026-01-01T00:00:00.000Z', id: 'm-2' };
  const filter = buildOlderMessageFilter('channel = "channel-1"', cursor);
  assert.match(filter, /created < "2026-01-01 00:00:00\.000Z"/);
  assert.match(filter, /created = "2026-01-01 00:00:00\.000Z" && id < "m-2"/);
});

test('equal-timestamp pages contain every message exactly once', () => {
  const created = '2026-01-01T00:00:00.000Z';
  const newest = normalizeMessagePage(
    [message('m-4', created), message('m-3', created), message('m-2', created)],
    true,
  );
  const older = normalizeMessagePage(
    [message('m-2', created), message('m-1', created)],
    false,
  );
  const merged = mergeMessagePage(newest.items, older.items);
  assert.deepEqual(merged.map((item) => item.id), ['m-1', 'm-2', 'm-3', 'm-4']);
  assert.equal(new Set(merged.map((item) => item.id)).size, 4);
  assert.deepEqual(cursorFromMessage(merged[0]), { created, id: 'm-1' });
});

test('dedupe keeps the confirmed message over an optimistic echo', () => {
  const created = '2026-01-01T00:00:00.000Z';
  const optimistic = { ...message('optimistic-1', created, 'hello'), is_pending: true };
  const confirmed = message('m-5', created, 'hello');
  const result = dedupeMessages([optimistic, confirmed]);
  assert.deepEqual(result.map((item) => item.id), ['m-5']);
});

test('dedupe accepts refreshed metadata for the same attachment count', () => {
  const created = '2026-01-01T00:00:00.000Z';
  const previous = {
    ...message('m-5', created),
    attachments: [{ id: 'a-1', file: 'photo.jpg', thumbnail: 'old.webp' }],
  } as Message;
  const refreshed = {
    ...message('m-5', created),
    attachments: [{ id: 'a-1', file: 'photo.jpg', thumbnail: 'new.webp' }],
  } as Message;
  const result = dedupeMessages([previous, refreshed]);
  assert.equal((result[0].attachments?.[0] as any).thumbnail, 'new.webp');
});

test('repeated cursor pages walk a 1,000-message history exactly once', () => {
  const created = '2026-01-01T00:00:00.000Z';
  const all = Array.from({ length: 1000 }, (_, index) => message(`m-${String(index).padStart(4, '0')}`, created));
  let seen: Message[] = [];
  let cursor = null as { created: string; id: string } | null;
  let hasMore = true;
  while (hasMore) {
    const page = paginateMessages(all, cursor, 50);
    // Older pages are prepended to the chronological feed.
    seen = [...page.items, ...seen];
    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }
  assert.equal(seen.length, 1000);
  assert.equal(new Set(seen.map((item) => item.id)).size, 1000);
  assert.deepEqual(seen.map((item) => item.id), all.map((item) => item.id));
});

test('cached pages remain revealable after remote history is exhausted', () => {
  const cached = Array.from({ length: 120 }, (_, index) => message(`m-${index}`, new Date(2026, 0, 1, 0, 0, index).toISOString()));
  const first = cached.slice(-30);
  const revealed = revealCachedMessages(first, cached, 50, false);
  assert.equal(revealed.items.length, 80);
  assert.equal(revealed.hasMore, true);
  const final = revealCachedMessages(revealed.items, cached, 50, false);
  assert.equal(final.items.length, 120);
  assert.equal(final.hasMore, false);
});

test('a capped 500-message window detects older movement without a length increase', () => {
  const all = Array.from({ length: 1000 }, (_, index) =>
    message(
      `m-${String(index).padStart(4, '0')}`,
      new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ),
  );
  const visible = all.slice(500, 1000);
  const moved = mergeOlderMessagePage(visible, all.slice(450, 500), 500);

  assert.equal(visible.length, 500);
  assert.equal(moved.length, 500);
  assert.equal(visible[0].id, 'm-0500');
  assert.equal(moved[0].id, 'm-0450');
  assert.equal(didMessageWindowMoveOlder(visible, moved), true);
  assert.equal(didMessageWindowMoveOlder(moved, mergeOlderMessagePage(moved, all.slice(450, 500), 500)), false);
});
